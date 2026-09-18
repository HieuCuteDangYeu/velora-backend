#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
tmp_dir="$(mktemp -d)"
trap 'rm -rf "$tmp_dir"' EXIT

mkdir -p "$tmp_dir/home" "$tmp_dir/bin"
export HOME="$tmp_dir/home"
export DOCKER_CALLS="$tmp_dir/docker-calls"

cat >"$tmp_dir/bin/docker" <<'SH'
#!/usr/bin/env bash
set -euo pipefail
printf '%s\n' "$*" >>"$DOCKER_CALLS"

if [[ "$1" == "ps" ]]; then
  if [[ "${2:-}" == "-aq" ]]; then
    printf 'stale-created-container\n'
  elif [[ "${2:-}" == "-a" && "${3:-}" == "--format" ]]; then
    printf 'testuser/api-gateway:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\n'
    printf 'nginx:alpine\n'
  fi
  exit 0
fi

if [[ "$1" == "inspect" ]]; then
  exit 97
fi

if [[ "$1" == "image" && "${2:-}" == "inspect" ]]; then
  printf 'sha256:kept-image\n'
  exit 0
fi

if [[ "$1" == "image" && "${2:-}" == "ls" ]]; then
  exit 0
fi

exit 0
SH
chmod +x "$tmp_dir/bin/docker"
export PATH="$tmp_dir/bin:$PATH"

source "$repo_root/scripts/deploy/velora-deploy-core"

read_env_value() {
  [[ "$1" == "DOCKERHUB_USERNAME" ]] && printf 'testuser\n'
}

TARGET_SHA=bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb
cleanup_unused_velora_application_sha_tags false

grep -Fq "ps -a --format {{.Image}}" "$DOCKER_CALLS"
if grep -q '^inspect ' "$DOCKER_CALLS"; then
  printf 'container-level docker inspect must not be used during image cleanup\n' >&2
  exit 1
fi

printf 'image cleanup container safety: PASS\n'
