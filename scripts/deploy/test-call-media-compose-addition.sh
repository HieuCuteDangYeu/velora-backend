#!/usr/bin/env bash
set -Eeuo pipefail

repo_root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd)"
source "$repo_root/scripts/deploy/velora-deploy"

tmp_dir="$(mktemp -d)"
trap 'rm -rf -- "$tmp_dir"' EXIT

# write_model <out> <with_media_nodes> <media port>
write_model() {
  local out="$1" with_media="$2" port="${3:-40000}"
  jq -n --argjson with_media "$with_media" --arg port "$port" '
    {
      networks: {"microservices-net": {"driver": "bridge"}},
      volumes: {"rabbitmq_data": {}},
      services: ({
        "nginx": {"image": "nginx:alpine"},
        "call-service": {"image": "x/call-service:latest",
          "environment": (if $with_media then {"CALL_MEDIA_MODE": "remote"} else {"CALL_SINGLE_INSTANCE_GUARD": "true"} end)}
      } + (if $with_media then {
        "call-media-1": {"image": "x/call-service:latest", "ports": [{"published": $port, "protocol": "udp"}]}
      } else {} end))
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
    printf 'RECONCILE=%s\n' "${RECONCILE_SERVICES[*]:-}"
  )
}

write_model "$tmp_dir/embedded.json" false
write_model "$tmp_dir/remote.json" true
write_model "$tmp_dir/remote-moved.json" true 40005

# 1. Adding the media nodes reconciles them together with call-service.
out="$(run_compare "$tmp_dir/embedded.json" "$tmp_dir/remote.json" 2>&1)"
grep -q 'RECONCILE=call-service call-media-1$' <<<"$out" \
  || { printf '%s\n' "$out" >&2; exit 1; }

# 2. A later media node change is reviewed as a call-service change.
out="$(run_compare "$tmp_dir/remote.json" "$tmp_dir/remote-moved.json" 2>&1)"
grep -q 'RECONCILE=call-service call-media-1$' <<<"$out" \
  || { printf '%s\n' "$out" >&2; exit 1; }

# 3. Removing media nodes is still blocked like any service removal.
if out="$(run_compare "$tmp_dir/remote.json" "$tmp_dir/embedded.json" 2>&1)"; then
  printf 'expected media node removal to be blocked\n%s\n' "$out" >&2
  exit 1
fi
grep -q "was removed" <<<"$out" || { printf '%s\n' "$out" >&2; exit 1; }

# 4. Any call-service image change also recreates the media nodes.
(
  RECONCILE_SERVICES=()
  PULL_SERVICES=()
  add_app_and_worker_companions call-service
  [[ "${RECONCILE_SERVICES[*]}" == "call-service call-media-1" ]] \
    || { printf 'unexpected companions: %s\n' "${RECONCILE_SERVICES[*]}" >&2; exit 1; }
)

echo "call media compose addition checks passed"
