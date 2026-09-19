#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
source "$repo_root/scripts/deploy/velora-deploy-core"

tmp_root="$(mktemp -d)"
tmp_dir="$tmp_root/Application Support"
mkdir -p "$tmp_dir"
trap '[[ -z "${INFRA_VALIDATION_DIR:-}" ]] || rm -rf "$INFRA_VALIDATION_DIR"; rm -rf "$tmp_root"' EXIT

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
! grep -q 'Application Support' "$calls"

printf 'infra validation scoping: PASS\n'
