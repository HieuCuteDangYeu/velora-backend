#!/usr/bin/env bash
set -Eeuo pipefail

repo_root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd)"
source "$repo_root/scripts/deploy/velora-deploy"

tmp_dir="$(mktemp -d)"
trap 'rm -rf -- "$tmp_dir"' EXIT

# write_model <out> <redis image> <with_redis> <with_mongo>
write_model() {
  local out="$1" redis_image="$2" with_redis="$3" with_mongo="$4"
  jq -n --arg image "$redis_image" --argjson with_redis "$with_redis" --argjson with_mongo "$with_mongo" '
    {
      networks: {"microservices-net": {"driver": "bridge"}},
      volumes: ({"rabbitmq_data": {}}
        + (if $with_mongo then {"mongo_data": {}, "mongo_config": {}} else {} end)
        + (if $with_redis then {"redis_data": {}} else {} end)),
      services: ({"nginx": {"image": "nginx:alpine"}}
        + (if $with_mongo then {"mongo": {"image": "mongo:8.0"}} else {} end)
        + (if $with_redis then {"redis": {"image": $image, "volumes": [{"type": "volume", "source": "redis_data", "target": "/data"}]}} else {} end))
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

write_model "$tmp_dir/mongo-only.json" "redis:8.6" false true
write_model "$tmp_dir/with.json" "redis:8.6" true true
write_model "$tmp_dir/changed.json" "redis:8.7" true true
write_model "$tmp_dir/no-redis.json" "redis:8.6" false true

# 1. First addition (redis_data volume + service) is approved and scheduled once.
out="$(run_compare "$tmp_dir/mongo-only.json" "$tmp_dir/with.json" 2>&1)"
grep -q 'INFRA=redis$' <<<"$out" || { printf '%s\n' "$out" >&2; exit 1; }

# 2. Unchanged redis schedules nothing.
out="$(run_compare "$tmp_dir/with.json" "$tmp_dir/with.json" 2>&1)"
grep -q 'INFRA=$' <<<"$out" || { printf '%s\n' "$out" >&2; exit 1; }

# 3. Any later change to the existing redis definition is blocked.
if out="$(run_compare "$tmp_dir/with.json" "$tmp_dir/changed.json" 2>&1)"; then
  printf 'expected a redis change to be blocked\n%s\n' "$out" >&2
  exit 1
fi
grep -q "protected/worker service 'redis'" <<<"$out" || { printf '%s\n' "$out" >&2; exit 1; }

# 4. Removing redis is still blocked.
if out="$(run_compare "$tmp_dir/with.json" "$tmp_dir/no-redis.json" 2>&1)"; then
  printf 'expected redis removal to be blocked\n%s\n' "$out" >&2
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
  INFRA_RECONCILE_SERVICES=(redis)
  reconcile_infrastructure >/dev/null
)
grep -qx 'compose up -d --no-deps redis' "$calls"
! grep -q 'force-recreate' "$calls"

printf 'redis compose addition: PASS\n'
