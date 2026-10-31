#!/usr/bin/env bash
set -Eeuo pipefail
root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd)"
tmp="$(mktemp -d)"
trap 'rm -rf -- "$tmp"' EXIT
mkdir -p "$tmp/repo/.git" "$tmp/bin" "$tmp/approved" "$tmp/state"
cat >"$tmp/bin/git" <<'GIT'
#!/usr/bin/env bash
set -eu
case "$1" in
  fetch|merge-base) exit 0 ;;
  rev-parse) printf '1111111111111111111111111111111111111111\n' ;;
  cat-file) [[ -f "$QDRANT_BUNDLE_FIXTURE/velora-qdrant-policy" ]] ;;
  show)
    [[ "$2" == 1111111111111111111111111111111111111111:scripts/deploy/* ]]
    cat "$QDRANT_BUNDLE_FIXTURE/${2##*/}"
    ;;
  *) exit 1 ;;
esac
GIT
chmod +x "$tmp/bin/git"
cat >"$tmp/approved/velora-deploy" <<'CONTROLLER'
#!/usr/bin/env bash
set -eu
source "$(dirname "$0")/velora-deploy-core"
[[ "$POLICY_VERSION" == approved ]]
printf 'approved bundle: PASS\n'
CONTROLLER
printf 'source "$(dirname "${BASH_SOURCE[0]}")/velora-qdrant-policy"\n' >"$tmp/approved/velora-deploy-core"
printf 'POLICY_VERSION=approved\n' >"$tmp/approved/velora-qdrant-policy"
mkdir -p "$tmp/repo/scripts/deploy"
printf 'exit 99\n' >"$tmp/repo/scripts/deploy/velora-qdrant-policy"
run_launcher() {
  PATH="$tmp/bin:$PATH" QDRANT_BUNDLE_FIXTURE="$tmp/approved" VELORA_APP_DIR="$tmp/repo" VELORA_STATE_DIR="$tmp/state" \
    bash "$root/scripts/deploy/velora-deploy-launcher"
}
run_launcher | grep -q 'approved bundle: PASS'
rm "$tmp/approved/velora-qdrant-policy"
if run_launcher >/dev/null 2>&1; then printf 'missing approved policy accepted\n' >&2; exit 1; fi
printf 'POLICY_VERSION=approved\n' >"$tmp/approved/velora-deploy-core"
run_launcher | grep -q 'approved bundle: PASS'
printf 'qdrant launcher bundle (new, missing, legacy): PASS\n'
