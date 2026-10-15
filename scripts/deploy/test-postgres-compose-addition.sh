#!/usr/bin/env bash
set -Eeuo pipefail

repo_root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd)"
source "$repo_root/scripts/deploy/velora-deploy"

tmp_dir="$(mktemp -d)"
trap 'rm -rf -- "$tmp_dir"' EXIT

# write_model <out> <postgres image> <with_postgres> <with_mongo>
write_model() {
  local out="$1" postgres_image="$2" with_postgres="$3" with_mongo="$4"
  jq -n --arg image "$postgres_image" --argjson with_postgres "$with_postgres" --argjson with_mongo "$with_mongo" '
    {
      networks: {"microservices-net": {"driver": "bridge"}},
      volumes: ({"rabbitmq_data": {}}
        + (if $with_mongo then {"mongo_data": {}, "mongo_config": {}} else {} end)
        + (if $with_postgres then {"postgres_data": {}} else {} end)),
      services: ({"nginx": {"image": "nginx:alpine"}}
        + (if $with_mongo then {"mongo": {"image": "mongo:8.0"}} else {} end)
        + (if $with_postgres then {"postgres": {"image": $image, "volumes": [{"type": "volume", "source": "postgres_data", "target": "/var/lib/postgresql"}]}} else {} end))
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

write_model "$tmp_dir/mongo-only.json" "postgres:18.6" false true
write_model "$tmp_dir/with.json" "postgres:18.6" true true
write_model "$tmp_dir/changed.json" "postgres:18.7" true true
write_model "$tmp_dir/no-postgres.json" "postgres:18.6" false true

# 1. First addition (postgres_data volume + service) is approved and scheduled once.
out="$(run_compare "$tmp_dir/mongo-only.json" "$tmp_dir/with.json" 2>&1)"
grep -q 'INFRA=postgres$' <<<"$out" || { printf '%s\n' "$out" >&2; exit 1; }

# 2. Unchanged postgres schedules nothing.
out="$(run_compare "$tmp_dir/with.json" "$tmp_dir/with.json" 2>&1)"
grep -q 'INFRA=$' <<<"$out" || { printf '%s\n' "$out" >&2; exit 1; }

# 3. Any later change to the existing postgres definition is blocked.
if out="$(run_compare "$tmp_dir/with.json" "$tmp_dir/changed.json" 2>&1)"; then
  printf 'expected a postgres change to be blocked\n%s\n' "$out" >&2
  exit 1
fi
grep -q "protected/worker service 'postgres'" <<<"$out" || { printf '%s\n' "$out" >&2; exit 1; }

# 4. Removing postgres is still blocked.
if out="$(run_compare "$tmp_dir/with.json" "$tmp_dir/no-postgres.json" 2>&1)"; then
  printf 'expected postgres removal to be blocked\n%s\n' "$out" >&2
  exit 1
fi

# 5. An unrelated volume change is still rejected.
jq '.volumes.surprise_data = {}' "$tmp_dir/with.json" >"$tmp_dir/extra-volume.json"
if out="$(run_compare "$tmp_dir/with.json" "$tmp_dir/extra-volume.json" 2>&1)"; then
  printf 'expected an unrelated volume change to be blocked\n%s\n' "$out" >&2
  exit 1
fi
grep -q 'volumes changed' <<<"$out" || { printf '%s\n' "$out" >&2; exit 1; }

# 6. The reconcile handler never force-recreates the store.
calls="$tmp_dir/docker-calls"
(
  docker() { printf '%s\n' "$*" >>"$calls"; }
  TARGET_SHA="deadbeef"
  INFRA_RECONCILE_SERVICES=(postgres)
  reconcile_infrastructure >/dev/null
)
grep -qx 'compose up -d --no-deps postgres' "$calls"
! grep -q 'force-recreate' "$calls"

printf 'postgres compose addition: PASS\n'
