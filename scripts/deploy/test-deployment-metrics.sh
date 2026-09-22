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
  grep -Fq "velora_deployment_pending{status=\"database-gate\",target_sha=\"$TARGET_SHA\",deployed_sha=\"$LAST_DEPLOYED_SHA\",reason=\"The release changes a cloud database" "$DEPLOYMENT_METRICS_FILE"
  grep -Fq "velora-deploy --approve-db-change $TARGET_SHA" "$DEPLOYMENT_METRICS_FILE"
  publish_deployment_metrics pending
  grep -Fq "status=\"database-gate\"" "$DEPLOYMENT_METRICS_FILE"
  publish_deployment_metrics error "pull failed for \"api-gateway\"" "check docker"
  publish_deployment_metrics pending
  grep -Fq "reason=\"pull failed for \\\"api-gateway\\\"\",action=\"check docker\"" "$DEPLOYMENT_METRICS_FILE"
  LAST_DEPLOYED_SHA="$TARGET_SHA"
  publish_deployment_metrics success
  grep -Fq "velora_deployment_pending{status=\"success\",target_sha=\"$TARGET_SHA\",deployed_sha=\"$TARGET_SHA\",reason=\"Production is running the promoted release.\",action=\"No action required.\"} 0" "$DEPLOYMENT_METRICS_FILE"
' _ "$repo_root"

if VELORA_APP_DIR="$tmp_dir/app" VELORA_STATE_DIR="$tmp_dir/state" "$BASH" -c '
  source "$1/scripts/deploy/velora-deploy-core"
  TARGET_SHA=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa
  LAST_DEPLOYED_SHA=bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb
  fail "failed to pull api-gateway image"
' _ "$repo_root" 2>/dev/null; then
  printf 'fail was expected to exit non-zero\n' >&2
  exit 1
fi
grep -Fq 'status="error"' "$tmp_dir/app/infra/monitoring/node-exporter-textfile/velora-deploy.prom"
grep -Fq 'reason="failed to pull api-gateway image"' "$tmp_dir/app/infra/monitoring/node-exporter-textfile/velora-deploy.prom"

if VELORA_APP_DIR="$tmp_dir/app" VELORA_STATE_DIR="$tmp_dir/state" "$BASH" -c '
  source "$1/scripts/deploy/velora-deploy-core"
  TARGET_SHA=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa
  LAST_DEPLOYED_SHA="$TARGET_SHA"
  fail "current release health failed"
' _ "$repo_root" 2>/dev/null; then
  printf 'current-release failure was expected to exit non-zero\n' >&2
  exit 1
fi
grep -Fq 'status="error"' "$tmp_dir/app/infra/monitoring/node-exporter-textfile/velora-deploy.prom"
grep -Fq 'reason="current release health failed"' "$tmp_dir/app/infra/monitoring/node-exporter-textfile/velora-deploy.prom"

if VELORA_APP_DIR="$tmp_dir/app" VELORA_STATE_DIR="$tmp_dir/state" "$BASH" -c '
  source "$1/scripts/deploy/velora-deploy-core"
  TARGET_SHA=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa
  LAST_DEPLOYED_SHA=bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb
  publish_deployment_metrics pending
  false
' _ "$repo_root" 2>/dev/null; then
  printf 'raw command was expected to exit non-zero\n' >&2
  exit 1
fi
grep -Fq 'status="error"' "$tmp_dir/app/infra/monitoring/node-exporter-textfile/velora-deploy.prom"
grep -Fq 'reason="Deployment command failed at line' "$tmp_dir/app/infra/monitoring/node-exporter-textfile/velora-deploy.prom"

VELORA_APP_DIR="$tmp_dir/app" VELORA_STATE_DIR="$tmp_dir/state" "$BASH" -c '
  source "$1/scripts/deploy/velora-deploy-core"
  docker() {
    [[ "$1 $2 $3" == "compose ps -q" ]] && printf "container-id\n" || printf "starting\n"
  }
  sleep() { :; }
  if wait_for_docker_health; then
    printf "starting Docker health was expected to fail\n" >&2
    exit 1
  fi
  [[ "$DEPLOYMENT_FAILURE_DETAIL" == "rabbitmq Docker health remained starting." ]]
' _ "$repo_root"

VELORA_APP_DIR="$tmp_dir/app" VELORA_STATE_DIR="$tmp_dir/state" "$BASH" -c '
  source "$1/scripts/deploy/velora-deploy-core"
  rabbitmq_queue_consumers() { return 1; }
  if check_rabbitmq_consumers; then
    printf "RabbitMQ command failure was expected\n" >&2
    exit 1
  fi
  [[ "$DEPLOYMENT_FAILURE_DETAIL" == "RabbitMQ queue readiness command failed." ]]
' _ "$repo_root"

VELORA_HTTP_ATTEMPTS=1 VELORA_HTTP_RETRY_SECONDS=0 \
  VELORA_APP_DIR="$tmp_dir/app" VELORA_STATE_DIR="$tmp_dir/state" "$BASH" -c '
  source "$1/scripts/deploy/velora-deploy-core"
  docker() {
    case "$*" in
      "compose config --services") printf "reel-indexing-long-service\n" ;;
      "compose ps --status running -q reel-indexing-long-service") : ;;
      "compose ps -aq reel-indexing-long-service") printf "container-id\n" ;;
      "inspect --format {{.State.Status}} container-id") printf "restarting\n" ;;
      "inspect --format {{.State.ExitCode}} container-id") printf "1\n" ;;
      "compose ps") : ;;
      *) return 1 ;;
    esac
  }
  sleep() { :; }
  if wait_for_running_services; then
    printf "non-running service was expected to fail\n" >&2
    exit 1
  fi
  [[ "$DEPLOYMENT_FAILURE_DETAIL" == *"reel-indexing-long-service(state=restarting,exit=1)"* ]]
' _ "$repo_root"

mkdir -p "$tmp_dir/launcher-app/.git" "$tmp_dir/launcher-state"
if VELORA_APP_DIR="$tmp_dir/launcher-app" VELORA_STATE_DIR="$tmp_dir/launcher-state" VELORA_DEPLOY_REMOTE=missing \
  "$BASH" "$repo_root/scripts/deploy/velora-deploy-launcher" 2>/dev/null; then
  printf 'launcher failure was expected to exit non-zero\n' >&2
  exit 1
fi
grep -Fq 'status="error"' "$tmp_dir/launcher-app/infra/monitoring/node-exporter-textfile/velora-deploy.prom"
grep -Fq 'reason="Launcher command failed at line' "$tmp_dir/launcher-app/infra/monitoring/node-exporter-textfile/velora-deploy.prom"
grep -Fq 'if "$controller" "$@"; then' "$repo_root/scripts/deploy/velora-deploy-launcher"

printf 'deployment metrics: PASS\n'
