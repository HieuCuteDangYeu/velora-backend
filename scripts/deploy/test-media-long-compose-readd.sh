#!/usr/bin/env bash
# media-processing-long-service came back to the homelab Compose model after a day on node-2.
# Adding it again must be an approved migration that pulls and reconciles only that service,
# while other additions or changes to protected services stay blocked.
set -Eeuo pipefail

repo_root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd)"
source "$repo_root/scripts/deploy/velora-deploy"

tmp_dir="$(mktemp -d)"
trap 'rm -rf -- "$tmp_dir"' EXIT

write_model() { # write_model <out> <with_long> <short image>
  jq -n --argjson l "$2" --arg img "$3" '
    {
      networks: {"microservices-net": {"driver": "bridge"}},
      volumes: {"rabbitmq_data": {}},
      services: ({
        "nginx": {"image": "nginx:alpine"},
        "media-processing-service": {"image": $img}
      } + (if $l then {"media-processing-long-service": {"image": $img}} else {} end))
    }' >"$1"
}

run_compare() {
  (
    LAST_DEPLOYED_SHA="0000000000000000000000000000000000000001"
    BASELINE_DIR="$tmp_dir"
    STAGING_DIR="$tmp_dir"
    BASE_COMPOSE_JSON="$1"
    TARGET_COMPOSE_JSON="$2"
    RECONCILE_SERVICES=()
    PULL_SERVICES=()
    INFRA_RECONCILE_SERVICES=()
    compare_compose_models
    printf 'RECONCILE=%s PULL=%s INFRA=%s\n' "${RECONCILE_SERVICES[*]:-}" "${PULL_SERVICES[*]:-}" "${INFRA_RECONCILE_SERVICES[*]:-}"
  )
}

write_model "$tmp_dir/without.json" false acme/media:1
write_model "$tmp_dir/with.json" true acme/media:1

# 1. Re-adding the long lane is approved and schedules only that service.
out="$(run_compare "$tmp_dir/without.json" "$tmp_dir/with.json" 2>&1)" \
  || { printf 'expected the re-addition to pass\n%s\n' "$out" >&2; exit 1; }
grep -q "addition is an approved media lane migration" <<<"$out" || { printf '%s\n' "$out" >&2; exit 1; }
grep -q 'RECONCILE=media-processing-long-service PULL=media-processing-long-service INFRA=$' <<<"$out" \
  || { printf '%s\n' "$out" >&2; exit 1; }

# 2. Changing the existing long service afterwards stays a protected change.
jq '.services["media-processing-long-service"].restart = "no"' "$tmp_dir/with.json" >"$tmp_dir/changed.json"
if out="$(run_compare "$tmp_dir/with.json" "$tmp_dir/changed.json" 2>&1)"; then
  printf 'expected a change to the long service to be blocked\n%s\n' "$out" >&2
  exit 1
fi
grep -q "manual review is required" <<<"$out" || { printf '%s\n' "$out" >&2; exit 1; }

echo "media long-lane re-addition checks passed"
