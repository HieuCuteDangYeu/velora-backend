#!/usr/bin/env bash
set -Eeuo pipefail

repo_root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd)"
source "$repo_root/scripts/deploy/velora-deploy"

tmp_dir="$(mktemp -d)"
trap 'rm -rf -- "$tmp_dir"' EXIT

write_model() {
  local out="$1" mongo_image="$2" with_mongo="$3"
  jq -n --arg image "$mongo_image" --argjson with_mongo "$with_mongo" '
    {
      networks: {"microservices-net": {"driver": "bridge"}},
      volumes: ({"rabbitmq_data": {}} + (if $with_mongo then {"mongo_data": {}, "mongo_config": {}} else {} end)),
      services: ({"nginx": {"image": "nginx:alpine"}}
        + (if $with_mongo then {"mongo": {"image": $image, "volumes": [{"type": "volume", "source": "mongo_data", "target": "/data/db"}]}} else {} end))
    }' >"$out"
}

run_compare() {
  local base="$1" target="$2"
  (
    LAST_DEPLOYED_SHA="0000000000000000000000000000000000000001"
    BASELINE_DIR="$tmp_dir"
    STAGING_DIR="$tmp_dir"
    BASE_COMPOSE_JSON="$base"
    TARGET_COMPOSE_JSON="$target"
    INFRA_RECONCILE_SERVICES=()
    compare_compose_models
    printf 'INFRA=%s\n' "${INFRA_RECONCILE_SERVICES[*]:-}"
  )
}

write_model "$tmp_dir/without.json" "mongo:8.0" false
write_model "$tmp_dir/with.json" "mongo:8.0" true
write_model "$tmp_dir/changed.json" "mongo:8.1" true

# 1. First addition (volumes + service) is approved and scheduled once.
out="$(run_compare "$tmp_dir/without.json" "$tmp_dir/with.json" 2>&1)"
grep -q 'INFRA=mongo$' <<<"$out" || { printf '%s\n' "$out" >&2; exit 1; }

# 2. Unchanged mongo schedules nothing.
out="$(run_compare "$tmp_dir/with.json" "$tmp_dir/with.json" 2>&1)"
grep -q 'INFRA=$' <<<"$out" || { printf '%s\n' "$out" >&2; exit 1; }

# 3. Any later change to the existing mongo definition is blocked.
if out="$(run_compare "$tmp_dir/with.json" "$tmp_dir/changed.json" 2>&1)"; then
  printf 'expected a mongo change to be blocked\n%s\n' "$out" >&2
  exit 1
fi
grep -q "protected/worker service 'mongo'" <<<"$out" || { printf '%s\n' "$out" >&2; exit 1; }

# 4. Removing mongo is still blocked.
if out="$(run_compare "$tmp_dir/with.json" "$tmp_dir/without.json" 2>&1)"; then
  printf 'expected mongo removal to be blocked\n%s\n' "$out" >&2
  exit 1
fi

# 5. The reconcile handler never force-recreates the database.
calls="$tmp_dir/docker-calls"
(
  docker() { printf '%s\n' "$*" >>"$calls"; }
  TARGET_SHA="deadbeef"
  INFRA_RECONCILE_SERVICES=(mongo)
  reconcile_infrastructure >/dev/null
)
grep -qx 'compose up -d --no-deps mongo' "$calls"
! grep -q 'force-recreate' "$calls"

# 6. The backup script alone does not trigger an application redeploy.
(
  CHANGED_FILES="scripts/ops/backup-mongo.sh"
  FORCE=false
  RECONCILE_SERVICES=()
  PULL_SERVICES=()
  plan_from_changed_files
  (( ${#RECONCILE_SERVICES[@]} == 0 && ${#PULL_SERVICES[@]} == 0 ))
)

printf 'mongo compose addition: PASS\n'
