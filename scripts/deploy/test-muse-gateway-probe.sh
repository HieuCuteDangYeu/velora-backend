#!/usr/bin/env bash
set -Eeuo pipefail

repo_root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd)"
script="$repo_root/scripts/deploy/muse-gateway-probe"
tmp="$(mktemp -d)"
trap 'rm -rf -- "$tmp"' EXIT
mkdir -p "$tmp/bin" "$tmp/out"

# curl stand-in: prints $BODY then the status code on its own line, or times out when $CODE is empty.
cat >"$tmp/bin/curl" <<'SHIM'
#!/usr/bin/env bash
[[ -n "${CODE:-}" ]] || exit 28
printf '%s\n%s' "${BODY:-}" "$CODE"
SHIM
chmod +x "$tmp/bin/curl"

failures=0
fail() { printf 'FAIL: %s\n' "$*" >&2; failures=$((failures + 1)); }
run() {
  rm -f "$tmp/out"/*
  PATH="$tmp/bin:$PATH" VELORA_MODEL_HOST_METRICS_DIR="$tmp/out" "$script" || fail "probe must always exit 0"
}
metric() { grep -E "^$1 " "$tmp/out/velora-muse-gateway.prom" | head -n1 | awk '{print $NF}'; }

CODE=200 BODY='{"ready":true,"driver":{"driver":"browser","ok":true},"accounts":{"total":1,"available":1,"invalid":0,"inflight":0}}' run
[[ "$(metric velora_muse_gateway_up)" == 1 && "$(metric velora_muse_gateway_ready)" == 1 ]] || fail "healthy: up 1 ready 1"
[[ "$(metric velora_muse_gateway_accounts_available)" == 1 && "$(metric velora_muse_gateway_accounts_invalid)" == 0 ]] || fail "healthy: account counts"
[[ "$(metric velora_muse_gateway_probe_timestamp_seconds)" -gt 1700000000 ]] || fail "timestamp"
[[ "$(stat -c %a "$tmp/out/velora-muse-gateway.prom")" == 644 ]] || fail "file must be world-readable for node-exporter"

CODE=200 BODY='{"ready":false,"driver":{"driver":"browser","ok":true},"accounts":{"total":1,"available":0,"invalid":1,"inflight":0}}' run
[[ "$(metric velora_muse_gateway_up)" == 1 && "$(metric velora_muse_gateway_ready)" == 0 ]] || fail "expired session: up 1 ready 0"
[[ "$(metric velora_muse_gateway_accounts_available)" == 0 && "$(metric velora_muse_gateway_accounts_invalid)" == 1 ]] || fail "expired session: counts"

CODE="" run
[[ "$(metric velora_muse_gateway_up)" == 0 && "$(metric velora_muse_gateway_ready)" == 0 ]] || fail "unreachable: up 0 ready 0"
[[ "$(metric velora_muse_gateway_accounts_available)" == 0 ]] || fail "unreachable: no accounts"

CODE=502 BODY='' run
[[ "$(metric velora_muse_gateway_up)" == 0 ]] || fail "a non-200 answer is down"

[[ "$(find "$tmp/out" -type f | wc -l | tr -d ' ')" == 1 ]] || fail "only the final file may remain"
VELORA_MODEL_HOST_METRICS_DIR="$tmp/missing" PATH="$tmp/bin:$PATH" "$script" || fail "missing directory must not error"
MUSE_GATEWAY_TUNNEL_PORT='x;y' VELORA_MODEL_HOST_METRICS_DIR="$tmp/out" PATH="$tmp/bin:$PATH" "$script" || fail "bad port must not error"

if ((failures > 0)); then printf '%d check(s) failed\n' "$failures" >&2; exit 1; fi
printf 'muse-gateway-probe: all checks passed\n'
