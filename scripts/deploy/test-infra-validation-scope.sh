#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
tmp_dir="$(mktemp -d)"
trap 'rm -rf "$tmp_dir"' EXIT
export VELORA_STATE_DIR="$tmp_dir/state"
source "$repo_root/scripts/deploy/velora-deploy-core"

STAGING_DIR="$tmp_dir/staging"
TARGET_COMPOSE_JSON="$tmp_dir/compose.json"
calls="$tmp_dir/docker-calls"

mkdir -p \
  "$STAGING_DIR/infra/nginx" \
  "$STAGING_DIR/infra/monitoring/prometheus"
touch \
  "$STAGING_DIR/infra/nginx/nginx.conf" \
  "$STAGING_DIR/infra/monitoring/prometheus/prometheus.yml"

cat >"$TARGET_COMPOSE_JSON" <<'JSON'
{"services":{"nginx":{"image":"nginx:alpine"},"prometheus":{"image":"prom/prometheus:latest"}}}
JSON

docker() {
  printf '%s\n' "$*" >>"$calls"
}

INFRA_RECONCILE_SERVICES=()
validate_target_infrastructure
[[ ! -e "$calls" ]]

INFRA_RECONCILE_SERVICES=(nginx)
validate_target_infrastructure
grep -q 'nginx:alpine nginx -t' "$calls"
! grep -q 'prom/prometheus' "$calls"

: >"$calls"
read_env_value() {
  return 0
}

docker() {
  local command="$1"
  shift

  case "$command" in
    ps)
      printf '%s\n' \
        'created-id created' \
        'running-id running' \
        'exited-id exited' \
        'removing-id removing'
      ;;
    inspect)
      [[ "$1" == "--format" ]]
      shift 2
      printf '%s\n' "$*" >>"$calls"
      local id
      for id in "$@"; do
        printf 'image-%s\n' "$id"
      done
      ;;
  esac
}

cleanup_unused_velora_application_sha_tags false
grep -q 'running-id exited-id' "$calls"
! grep -q 'created-id' "$calls"
! grep -q 'removing-id' "$calls"

printf 'deploy scoping: PASS\n'
