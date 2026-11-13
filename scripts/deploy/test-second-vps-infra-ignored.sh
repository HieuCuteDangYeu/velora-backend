#!/usr/bin/env bash
# Files that describe the second VPS (velora-node-2) must not make the homelab CD
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
  infra/grafana-node/provisioning/datasources/loki.yml; do
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

echo "second VPS infra files are ignored by the homelab CD"
