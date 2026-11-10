#!/usr/bin/env bash
set -Eeuo pipefail

repo_root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd)"
script="$repo_root/scripts/deploy/model-host-probe"
tmp="$(mktemp -d)"
trap 'rm -rf -- "$tmp"' EXIT
mkdir -p "$tmp/bin" "$tmp/out"

# curl stand-in: /api/tags answers $TAGS (e.g. "200 0.012") or times out; /api/ps returns $PS_BODY.
cat >"$tmp/bin/curl" <<'SHIM'
#!/usr/bin/env bash
url="${*: -1}"
if [[ "$url" == */api/tags ]]; then
  [[ -n "${TAGS:-}" ]] || exit 28
  [[ "$*" == *"-w"* ]] && printf '%s\n' "$TAGS"
  exit 0
fi
printf '%s' "${PS_BODY:-}"
SHIM
chmod +x "$tmp/bin/curl"

failures=0
fail() { printf 'FAIL: %s\n' "$*" >&2; failures=$((failures + 1)); }
run() {
  rm -f "$tmp/out"/*
  PATH="$tmp/bin:$PATH" VELORA_MODEL_HOST_METRICS_DIR="$tmp/out" MODEL_HOST_PROBE_TIMEOUT_SECONDS=5 "$script" || fail "probe must always exit 0"
}
metric() { grep -E "^$1[ {]" "$tmp/out/velora-model-host.prom" | head -n1 | awk '{print $NF}'; }

TAGS="200 0.012" PS_BODY='{"models":[{"name":"gemma4:e2b-it-qat","model":"gemma4:e2b-it-qat"}]}' run
[[ "$(metric velora_model_host_up)" == 1 ]] || fail "up should be 1"
[[ "$(metric velora_model_host_model_resident)" == 1 ]] || fail "model should be resident"
[[ "$(metric velora_model_host_probe_duration_seconds)" == 0.012 ]] || fail "duration"
[[ "$(metric velora_model_host_probe_timestamp_seconds)" -gt 1700000000 ]] || fail "timestamp"
[[ "$(stat -c %a "$tmp/out/velora-model-host.prom")" == 644 ]] || fail "file must be world-readable for node-exporter"
grep -q '^velora_model_host_model_resident{model="gemma4:e2b-it-qat"} 1$' "$tmp/out/velora-model-host.prom" || fail "model label"

TAGS="200 0.020" PS_BODY='{"models":[{"name":"gemma4:12b-it-qat"}]}' run
[[ "$(metric velora_model_host_up)" == 1 && "$(metric velora_model_host_model_resident)" == 0 ]] || fail "another model loaded: up but not resident"

TAGS="200 0.020" PS_BODY='{"models":[]}' run
[[ "$(metric velora_model_host_model_resident)" == 0 ]] || fail "nothing loaded"

TAGS="" run
[[ "$(metric velora_model_host_up)" == 0 && "$(metric velora_model_host_model_resident)" == 0 ]] || fail "unreachable: up 0 and not resident"
[[ "$(metric velora_model_host_probe_duration_seconds)" == 5 ]] || fail "unreachable: duration is the timeout"

TAGS="503 0.010" run
[[ "$(metric velora_model_host_up)" == 0 ]] || fail "a non-200 answer is down"

# Never leaves partial files, and does nothing when the metrics directory is missing.
[[ "$(find "$tmp/out" -type f | wc -l | tr -d ' ')" == 1 ]] || fail "only the final file may remain"
VELORA_MODEL_HOST_METRICS_DIR="$tmp/missing" PATH="$tmp/bin:$PATH" "$script" || fail "missing directory must not error"
MODEL_HOST_TUNNEL_PORT='x;y' VELORA_MODEL_HOST_METRICS_DIR="$tmp/out" PATH="$tmp/bin:$PATH" "$script" || fail "bad port must not error"

if ((failures > 0)); then printf '%d check(s) failed\n' "$failures" >&2; exit 1; fi
printf 'model-host-probe: all checks passed\n'
