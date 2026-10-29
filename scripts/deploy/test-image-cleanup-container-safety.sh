#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
tmp_dir="$(mktemp -d)"
trap 'rm -rf "$tmp_dir"' EXIT

mkdir -p "$tmp_dir/home" "$tmp_dir/bin" "$tmp_dir/state/blocked" "$tmp_dir/app"
export VELORA_APP_DIR="$tmp_dir/app" VELORA_STATE_DIR="$tmp_dir/state"
export DOCKER_CALLS="$tmp_dir/docker-calls"

cat >"$tmp_dir/bin/docker" <<'MOCK'
#!/usr/bin/env bash
set -euo pipefail
printf '%s\n' "$*" >>"$DOCKER_CALLS"
case "$*" in
  'ps -a --no-trunc --format {{.Image}}')
    [[ "${BROKEN_DOCKER_PS:-false}" != true ]] || exit 1
    printf '%s\n' testuser/api-gateway:running testuser/api-gateway:stopped nginx:alpine 'tei:cpu@sha256:pinned'
    ;;
  'compose ps -aq '*)
    [[ "${MISSING_CURRENT_CONTAINER:-false}" != true ]] || exit 0
    printf 'container-%s\n' "${@: -1}"
    ;;
  'inspect --format {{.Image}} '*)
    printf 'sha256:current-%s\n' "${@: -1}"
    ;;
  'inspect --format {{.Config.Image}} '*)
    printf 'testuser/api-gateway:%s\n' "${CURRENT_IMAGE_SHA:-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa}"
    ;;
  'image tag '*) ;;
  'image rm '*)
    if [[ "${ASSERT_ROTATION_ORDER:-false}" == true \
      && "${@: -1}" == velora-rollback/api-gateway:previous ]]; then
      jq -e --arg expected "velora-rollback/api-gateway:${ASSERT_ROTATION_SUFFIX:-preflight-rotation-test}" \
        '.services["api-gateway"] == $expected' \
        "$PREVIOUS_RELEASE_FILE" >/dev/null || exit 1
    fi
    ;;
  'image prune -f')
    if [[ "${DISK_ROTATION_TEST:-false}" == true ]]; then
      prune_count="$(cat "$PRUNE_COUNT_FILE" 2>/dev/null || printf '0')"
      prune_count=$((prune_count + 1))
      printf '%s\n' "$prune_count" >"$PRUNE_COUNT_FILE"
      (( prune_count < 2 )) || : >"$DISK_FREED_MARKER"
    fi
    ;;
  'image inspect --format {{.Id}} '*)
    ref="${@: -1}"
    [[ "$ref" != *:missing && "$ref" != tei:cpu ]] || exit 1
    printf 'sha256:%s\n' "${ref##*:}"
    ;;
  'image ls testuser/api-gateway --format {{.Repository}}:{{.Tag}}')
    printf '%s\n' testuser/api-gateway:latest testuser/api-gateway:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa testuser/api-gateway:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb
    ;;
  'image ls --filter reference=velora-rollback/* --format {{.Repository}}:{{.Tag}}')
    printf 'velora-rollback/api-gateway:%s\n' emergency inflight interrupted orphan stopped preflight-rotation-test preflight-preflight-test
    ;;
  'inspect '*) exit 97 ;;
esac
MOCK
cat >"$tmp_dir/bin/git" <<'MOCK'
#!/usr/bin/env bash
printf 'runtime-sha\n'
MOCK
chmod +x "$tmp_dir/bin/"*
export PATH="$tmp_dir/bin:$PATH"

source "$repo_root/scripts/deploy/velora-deploy-core"
read_env_value() { printf 'testuser\n'; }
TARGET_SHA=bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb
TEMP_SNAPSHOT="$STATE_DIR/inflight.json"
printf '%s\n' '{"services":{"api-gateway":"velora-rollback/api-gateway:previous"}}' >"$PREVIOUS_RELEASE_FILE"
printf '%s\n' '{"services":{"api-gateway":"velora-rollback/api-gateway:emergency"}}' >"$BLOCKED_DIR/failed.rollback.json"
printf '%s\n' '{"services":{}}' >"$BLOCKED_DIR/empty.rollback.json"
printf '%s\n' '{"services":{"api-gateway":"velora-rollback/api-gateway:inflight"}}' >"$TEMP_SNAPSHOT"
printf '%s\n' '{"to_sha":"runtime-sha","services":{"api-gateway":"velora-rollback/api-gateway:interrupted"}}' >"$STATE_DIR/.rollback-live.json"
printf '%s\n' '{"to_sha":"old-sha","services":{"api-gateway":"velora-rollback/api-gateway:orphan"}}' >"$STATE_DIR/.rollback-old.json"

reclaim_unused_docker_images true
for ref in testuser/api-gateway:latest testuser/api-gateway:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa velora-rollback/api-gateway:orphan; do
  grep -Fxq "image rm $ref" "$DOCKER_CALLS"
done
for tag in running stopped previous emergency inflight interrupted bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb; do
  if grep -Eq "^image rm .*:$tag$" "$DOCKER_CALLS"; then
    printf 'protected image was removed: %s\n' "$tag" >&2
    exit 1
  fi
done
grep -Fxq 'image prune -f' "$DOCKER_CALLS"
if grep -Eq '^inspect |^image rm .*nginx|^image rm -f|^system prune|^volume ' "$DOCKER_CALLS"; then
  printf 'cleanup used a forbidden Docker operation\n' >&2
  exit 1
fi

: >"$DOCKER_CALLS"
cleanup_unused_velora_application_sha_tags false
grep -Fxq "image rm testuser/api-gateway:$TARGET_SHA" "$DOCKER_CALLS"

# Low disk first refreshes the rollback snapshot, then safely reclaims the old SHA.
: >"$DOCKER_CALLS"
TARGET_SHA=bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb
LAST_DEPLOYED_SHA=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa
DB_RISK=false
DRY_RUN=false
DEPLOY_ID=preflight-test
RECONCILE_SERVICES=(api-gateway)
INFRA_RECONCILE_SERVICES=()
printf '%s\n' '{"from_sha":"older-sha","to_sha":"running-sha","services":{"api-gateway":"velora-rollback/api-gateway:previous"}}' >"$PREVIOUS_RELEASE_FILE"
PRUNE_COUNT_FILE="$tmp_dir/preflight-prune-count"
DISK_FREED_MARKER="$tmp_dir/preflight-disk-freed"
rm -f -- "$PRUNE_COUNT_FILE" "$DISK_FREED_MARKER"
DISK_ROTATION_TEST=true
export DISK_ROTATION_TEST PRUNE_COUNT_FILE DISK_FREED_MARKER
export ASSERT_ROTATION_ORDER=true ASSERT_ROTATION_SUFFIX=preflight-preflight-test
free_root_gb() { [[ -f "$DISK_FREED_MARKER" ]] && printf '14\n' || printf '11\n'; }
available_ram_mb() { printf '2048\n'; }
preflight_resources
unset DISK_ROTATION_TEST PRUNE_COUNT_FILE DISK_FREED_MARKER ASSERT_ROTATION_ORDER ASSERT_ROTATION_SUFFIX
jq -e '.from_sha == "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" and .services["api-gateway"] == "velora-rollback/api-gateway:preflight-preflight-test"' \
  "$PREVIOUS_RELEASE_FILE" >/dev/null
grep -Fxq 'image tag sha256:current-container-api-gateway velora-rollback/api-gateway:preflight-preflight-test' "$DOCKER_CALLS"
if grep -Fxq 'builder prune -af' "$DOCKER_CALLS"; then
  printf 'rollback cleanup did not restore the configured disk headroom\n' >&2
  exit 1
fi

# Mixed live tags must preserve the old rollback snapshot.
: >"$DOCKER_CALLS"
printf '%s\n' '{"from_sha":"older-sha","to_sha":"running-sha","services":{"api-gateway":"velora-rollback/api-gateway:previous"}}' >"$PREVIOUS_RELEASE_FILE"
export CURRENT_IMAGE_SHA=older-sha
if rotate_previous_release_snapshot_to_current; then
  printf 'mixed running release tags were accepted for rollback rotation\n' >&2
  exit 1
fi
unset CURRENT_IMAGE_SHA
jq -e '.services["api-gateway"] == "velora-rollback/api-gateway:previous"' \
  "$PREVIOUS_RELEASE_FILE" >/dev/null
if grep -q '^image rm ' "$DOCKER_CALLS"; then
  printf 'mixed running release tags deleted the old rollback snapshot\n' >&2
  exit 1
fi

# If any current image is missing, retain the old snapshot and remove no images.
: >"$DOCKER_CALLS"
printf '%s\n' '{"from_sha":"older-sha","to_sha":"running-sha","services":{"api-gateway":"velora-rollback/api-gateway:previous"}}' >"$PREVIOUS_RELEASE_FILE"
export MISSING_CURRENT_CONTAINER=true
if rotate_previous_release_snapshot_to_current; then
  printf 'incomplete current image inventory was accepted for rollback rotation\n' >&2
  exit 1
fi
unset MISSING_CURRENT_CONTAINER
jq -e '.services["api-gateway"] == "velora-rollback/api-gateway:previous"' \
  "$PREVIOUS_RELEASE_FILE" >/dev/null
if grep -q '^image rm ' "$DOCKER_CALLS"; then
  printf 'incomplete current snapshot deleted rollback images\n' >&2
  exit 1
fi

# Incomplete inventory or invalid/missing recovery images must stop all deletion.
for failure in inventory invalid_snapshot missing_image; do
  : >"$DOCKER_CALLS"
  case "$failure" in
    inventory) export BROKEN_DOCKER_PS=true ;;
    invalid_snapshot)
      unset BROKEN_DOCKER_PS
      printf '%s\n' '{"services":{"api-gateway":null}}' >"$BLOCKED_DIR/failed.rollback.json"
      ;;
    missing_image)
      printf '%s\n' '{"services":{"api-gateway":"velora-rollback/api-gateway:missing"}}' >"$BLOCKED_DIR/failed.rollback.json"
      ;;
  esac
  if reclaim_unused_docker_images true; then
    printf 'cleanup accepted unsafe state: %s\n' "$failure" >&2
    exit 1
  fi
  if grep -Eq '^image rm |^image prune ' "$DOCKER_CALLS"; then
    printf 'cleanup deleted images with unsafe state: %s\n' "$failure" >&2
    exit 1
  fi
done

printf 'image cleanup container/recovery safety: PASS\n'
