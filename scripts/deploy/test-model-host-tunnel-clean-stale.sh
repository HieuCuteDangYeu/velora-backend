#!/usr/bin/env bash
set -Eeuo pipefail

repo_root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd)"
script="$repo_root/scripts/deploy/model-host-tunnel-clean-stale"
tmp="$(mktemp -d)"
trap 'rm -rf -- "$tmp"' EXIT
mkdir -p "$tmp/bin"

cat >"$tmp/bin/ssh" <<'SHIM'
#!/usr/bin/env bash
printf '%s\n' "$*" >"$SHIM_DIR/ssh-args"
[[ "${SSH_FAIL:-0}" == 1 ]] && exit 255
exit 0
SHIM
chmod +x "$tmp/bin/ssh"

failures=0
fail() { printf 'FAIL: %s\n' "$*" >&2; failures=$((failures + 1)); }
run() { code=0; SHIM_DIR="$tmp" PATH="$tmp/bin:$PATH" "$script" >/dev/null 2>&1 || code=$?; }

run
[[ "$code" -eq 0 ]] || fail "must exit 0"
args="$(cat "$tmp/ssh-args")"
[[ "$args" == *"BatchMode=yes"* && "$args" == *"ConnectTimeout=10"* ]] || fail "ssh must not prompt or hang: $args"
[[ "$args" == *"velora-homelab"* ]] || fail "default host: $args"
[[ "$args" == *"-iTCP:11435 -sTCP:LISTEN"* ]] || fail "default port: $args"
[[ "$args" == *"grep -q '^sshd-session'"* ]] || fail "must only signal sshd sessions: $args"

SSH_FAIL=1 run
[[ "$code" -eq 0 ]] || fail "an unreachable homelab must never block the tunnel starting (exit $code)"

MODEL_HOST_TUNNEL_PORT=12345 MODEL_HOST_TUNNEL_HOST=other run
args="$(cat "$tmp/ssh-args")"
[[ "$args" == *"-iTCP:12345"* && "$args" == *" other "* ]] || fail "overrides: $args"

rm -f "$tmp/ssh-args"
MODEL_HOST_TUNNEL_PORT='1; rm -rf /' run
[[ "$code" -eq 0 && ! -e "$tmp/ssh-args" ]] || fail "a non-numeric port must be refused without calling ssh"

if ((failures > 0)); then printf '%d check(s) failed\n' "$failures" >&2; exit 1; fi
printf 'model-host-tunnel-clean-stale: all checks passed\n'
