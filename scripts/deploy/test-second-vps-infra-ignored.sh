#!/usr/bin/env bash
# Files that describe the other servers (velora-node-2, the Windows laptop) must not make the homelab CD
# restart anything, while a genuinely unknown path must still reconcile every
# application service.
set -Eeuo pipefail

repo_root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd)"
source "$repo_root/scripts/deploy/velora-deploy-core"

tmp_dir="$(mktemp -d)"
trap 'rm -rf -- "$tmp_dir"' EXIT

plan_for() {
  CHANGED_FILES="$1"
  PULL_SERVICES=()
  RECONCILE_SERVICES=()
  INFRA_RECONCILE_SERVICES=()
  FORCE=false
  plan_from_changed_files 2>"$tmp_dir/stderr"
}

for file in \
  infra/mongo-replica/compose.yaml \
  infra/mongo-replica/README.md \
  infra/postgres-replica/compose.yaml \
  infra/call-media-node/compose.yaml \
  infra/call-media-node/README.md \
  infra/friend-mail-node/compose.yaml \
  infra/friend-mail-node/deploy.sh \
  infra/friend-mail-node/README.md \
  infra/langfuse-node/docker-compose.yml \
  infra/langfuse-node/node2.yaml \
  infra/langfuse-node/README.md \
  infra/vps-agent/compose.yaml \
  infra/vps-agent/alloy.config \
  infra/vps-agent/README.md \
  infra/backup-worker/backup.sh \
  infra/backup-worker/velora-backup.service \
  infra/backup-worker/velora-backup.timer \
  infra/backup-worker/README.md \
  infra/grafana-node/compose.yaml \
  infra/grafana-node/README.md \
  infra/grafana-node/provisioning/datasources/prometheus.yml \
  infra/grafana-node/provisioning/datasources/loki.yml \
  infra/loki-node/compose.yaml \
  infra/loki-node/loki-config.yml \
  infra/loki-node/README.md \
  infra/windows-node/README.md \
  infra/windows-node/mongo-replica.compose.yaml \
  infra/windows-node/postgres-replica.compose.yaml \
  infra/windows-node/vps-agent.override.yaml \
  infra/windows-node/wslconfig.example \
  scripts/ops/CHAT-STRESS-FIXTURES.md \
  scripts/ops/seed-chat-stress-users.cjs \
  scripts/ops/prepare-chat-stress-rooms.cjs \
  scripts/ops/prepare-chat-stress-rooms.test.cjs \
  scripts/ops/generate-chat-stress-scale-fixtures.cjs \
  scripts/ops/generate-chat-stress-scale-fixtures.test.cjs \
  scripts/ops/purge-chat-stress-data.cjs \
  scripts/ops/purge-chat-stress-data.test.cjs; do
  plan_for "$file"
  if ((${#PULL_SERVICES[@]} + ${#RECONCILE_SERVICES[@]} + ${#INFRA_RECONCILE_SERVICES[@]} != 0)); then
    echo "FAIL: $file must not schedule any service" >&2
    exit 1
  fi
  if grep -q 'unknown tracked change' "$tmp_dir/stderr"; then
    echo "FAIL: $file is reported as an unknown tracked change" >&2
    exit 1
  fi
done

# The safety net stays: an unrecognised path reconciles every application service.
plan_for infra/something-new/run.sh
if ((${#RECONCILE_SERVICES[@]} == 0)) || ! grep -q 'unknown tracked change' "$tmp_dir/stderr"; then
  echo "FAIL: an unknown infra path must still reconcile the application services" >&2
  exit 1
fi

echo "second VPS infra files and operator fixture tools are ignored by the homelab CD"
