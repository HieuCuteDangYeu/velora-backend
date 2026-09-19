#!/usr/bin/env bash
set -euo pipefail

if (( BASH_VERSINFO[0] < 4 )); then
  for bash_candidate in /opt/homebrew/bin/bash /usr/local/bin/bash; do
    [[ -x "$bash_candidate" ]] && exec "$bash_candidate" "$0" "$@"
  done
  printf 'Bash 4+ is required.\n' >&2
  exit 1
fi

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
tmp_dir="$(mktemp -d)"
trap 'rm -rf "$tmp_dir"' EXIT

mkdir -p "$tmp_dir/app/.git" "$tmp_dir/state"
VELORA_APP_DIR="$tmp_dir/app" VELORA_STATE_DIR="$tmp_dir/state" "$BASH" -c '
  source "$1/scripts/deploy/velora-deploy-core"
  TARGET_SHA=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa
  LAST_DEPLOYED_SHA=bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb
  publish_deployment_metrics database-gate
  grep -Fq "velora_deployment_pending{status=\"database-gate\"} 1" "$DEPLOYMENT_METRICS_FILE"
  publish_deployment_metrics pending
  grep -Fq "velora_deployment_pending{status=\"database-gate\"} 1" "$DEPLOYMENT_METRICS_FILE"
  LAST_DEPLOYED_SHA="$TARGET_SHA"
  publish_deployment_metrics success
  grep -Fq "velora_deployment_pending{status=\"success\"} 0" "$DEPLOYMENT_METRICS_FILE"
' _ "$repo_root"

printf 'deployment metrics: PASS\n'
