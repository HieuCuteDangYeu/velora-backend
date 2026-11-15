#!/usr/bin/env bash
# Rolls friend-service, mail-service and the media-processing workers on velora-node-2 to
# the images the Homelab CD built for one commit. Installed as /usr/local/sbin/velora-friend-mail-deploy and
# used as the SSH forced command of the velora-deploy user, so the only things the CD
# key can do are:
#   deploy <40-hex commit sha>   pull <user>/<service>:<sha>-amd64 and recreate what changed
#   status                       print the running tags
# It never reads a path, image name or command from the caller.
set -Eeuo pipefail

STACK_DIR="${VELORA_STACK_DIR:-/opt/velora/friend-mail}"
HEALTH_TIMEOUT="${VELORA_HEALTH_TIMEOUT:-90}"
STABLE_SECONDS="${VELORA_STABLE_SECONDS:-10}"
READY_PATTERN='Nest microservice successfully started'
# One image per entry; a service name can differ from its container (see containers_of).
SERVICES=(friend-service mail-service media-processing-service)
RELEASE_ENV="$STACK_DIR/release.env"

log() { printf '%s %s\n' "$(date -u +%FT%TZ)" "$*"; }
die() { log "ERROR: $*" >&2; exit 1; }

containers_of() {
  case "$1" in
    media-processing-service) printf '%s\n' media-processing-long-service ;; # image runs as the LONG lane only
    *) printf '%s\n' "$1" ;;
  esac
}

tag_var() { local v="${1^^}_TAG"; printf '%s' "${v//-/_}"; }

read_release() {
  [[ -f "$RELEASE_ENV" ]] || die "$RELEASE_ENV is missing"
  # shellcheck disable=SC1090
  source "$RELEASE_ENV"
  [[ "${DOCKERHUB_USERNAME:-}" =~ ^[A-Za-z0-9._-]+$ ]] || die "DOCKERHUB_USERNAME is not set in release.env"
}

write_release() { # write_release <service> <tag>
  local var tmp
  var="$(tag_var "$1")"
  tmp="$(mktemp "$STACK_DIR/.release.env.XXXXXX")"
  grep -v "^${var}=" "$RELEASE_ENV" >"$tmp" || true
  printf '%s=%s\n' "$var" "$2" >>"$tmp"
  chmod 640 "$tmp"
  mv -f "$tmp" "$RELEASE_ENV"
}

compose() { docker compose --env-file "$RELEASE_ENV" -f "$STACK_DIR/compose.yaml" "$@"; }

running_image_id() { docker inspect --format '{{.Image}}' "$1" 2>/dev/null || true; }

# Every container of the service already runs image id $2.
all_on_image() { # all_on_image <service> <image id>
  local c
  while read -r c; do [[ "$(running_image_id "$c")" == "$2" ]] || return 1; done < <(containers_of "$1")
}

recreate() { # recreate <service>
  local c
  while read -r c; do compose up -d --no-deps --no-build "$c" >/dev/null; done < <(containers_of "$1")
}

all_healthy() { # all_healthy <service>
  local c
  while read -r c; do wait_healthy "$c" || return 1; done < <(containers_of "$1")
}

wait_healthy() { # wait_healthy <container>
  local c="$1" deadline=$((SECONDS + HEALTH_TIMEOUT)) state
  while ((SECONDS < deadline)); do
    state="$(docker inspect --format '{{.State.Running}} {{.RestartCount}}' "$c" 2>/dev/null || echo 'false 0')"
    if [[ "$state" == "true 0" ]] && docker logs "$c" 2>&1 | grep -q "$READY_PATTERN"; then
      sleep "$STABLE_SECONDS"
      state="$(docker inspect --format '{{.State.Running}} {{.RestartCount}}' "$c" 2>/dev/null || echo 'false 0')"
      [[ "$state" == "true 0" ]] && return 0
    fi
    sleep 2
  done
  return 1
}

prune_images() { # prune_images <service> <keep-tag> <keep-tag>
  local service="$1" repo tag
  repo="$DOCKERHUB_USERNAME/$service"
  while read -r tag; do
    [[ -n "$tag" && "$tag" != "<none>" && "$tag" != "$2" && "$tag" != "$3" ]] || continue
    docker rmi "$repo:$tag" >/dev/null 2>&1 || true
  done < <(docker image ls "$repo" --format '{{.Tag}}')
}

cmd="${SSH_ORIGINAL_COMMAND:-$*}"
case "$cmd" in
  status)
    read_release
    for s in "${SERVICES[@]}"; do
      var="$(tag_var "$s")"
      printf '%s tag=%s image=%s\n' "$s" "${!var:-}" "$(running_image_id "$(containers_of "$s" | head -n1)")"
    done
    exit 0
    ;;
  deploy\ *) ;;
  *) die "usage: deploy <40-hex sha> | status" ;;
esac

sha="${cmd#deploy }"
[[ "$sha" =~ ^[0-9a-f]{40}$ ]] || die "invalid commit sha"

exec 9>"$STACK_DIR/.deploy.lock"
flock -w 600 9 || die "another deploy is running"

read_release
new_tag="${sha}-amd64"
failed=0
for service in "${SERVICES[@]}"; do
  var="$(tag_var "$service")"
  current_tag="${!var:-}"
  image="$DOCKERHUB_USERNAME/$service:$new_tag"

  docker image inspect "$image" >/dev/null 2>&1 || docker pull --quiet "$image" >/dev/null \
    || { log "ERROR: cannot pull $image" >&2; failed=1; continue; }

  new_id="$(docker image inspect --format '{{.Id}}' "$image")"
  if all_on_image "$service" "$new_id"; then
    log "$service: image unchanged, keeping tag $current_tag"
    continue
  fi

  log "$service: $current_tag -> $new_tag"
  write_release "$service" "$new_tag"
  recreate "$service"
  if all_healthy "$service"; then
    log "$service: healthy on $new_tag"
    prune_images "$service" "$new_tag" "$current_tag"
  else
    log "ERROR: $service did not become healthy; rolling back to $current_tag" >&2
    containers_of "$service" | while read -r c; do docker logs --tail 20 "$c" >&2 || true; done
    write_release "$service" "$current_tag"
    recreate "$service" || true
    all_healthy "$service" && log "$service: rolled back to $current_tag" || log "ERROR: rollback of $service is not healthy" >&2
    failed=1
  fi
done
exit "$failed"
