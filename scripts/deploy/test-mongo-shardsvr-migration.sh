#!/usr/bin/env bash
# The sharding cutover may change the protected mongo service in exactly one way:
# append `--shardsvr --port 27017` to mongod and add extra_hosts. Anything else on
# mongo must still block the release.
set -Eeuo pipefail

repo_root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd)"
source "$repo_root/scripts/deploy/velora-deploy"

tmp_dir="$(mktemp -d)"
trap 'rm -rf -- "$tmp_dir"' EXIT

base_cmd='set -e
exec docker-entrypoint.sh mongod --replSet rs0 --keyFile /data/configdb/keyfile --bind_ip_all --wiredTigerCacheSizeGB 0.5
'

write_model() {
  local out="$1" script="$2" hosts="$3" image="${4:-mongo:8.0}"
  jq -n --arg script "$script" --argjson hosts "$hosts" --arg image "$image" '
    {
      networks: {"microservices-net": {"driver": "bridge"}},
      volumes: {"mongo_data": {}, "mongo_config": {}},
      services: {
        "mongo": ({
          "image": $image,
          "entrypoint": ["bash", "-c", $script],
          "volumes": [{"type": "volume", "source": "mongo_data", "target": "/data/db"}]
        } + (if $hosts == null then {} else {"extra_hosts": $hosts} end))
      }
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
    RECONCILE_SERVICES=()
    PULL_SERVICES=()
    compare_compose_models
    printf 'INFRA=%s\n' "${INFRA_RECONCILE_SERVICES[*]:-}"
  )
}

shard_cmd="${base_cmd/--wiredTigerCacheSizeGB 0.5/--wiredTigerCacheSizeGB 0.5 --shardsvr --port 27017}"

write_model "$tmp_dir/base.json" "$base_cmd" null
write_model "$tmp_dir/shard.json" "$shard_cmd" '["sh2.lab=100.104.227.44"]'
write_model "$tmp_dir/shard-no-hosts.json" "$shard_cmd" null
write_model "$tmp_dir/shard-other.json" "${shard_cmd/0.5/2}" '["sh2.lab=100.104.227.44"]'
write_model "$tmp_dir/shard-image.json" "$shard_cmd" '["sh2.lab=100.104.227.44"]' mongo:8.2
write_model "$tmp_dir/hosts-only.json" "$base_cmd" '["sh2.lab=100.104.227.44"]'

expect_converge() {
  local out
  out="$(run_compare "$1" "$2" 2>&1)" || { printf 'FAIL (%s): blocked\n%s\n' "$3" "$out" >&2; exit 1; }
  grep -q 'INFRA=mongo$' <<<"$out" || { printf 'FAIL (%s)\n%s\n' "$3" "$out" >&2; exit 1; }
}

expect_blocked() {
  local out
  if out="$(run_compare "$1" "$2" 2>&1)"; then
    printf 'FAIL (%s): expected a block\n%s\n' "$3" "$out" >&2
    exit 1
  fi
  grep -q "protected/worker service 'mongo'" <<<"$out" || { printf 'FAIL (%s)\n%s\n' "$3" "$out" >&2; exit 1; }
}

expect_converge "$tmp_dir/base.json" "$tmp_dir/shard.json" 'shardsvr + extra_hosts'
expect_converge "$tmp_dir/base.json" "$tmp_dir/shard-no-hosts.json" 'shardsvr only'
expect_blocked "$tmp_dir/base.json" "$tmp_dir/shard-other.json" 'shardsvr with another flag change'
expect_blocked "$tmp_dir/base.json" "$tmp_dir/shard-image.json" 'shardsvr with an image change'
expect_blocked "$tmp_dir/base.json" "$tmp_dir/hosts-only.json" 'extra_hosts without shardsvr'
expect_blocked "$tmp_dir/shard.json" "$tmp_dir/shard-other.json" 'later change after the migration'

printf 'mongo shard-server migration is approved only in its exact form\n'
