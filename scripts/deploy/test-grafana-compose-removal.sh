#!/usr/bin/env bash
# Grafana moved to velora-node-2 (infra/grafana-node/). Removing it from the homelab
# Compose model must be an approved migration, must not schedule other services, and
# editing its dashboards in the repo must not restart anything on the homelab.
set -Eeuo pipefail

repo_root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd)"
source "$repo_root/scripts/deploy/velora-deploy"

tmp_dir="$(mktemp -d)"
trap 'rm -rf -- "$tmp_dir"' EXIT

# write_model <out> <with_grafana>
write_model() {
  local out="$1" with_grafana="$2"
  jq -n --argjson g "$with_grafana" '
    {
      networks: {"microservices-net": {"driver": "bridge"}},
      volumes: ({"rabbitmq_data": {}} + (if $g then {"grafana_data": {}} else {} end)),
      services: ({
        "nginx": {"image": "nginx:alpine"},
        "prometheus": {"image": "prom/prometheus:latest"},
        "loki": {"image": "grafana/loki:latest"}
      } + (if $g then {"grafana": {"image": "grafana/grafana:latest"}} else {} end))
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

# 1. Removing Grafana and its volume is an approved migration that schedules nothing.
out="$(run_compare "$tmp_dir/with.json" "$tmp_dir/without.json" 2>&1)" \
  || { printf 'expected the Grafana removal to pass\n%s\n' "$out" >&2; exit 1; }
grep -q "'grafana' removal is an approved migration" <<<"$out" || { printf '%s\n' "$out" >&2; exit 1; }
grep -q 'RECONCILE= INFRA=$' <<<"$out" || { printf '%s\n' "$out" >&2; exit 1; }

# 2. Other removals are still blocked.
jq 'del(.services.loki)' "$tmp_dir/without.json" >"$tmp_dir/no-loki.json"
if out="$(run_compare "$tmp_dir/without.json" "$tmp_dir/no-loki.json" 2>&1)"; then
  printf 'expected another service removal to be blocked\n%s\n' "$out" >&2
  exit 1
fi
grep -q "was removed" <<<"$out" || { printf '%s\n' "$out" >&2; exit 1; }

# 3. Dashboard and provisioning edits no longer recreate a Grafana container here.
for file in infra/monitoring/grafana/dashboards/velora-monitoring.json \
  infra/monitoring/grafana/provisioning/datasources/loki.yml; do
  CHANGED_FILES="$file"
  PULL_SERVICES=(); RECONCILE_SERVICES=(); INFRA_RECONCILE_SERVICES=(); FORCE=false
  plan_from_changed_files 2>"$tmp_dir/stderr"
  if ((${#PULL_SERVICES[@]} + ${#RECONCILE_SERVICES[@]} + ${#INFRA_RECONCILE_SERVICES[@]} != 0)); then
    echo "FAIL: $file must not schedule any service" >&2
    exit 1
  fi
  if grep -q 'unknown tracked change' "$tmp_dir/stderr"; then
    echo "FAIL: $file is reported as an unknown tracked change" >&2
    exit 1
  fi
done

echo "grafana compose removal checks passed"
