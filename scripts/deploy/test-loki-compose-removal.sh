#!/usr/bin/env bash
# Loki moved to velora-node-2 (infra/loki-node/). Removing it from the homelab Compose model
# must be an approved migration that does not touch other services by itself, and the Alloy
# config (which now pushes to the VPS) must still reconcile Alloy.
set -Eeuo pipefail

repo_root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd)"
source "$repo_root/scripts/deploy/velora-deploy"

tmp_dir="$(mktemp -d)"
trap 'rm -rf -- "$tmp_dir"' EXIT

# write_model <out> <with_loki>
write_model() {
  local out="$1" with_loki="$2"
  jq -n --argjson l "$with_loki" '
    {
      networks: {"microservices-net": {"driver": "bridge"}},
      volumes: ({"rabbitmq_data": {}} + (if $l then {"loki_data": {}} else {} end)),
      services: ({
        "nginx": {"image": "nginx:alpine"},
        "prometheus": {"image": "prom/prometheus:latest"}
      } + (if $l then {"loki": {"image": "grafana/loki:latest"}} else {} end))
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

# 1. Removing Loki and its volume is an approved migration that schedules nothing itself.
out="$(run_compare "$tmp_dir/with.json" "$tmp_dir/without.json" 2>&1)" \
  || { printf 'expected the Loki removal to pass\n%s\n' "$out" >&2; exit 1; }
grep -q "'loki' removal is an approved migration" <<<"$out" || { printf '%s\n' "$out" >&2; exit 1; }
grep -q 'RECONCILE= INFRA=$' <<<"$out" || { printf '%s\n' "$out" >&2; exit 1; }

# 2. Other removals are still blocked.
jq 'del(.services.prometheus)' "$tmp_dir/without.json" >"$tmp_dir/no-prom.json"
if out="$(run_compare "$tmp_dir/without.json" "$tmp_dir/no-prom.json" 2>&1)"; then
  printf 'expected another service removal to be blocked\n%s\n' "$out" >&2
  exit 1
fi
grep -q "was removed" <<<"$out" || { printf '%s\n' "$out" >&2; exit 1; }

# 3. The Alloy config reconciles Alloy only, and no path still asks for Loki.
CHANGED_FILES="infra/monitoring/alloy/config.alloy"
PULL_SERVICES=(); RECONCILE_SERVICES=(); INFRA_RECONCILE_SERVICES=(); FORCE=false
plan_from_changed_files 2>"$tmp_dir/stderr"
[[ "${INFRA_RECONCILE_SERVICES[*]}" == "alloy" ]] \
  || { printf 'unexpected infra services: %s\n' "${INFRA_RECONCILE_SERVICES[*]:-}" >&2; exit 1; }

CHANGED_FILES="__INITIAL_RELEASE__"
PULL_SERVICES=(); RECONCILE_SERVICES=(); INFRA_RECONCILE_SERVICES=(); FORCE=false
plan_from_changed_files 2>"$tmp_dir/stderr"
if printf '%s\n' "${INFRA_RECONCILE_SERVICES[@]}" | grep -qx 'loki\|grafana'; then
  echo "FAIL: the initial release must not start Loki or Grafana" >&2
  exit 1
fi

echo "loki compose removal checks passed"
