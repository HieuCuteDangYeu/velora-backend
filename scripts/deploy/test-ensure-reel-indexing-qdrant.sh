#!/usr/bin/env bash
set -Eeuo pipefail

repo_root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd)"
script="$repo_root/scripts/deploy/ensure-reel-indexing-qdrant"

tmp_dir="$(mktemp -d)"
trap 'rm -rf -- "$tmp_dir"' EXIT
mkdir -p "$tmp_dir/bin" "$tmp_dir/state" "$tmp_dir/app"
: >"$tmp_dir/overlay.yml"
printf 'deadbeef1234\n' >"$tmp_dir/state/deployed-sha"

# A stand-in for docker: container state comes from $SHIM_SCENARIO (good | bad | none)
# and a compose call flips it to "good", like re-applying the real overlay.
cat >"$tmp_dir/bin/docker" <<'SHIM'
#!/usr/bin/env bash
scenario_file="$SHIM_DIR/scenario"
scenario="$(cat "$scenario_file")"
case "$1" in
  ps)
    [[ "$scenario" == none ]] && exit 0
    for arg in "$@"; do
      [[ "$arg" == label=com.docker.compose.service=* ]] && printf 'proj-%s-1\n' "${arg#label=com.docker.compose.service=}"
    done
    ;;
  inspect)
    format="$3"
    if [[ "$format" == *'.Config.Image'* ]]; then
      [[ "$scenario" == good ]] && echo 'velora-reel-indexing-qdrant:6ca1491e' || echo 'hieucutedangyeu/reel-indexing-service:abc'
    elif [[ "$format" == *'.Config.Env'* ]]; then
      echo 'NODE_ENV=production'
      [[ "$scenario" == good ]] && echo 'QDRANT_URL=https://qdrant:6333'
    elif [[ "$format" == *'Networks'* ]]; then
      [[ "$scenario" == good ]] && echo 'proj_microservices-net proj_reel-vector-net ' || echo 'proj_microservices-net '
    fi
    ;;
  compose)
    printf 'tag=%s args=%s\n' "${VELORA_IMAGE_TAG:-}" "$*" >>"$SHIM_DIR/compose-calls"
    echo good >"$scenario_file"
    ;;
esac
SHIM
chmod +x "$tmp_dir/bin/docker"

failures=0
fail() { printf 'FAIL: %s\n' "$*" >&2; failures=$((failures + 1)); }

# run <scenario> [args...]: sets $out and $code, clears recorded compose calls.
run() {
  local scenario="$1"
  shift
  printf '%s\n' "$scenario" >"$tmp_dir/scenario"
  : >"$tmp_dir/compose-calls"
  code=0
  out="$(
    SHIM_DIR="$tmp_dir" PATH="$tmp_dir/bin:$PATH" HOME="$tmp_dir/home" \
      VELORA_APP_DIR="$tmp_dir/app" VELORA_STATE_DIR="$tmp_dir/state" \
      VELORA_QDRANT_INDEX_OVERLAY="${OVERLAY_PATH:-$tmp_dir/overlay.yml}" \
      VELORA_QDRANT_APPLY_SETTLE_SECONDS=0 "$script" "$@" 2>&1
  )" || code=$?
}

expect_code() { [[ "$code" -eq "$1" ]] || fail "$2: expected exit $1, got $code ($out)"; }
expect_out() { [[ "$out" == *"$1"* ]] || fail "$2: output missing '$1' ($out)"; }
compose_calls() { wc -l <"$tmp_dir/compose-calls" | tr -d ' '; }

run good
expect_code 0 "healthy check"
expect_out "reel-indexing-service: ok (velora-reel-indexing-qdrant:6ca1491e)" "healthy check"

run bad --check
expect_code 1 "degraded check"
expect_out "image is hieucutedangyeu/reel-indexing-service:abc" "degraded check"
expect_out "no QDRANT_* environment variables" "degraded check"
expect_out "not attached to reel-vector-net" "degraded check"
[[ "$(compose_calls)" -eq 0 ]] || fail "--check must never recreate containers"

run none --check
expect_code 2 "missing container"
expect_out "no running container" "missing container"

run bad --apply
expect_code 0 "apply on degraded"
[[ "$(compose_calls)" -eq 1 ]] || fail "apply should call compose once, got $(compose_calls)"
expected="up -d --no-deps --no-build --force-recreate reel-indexing-service reel-indexing-long-service"
grep -q -- "-f docker-compose.yml -f $tmp_dir/overlay.yml $expected" "$tmp_dir/compose-calls" \
  || fail "unexpected compose arguments: $(cat "$tmp_dir/compose-calls")"
grep -q 'tag=deadbeef1234 ' "$tmp_dir/compose-calls" || fail "apply should use the deployed SHA as the image tag"

run good --apply
expect_code 0 "apply when healthy"
expect_out "Nothing to apply" "apply when healthy"
[[ "$(compose_calls)" -eq 0 ]] || fail "apply must not touch healthy services"

OVERLAY_PATH="$tmp_dir/missing.yml" run bad --apply
expect_code 3 "missing overlay"
[[ "$(compose_calls)" -eq 0 ]] || fail "apply must not run without the overlay file"

run good --bogus
expect_code 64 "bad usage"

if ((failures > 0)); then
  printf '%d check(s) failed\n' "$failures" >&2
  exit 1
fi
printf 'ensure-reel-indexing-qdrant: all checks passed\n'
