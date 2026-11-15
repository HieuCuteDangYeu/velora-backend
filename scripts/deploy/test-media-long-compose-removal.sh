#!/usr/bin/env bash
# The LONG media lane moved to velora-node-2 (infra/friend-mail-node). Removing
# media-processing-long-service from the homelab Compose model must be an approved migration
# that does not reconcile anything by itself, and the SHORT media-processing-service must
# keep reconciling on its own.
set -Eeuo pipefail

repo_root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd)"
source "$repo_root/scripts/deploy/velora-deploy"

tmp_dir="$(mktemp -d)"
trap 'rm -rf -- "$tmp_dir"' EXIT

# write_model <out> <with_long>
write_model() {
  local out="$1" with_long="$2"
  jq -n --argjson l "$with_long" '
    {
      networks: {"microservices-net": {"driver": "bridge"}},
      volumes: {"rabbitmq_data": {}},
      services: ({
        "nginx": {"image": "nginx:alpine"},
        "media-processing-service": {"image": "acme/media-processing-service:old"}
      } + (if $l then {"media-processing-long-service": {"image": "acme/media-processing-service:old"}} else {} end))
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
    RECONCILE_SERVICES=()
    PULL_SERVICES=()
    INFRA_RECONCILE_SERVICES=()
    compare_compose_models
    printf 'RECONCILE=%s INFRA=%s\n' "${RECONCILE_SERVICES[*]:-}" "${INFRA_RECONCILE_SERVICES[*]:-}"
  )
}

write_model "$tmp_dir/with.json" true
write_model "$tmp_dir/without.json" false

# 1. Removing the long lane is an approved migration that schedules nothing itself.
out="$(run_compare "$tmp_dir/with.json" "$tmp_dir/without.json" 2>&1)" \
  || { printf 'expected the long worker removal to pass\n%s\n' "$out" >&2; exit 1; }
grep -q "'media-processing-long-service' removal is an approved migration" <<<"$out" || { printf '%s\n' "$out" >&2; exit 1; }
grep -q 'RECONCILE= INFRA=$' <<<"$out" || { printf '%s\n' "$out" >&2; exit 1; }

# 2. Other removals are still blocked.
jq 'del(.services.nginx)' "$tmp_dir/without.json" >"$tmp_dir/no-nginx.json"
if out="$(run_compare "$tmp_dir/without.json" "$tmp_dir/no-nginx.json" 2>&1)"; then
  printf 'expected another service removal to be blocked\n%s\n' "$out" >&2
  exit 1
fi
grep -q "was removed" <<<"$out" || { printf '%s\n' "$out" >&2; exit 1; }

# 3. The SHORT worker reconciles alone: no companion lane is added any more.
(
  RECONCILE_SERVICES=()
  PULL_SERVICES=()
  add_app_and_worker_companions media-processing-service
  [[ "${RECONCILE_SERVICES[*]}" == "media-processing-service" ]] \
    || { printf 'unexpected reconcile list: %s\n' "${RECONCILE_SERVICES[*]}" >&2; exit 1; }
)

echo "media long-lane compose removal checks passed"
