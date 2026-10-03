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
  'image inspect --format {{.Id}} '*)
    ref="${@: -1}"
    [[ "$ref" != *:missing && "$ref" != tei:cpu ]] || exit 1
    printf 'sha256:%s\n' "${ref##*:}"
    ;;
  'image ls testuser/api-gateway --format {{.Repository}}:{{.Tag}}')
    printf '%s\n' testuser/api-gateway:latest testuser/api-gateway:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa testuser/api-gateway:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb
    ;;
  'image ls --filter reference=velora-rollback/* --format {{.Repository}}:{{.Tag}}')
    printf 'velora-rollback/api-gateway:%s\n' previous emergency inflight interrupted orphan stopped
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
! grep -Eq '^inspect |^image rm .*nginx|^image rm -f|^system prune|^volume ' "$DOCKER_CALLS"

: >"$DOCKER_CALLS"
cleanup_unused_velora_application_sha_tags false
grep -Fxq "image rm testuser/api-gateway:$TARGET_SHA" "$DOCKER_CALLS"

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
  ! grep -Eq '^image rm |^image prune ' "$DOCKER_CALLS"
done

printf 'image cleanup container/recovery safety: PASS\n'
