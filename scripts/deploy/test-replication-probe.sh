#!/usr/bin/env bash
set -Eeuo pipefail

repo_root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd)"
script="$repo_root/scripts/deploy/replication-probe"
tmp="$(mktemp -d)"
trap 'rm -rf -- "$tmp"' EXIT
mkdir -p "$tmp/bin" "$tmp/out" "$tmp/sec"
printf 'not-a-real-key\n' >"$tmp/sec/api-key"
printf 'not-a-real-ca\n' >"$tmp/sec/ca.crt"

# docker stand-in. `docker run` prints $QDRANT_OUT (the in-container script's output) and
# records its arguments; `docker exec` prints $PG_ROW or fails when PG_FAIL=1.
cat >"$tmp/bin/docker" <<'SHIM'
#!/usr/bin/env bash
case "$1" in
  run)
    printf '%s\n' "$*" >>"$ARGS_LOG"
    [[ "${QDRANT_FAIL:-0}" == 1 ]] && exit 125
    printf '%s\n' "${QDRANT_OUT:-}"
    ;;
  exec)
    printf '%s\n' "$*" >>"$ARGS_LOG"
    [[ "${PG_FAIL:-0}" == 1 ]] && { echo 'psql: error: role does not exist' >&2; exit 2; }
    printf '%s\n' "${PG_ROW:-}"
    ;;
esac
SHIM
chmod +x "$tmp/bin/docker"

HEALTHY_QDRANT='h1 up 1
h1 cluster_peers_total 3
h1 collection_active_replicas_min 2
h1 collection_dead_replicas 0
h2 up 1
h2 cluster_peers_total 3
h2 collection_active_replicas_min 2
h2 collection_dead_replicas 0
laptop up 1
laptop cluster_peers_total 3
laptop collection_active_replicas_min 2
laptop collection_dead_replicas 0
probe-ok'

failures=0
fail() { printf 'FAIL: %s\n' "$*" >&2; failures=$((failures + 1)); }
run() {
  rm -f "$tmp/out"/* "$tmp/args"
  ARGS_LOG="$tmp/args" PATH="$tmp/bin:$PATH" VELORA_REPLICATION_METRICS_DIR="$tmp/out" QDRANT_SECRETS_DIR="$tmp/sec" \
    "$script" || fail "probe must always exit 0"
}
file="$tmp/out/velora-replication.prom"
metric() { grep -E "^$1 " "$file" | head -n1 | awk '{print $NF}'; }
has() { grep -qE "^$1 " "$file"; }

QDRANT_OUT="$HEALTHY_QDRANT" PG_ROW='1 1 720 1 0.029379 720' run
[[ "$(metric 'velora_replication_probe_success\{check="qdrant"\}')" == 1 ]] || fail "qdrant check ran"
[[ "$(metric 'velora_replication_probe_success\{check="indexing_standby"\}')" == 1 ]] || fail "standby check ran"
[[ "$(metric 'velora_qdrant_node_up\{node="laptop"\}')" == 1 ]] || fail "laptop up"
[[ "$(metric 'velora_qdrant_node_peers\{node="h2"\}')" == 3 ]] || fail "h2 peers"
[[ "$(metric 'velora_qdrant_node_active_replicas_min\{node="h1"\}')" == 2 ]] || fail "h1 active replicas"
[[ "$(metric 'velora_qdrant_node_dead_replicas\{node="laptop"\}')" == 0 ]] || fail "laptop dead replicas"
[[ "$(metric 'velora_indexing_standby_streaming\{slot="idx_standby"\}')" == 1 ]] || fail "streaming"
[[ "$(metric 'velora_indexing_standby_replay_lag_seconds\{slot="idx_standby"\}')" == 0.029379 ]] || fail "replay lag seconds"
[[ "$(metric 'velora_indexing_replication_slot_retained_wal_bytes\{slot="idx_standby"\}')" == 720 ]] || fail "retained bytes"
[[ "$(metric velora_replication_probe_timestamp_seconds)" -gt 1700000000 ]] || fail "timestamp"
perm="$(stat -c %a "$file" 2>/dev/null || stat -f %Lp "$file")"
[[ "$perm" == 644 ]] || fail "file must be world-readable for node-exporter"
# Each family's samples are contiguous and every TYPE appears once.
[[ -z "$(grep '^# TYPE' "$file" | sort | uniq -d)" ]] || fail "duplicate TYPE lines"
[[ "$(grep -v '^#' "$file" | sed -E 's/[{ ].*//' | uniq | sort | uniq -d)" == "" ]] || fail "a metric family is split"
# The API key never appears in an argument list; the curl container reads it from a file mount.
! grep -q 'not-a-real-key' "$tmp/args" || fail "api key leaked into arguments"
grep -q -- '-H @/tmp/h' "$tmp/args" || fail "curl reads the header from a file"
grep -q -- "-U velora_monitor" "$tmp/args" || fail "psql uses the monitoring role"

# A node that does not answer is up 0 and reports nothing else.
QDRANT_OUT="$(printf '%s\n' "$HEALTHY_QDRANT" | grep -v '^laptop' | sed 's/^probe-ok$/laptop up 0\nprobe-ok/')" PG_ROW='1 1 720 1 0 0' run
[[ "$(metric 'velora_qdrant_node_up\{node="laptop"\}')" == 0 ]] || fail "laptop down"
! has 'velora_qdrant_node_peers\{node="laptop"\}' || fail "no peers sample for a down node"

# A replica that is not Active, and a missing peer.
QDRANT_OUT="$(printf '%s\n' "$HEALTHY_QDRANT" | sed -e 's/^h1 collection_active_replicas_min 2/h1 collection_active_replicas_min 1/' -e 's/^h1 collection_dead_replicas 0/h1 collection_dead_replicas 1/' -e 's/^h2 cluster_peers_total 3/h2 cluster_peers_total 2/')" PG_ROW='1 1 720 1 0 0' run
[[ "$(metric 'velora_qdrant_node_active_replicas_min\{node="h1"\}')" == 1 ]] || fail "active replicas 1"
[[ "$(metric 'velora_qdrant_node_dead_replicas\{node="h1"\}')" == 1 ]] || fail "dead replica"
[[ "$(metric 'velora_qdrant_node_peers\{node="h2"\}')" == 2 ]] || fail "two peers"

# Garbage from the container is ignored; no probe-ok means the Qdrant check failed.
QDRANT_OUT=$'h1 up 1\nh1 cluster_peers_total 3' PG_ROW='1 1 720 1 0 0' run
[[ "$(metric 'velora_replication_probe_success\{check="qdrant"\}')" == 0 ]] || fail "truncated output is a failed check"
! has 'velora_qdrant_node_up' || fail "no node samples from a failed check"
QDRANT_OUT=$'h1 up 1\nevil} 1\nh1 cluster_peers_total x\nprobe-ok' PG_ROW='1 1 720 1 0 0' run
! grep -q 'evil' "$file" || fail "unknown lines are dropped"
! has 'velora_qdrant_node_peers\{node="h1"\}' || fail "non-numeric values are dropped"
QDRANT_FAIL=1 PG_ROW='1 1 720 1 0 0' run
[[ "$(metric 'velora_replication_probe_success\{check="qdrant"\}')" == 0 ]] || fail "docker run failure is a failed check"
[[ "$(metric 'velora_replication_probe_success\{check="indexing_standby"\}')" == 1 ]] || fail "standby check is independent"

# Standby not streaming: no lag samples; slot keeps WAL.
QDRANT_OUT="$HEALTHY_QDRANT" PG_ROW='1 0 2147483648 0 0 0' run
[[ "$(metric 'velora_indexing_standby_streaming\{slot="idx_standby"\}')" == 0 ]] || fail "not streaming"
[[ "$(metric 'velora_indexing_replication_slot_active\{slot="idx_standby"\}')" == 0 ]] || fail "slot inactive"
[[ "$(metric 'velora_indexing_replication_slot_retained_wal_bytes\{slot="idx_standby"\}')" == 2147483648 ]] || fail "retained 2 GiB"
! has 'velora_indexing_standby_replay_lag_seconds' || fail "no lag sample while not streaming"

# Slot missing; psql failure; malformed row.
QDRANT_OUT="$HEALTHY_QDRANT" PG_ROW='0 0 0 0 0 0' run
[[ "$(metric 'velora_indexing_replication_slot_present\{slot="idx_standby"\}')" == 0 ]] || fail "slot missing"
QDRANT_OUT="$HEALTHY_QDRANT" PG_FAIL=1 run
[[ "$(metric 'velora_replication_probe_success\{check="indexing_standby"\}')" == 0 ]] || fail "psql failure is a failed check"
! has 'velora_indexing_standby_streaming' || fail "no standby samples from a failed check"
QDRANT_OUT="$HEALTHY_QDRANT" PG_ROW='1 1 abc 1 0 0' run
[[ "$(metric 'velora_replication_probe_success\{check="indexing_standby"\}')" == 0 ]] || fail "malformed row is a failed check"

# Never leaves partial files; does nothing without the directory or with bad settings.
[[ "$(find "$tmp/out" -type f | wc -l | tr -d ' ')" == 1 ]] || fail "only the final file may remain"
ARGS_LOG="$tmp/args" VELORA_REPLICATION_METRICS_DIR="$tmp/missing" PATH="$tmp/bin:$PATH" "$script" || fail "missing directory must not error"
rm -f "$tmp/out"/*
ARGS_LOG="$tmp/args" INDEXING_STANDBY_SLOT="x'; drop" VELORA_REPLICATION_METRICS_DIR="$tmp/out" PATH="$tmp/bin:$PATH" "$script" || fail "bad slot must not error"
[[ -z "$(ls "$tmp/out")" ]] || fail "bad slot name writes nothing"

if ((failures > 0)); then printf '%d check(s) failed\n' "$failures" >&2; exit 1; fi
printf 'replication-probe: all checks passed\n'
