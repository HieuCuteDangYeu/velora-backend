#!/usr/bin/env bash
set -Eeuo pipefail

repo_root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd)"
script="$repo_root/scripts/deploy/model-host-ollama"

tmp="$(mktemp -d)"
trap 'rm -rf -- "$tmp"' EXIT
mkdir -p "$tmp/bin" "$tmp/containers"

# A stand-in for docker and curl. Containers live in $tmp/containers/<name>/{image,running,env}.
cat >"$tmp/bin/docker" <<'SHIM'
#!/usr/bin/env bash
c="$SHIM_DIR/containers"
echo "docker $*" >>"$SHIM_DIR/calls"
case "$1" in
  inspect)
    name="${*: -1}"; [[ -d "$c/$name" ]] || exit 1
    case "$3" in
      *'.State.Running'*) cat "$c/$name/running" ;;
      *'.Config.Env'*) cat "$c/$name/env" ;;
      *'.Image'*) cat "$c/$name/image" ;;
    esac ;;
  stop) echo false >"$c/$2/running" ;;
  start) echo true >"$c/$2/running" ;;
  rename) mv "$c/$2" "$c/$3" ;;
  update) ;;
  rm) rm -rf "$c/${*: -1}" ;;
  run)
    [[ "${FAIL_RUN:-0}" == 1 ]] && exit 1
    args=("$@"); name=""; env=""
    for ((i = 0; i < ${#args[@]}; i++)); do
      [[ "${args[i]}" == --name ]] && name="${args[i + 1]}"
      [[ "${args[i]}" == -e ]] && env+="${args[i + 1]}"$'\n'
    done
    mkdir -p "$c/$name"; printf '%s' "$env" >"$c/$name/env"; echo "${args[-1]}" >"$c/$name/image"; echo true >"$c/$name/running" ;;
esac
SHIM
cat >"$tmp/bin/curl" <<'SHIM'
#!/usr/bin/env bash
echo "curl $*" >>"$SHIM_DIR/calls"
[[ "$*" == *"/api/generate"* ]] && echo "warm" >>"$SHIM_DIR/warm"
[[ "${READY:-1}" == 1 ]]
SHIM
chmod +x "$tmp/bin/docker" "$tmp/bin/curl"

failures=0
fail() { printf 'FAIL: %s\n' "$*" >&2; failures=$((failures + 1)); }

# seed <keep-alive>: an existing, running velora-gemma4 container
seed() {
  rm -rf "$tmp/containers" "$tmp/calls" "$tmp/warm"; mkdir -p "$tmp/containers/velora-gemma4"
  echo "sha256:olddeadbeef" >"$tmp/containers/velora-gemma4/image"
  echo true >"$tmp/containers/velora-gemma4/running"
  printf 'OLLAMA_KEEP_ALIVE=%s\nOLLAMA_NUM_PARALLEL=1\nOLLAMA_MAX_LOADED_MODELS=1\nOLLAMA_CONTEXT_LENGTH=4096\nOLLAMA_HOST=0.0.0.0:11434\n' "$1" >"$tmp/containers/velora-gemma4/env"
  : >"$tmp/calls"
}
run() {
  code=0
  out="$(SHIM_DIR="$tmp" PATH="$tmp/bin:$PATH" MODEL_HOST_READY_TIMEOUT_SECONDS=2 "$script" "$@" 2>&1)" || code=$?
}
calls() { grep -c "^docker $1" "$tmp/calls" || true; }
expect() { [[ "$code" -eq "$1" ]] || fail "$2: expected exit $1, got $code ($out)"; }
has() { [[ "$out" == *"$1"* ]] || fail "$2: output missing '$1' ($out)"; }

seed 5m
run --dry-run
expect 0 "dry run"
for want in "--gpus all" "--restart unless-stopped" "-p 127.0.0.1:11434:11434" "-v velora-gemma4-models:/root/.ollama" "OLLAMA_KEEP_ALIVE=-1" "OLLAMA_NUM_PARALLEL=1" "OLLAMA_MAX_LOADED_MODELS=1" "sha256:olddeadbeef"; do has "$want" "dry run"; done
[[ "$(calls stop)" -eq 0 ]] || fail "dry run must not touch containers"

seed -1
run
expect 0 "already configured"
has "nothing to do" "already configured"
[[ "$(calls stop)" -eq 0 && "$(calls run)" -eq 0 ]] || fail "an up-to-date container must be left alone"

seed 5m
run
expect 0 "replace"
[[ "$(calls stop)" -eq 1 && "$(calls run)" -eq 1 ]] || fail "replace should stop once and run once"
grep -q "docker update --restart=no velora-gemma4-previous-" "$tmp/calls" || fail "the old container must not restart on boot"
grep -q "^OLLAMA_KEEP_ALIVE=-1$" "$tmp/containers/velora-gemma4/env" || fail "new container lacks keep-alive -1"
[[ "$(cat "$tmp/containers/velora-gemma4/image")" == sha256:olddeadbeef ]] || fail "the image must be reused, not :latest"
compgen -G "$tmp/containers/velora-gemma4-previous-*" >/dev/null || fail "the previous container must be kept for rollback"
[[ -s "$tmp/warm" ]] || fail "the model should be warmed after the swap"

seed 5m
READY=0 run
expect 1 "rollback"
has "rolling back" "rollback"
[[ "$(cat "$tmp/containers/velora-gemma4/image")" == sha256:olddeadbeef && "$(cat "$tmp/containers/velora-gemma4/running")" == true ]] || fail "rollback must restore the original, running"
grep -q "^OLLAMA_KEEP_ALIVE=5m$" "$tmp/containers/velora-gemma4/env" || fail "rollback must restore the original settings"
grep -q "docker update --restart=unless-stopped velora-gemma4" "$tmp/calls" || fail "rollback must restore the restart policy"

seed 5m
FAIL_RUN=1 run
expect 1 "run failure"
[[ "$(cat "$tmp/containers/velora-gemma4/running")" == true ]] || fail "a failed run must roll back to the original"

rm -rf "$tmp/containers"; mkdir -p "$tmp/containers"
run
expect 3 "no container, no image"

seed 5m
run --nope
expect 64 "bad usage"

if ((failures > 0)); then
  printf '%d check(s) failed\n' "$failures" >&2
  exit 1
fi
printf 'model-host-ollama: all checks passed\n'
