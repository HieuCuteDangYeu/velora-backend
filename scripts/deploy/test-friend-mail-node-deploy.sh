#!/usr/bin/env bash
# Exercises infra/friend-mail-node/deploy.sh against a fake docker: input validation,
# a changed image, an unchanged image, and automatic rollback of an unhealthy one.
set -Eeuo pipefail

repo_root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd)"
script="$repo_root/infra/friend-mail-node/deploy.sh"
tmp="$(mktemp -d)"
trap 'rm -rf -- "$tmp"' EXIT
mkdir -p "$tmp/bin" "$tmp/stack" "$tmp/fake"

# State lives in files: fake/images (repo:tag=id), fake/running (container=id),
# fake/bad (image ids that never become ready), fake/calls (compose invocations).
cat >"$tmp/bin/docker" <<'FAKE'
#!/usr/bin/env bash
f="$FAKE_DIR"
case "$1 $2" in
  "image inspect")
    ref="${@: -1}"; id="$(grep -m1 "^$ref=" "$f/images" | cut -d= -f2)"
    [[ -n "$id" ]] || exit 1; [[ "$*" == *"{{.Id}}"* ]] && echo "$id"; exit 0 ;;
  "image ls") grep "^$3:" "$f/images" | cut -d= -f1 | sed "s#^$3:##"; exit 0 ;;
esac
case "$1" in
  pull) ref="${@: -1}"; grep -q "^$ref=" "$f/images" || { echo "pull denied" >&2; exit 1; }; exit 0 ;;
  inspect)
    c="${@: -1}"; id="$(grep -m1 "^$c=" "$f/running" | cut -d= -f2)"
    case "$*" in
      *"{{.Image}}"*) echo "$id" ;;
      *) grep -qx "$id" "$f/bad" 2>/dev/null && echo "true 3" || echo "true 0" ;;
    esac ;;
  logs) id="$(grep -m1 "^${@: -1}=" "$f/running" | cut -d= -f2)"
        grep -qx "$id" "$f/bad" 2>/dev/null || echo "Nest microservice successfully started" ;;
  rmi) echo "rmi $2" >>"$f/calls" ;;
  compose)
    svc="${@: -1}"; env_file="$(sed -n 's/.*--env-file \([^ ]*\).*/\1/p' <<<"$*")"
    # shellcheck disable=SC1090
    source "$env_file"
    var="$(tr 'a-z-' 'A-Z_' <<<"$svc")_TAG"; ref="$DOCKERHUB_USERNAME/$svc:${!var}"
    id="$(grep -m1 "^$ref=" "$f/images" | cut -d= -f2)"
    sed -i "/^$svc=/d" "$f/running"; echo "$svc=$id" >>"$f/running"
    echo "up $svc $ref" >>"$f/calls" ;;
esac
FAKE
chmod +x "$tmp/bin/docker"

export FAKE_DIR="$tmp/fake" VELORA_STACK_DIR="$tmp/stack" VELORA_HEALTH_TIMEOUT=3 VELORA_STABLE_SECONDS=0
export PATH="$tmp/bin:$PATH"
sha_old="$(printf 'a%.0s' {1..40})"; sha_new="$(printf 'b%.0s' {1..40})"; sha_bad="$(printf 'c%.0s' {1..40})"

cat >"$tmp/stack/release.env" <<ENV
DOCKERHUB_USERNAME=acme
FRIEND_SERVICE_TAG=boot
MAIL_SERVICE_TAG=boot
ENV
cat >"$tmp/fake/images" <<IMG
acme/friend-service:boot=id-friend-boot
acme/mail-service:boot=id-mail-boot
acme/friend-service:${sha_new}-amd64=id-friend-new
acme/mail-service:${sha_new}-amd64=id-mail-boot
acme/friend-service:${sha_bad}-amd64=id-friend-bad
acme/mail-service:${sha_bad}-amd64=id-mail-bad
IMG
printf 'friend-service=id-friend-boot\nmail-service=id-mail-boot\n' >"$tmp/fake/running"
printf 'id-friend-bad\nid-mail-bad\n' >"$tmp/fake/bad"
: >"$tmp/fake/calls"

run() { SSH_ORIGINAL_COMMAND="$1" bash "$script" >"$tmp/out" 2>&1; }
fail() { echo "FAIL: $1" >&2; cat "$tmp/out" >&2; exit 1; }

for bad in "" "deploy" "deploy latest" "deploy ${sha_new%?}" "deploy ${sha_new}; id" "bash -c id" "deploy ../x"; do
  if run "$bad"; then fail "'$bad' must be rejected"; fi
done
[[ ! -s "$tmp/fake/calls" ]] || fail "rejected commands must not touch docker"

# New friend image, mail image id unchanged: only friend is recreated.
run "deploy $sha_new" || fail "deploy of a healthy release must succeed"
grep -q "^up friend-service acme/friend-service:${sha_new}-amd64$" "$tmp/fake/calls" || fail "friend was not recreated"
grep -q "^up mail-service" "$tmp/fake/calls" && fail "mail has the same image and must not restart"
grep -q "^FRIEND_SERVICE_TAG=${sha_new}-amd64$" "$tmp/stack/release.env" || fail "friend tag not recorded"
grep -q "^MAIL_SERVICE_TAG=boot$" "$tmp/stack/release.env" || fail "mail tag must stay"
grep -q "rmi acme/friend-service:boot" "$tmp/fake/calls" && fail "previous image must be kept for rollback"

# Repeating the same release is a no-op.
: >"$tmp/fake/calls"; run "deploy $sha_new" || fail "repeat must succeed"
[[ ! -s "$tmp/fake/calls" ]] || fail "repeat must not recreate anything"

# Unhealthy release: both services roll back and the run fails.
if run "deploy $sha_bad"; then fail "unhealthy release must exit non-zero"; fi
grep -q "^FRIEND_SERVICE_TAG=${sha_new}-amd64$" "$tmp/stack/release.env" || fail "friend must roll back to its previous tag"
grep -q "^MAIL_SERVICE_TAG=boot$" "$tmp/stack/release.env" || fail "mail must roll back to its previous tag"
grep -q "^friend-service=id-friend-new$" "$tmp/fake/running" || fail "friend must be running the old image"

# Missing image: reported, other service still handled, non-zero exit.
if run "deploy $(printf 'd%.0s' {1..40})"; then fail "missing image must exit non-zero"; fi

run status || fail "status must succeed"
grep -q '^friend-service tag=' "$tmp/out" || fail "status output"
echo "friend-mail node deploy script behaves as designed"
