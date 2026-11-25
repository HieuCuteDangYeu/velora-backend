#!/usr/bin/env bash
# Paired PostgreSQL + Qdrant backup for the Reel Indexing vector pair.
# Host-side driver (docker CLI, ssh): drains index writers, takes a pg_dump and a Qdrant
# snapshot under one pair ID, resumes writers, encrypts and copies both off-host, verifies
# readback. Runbook: infra/qdrant/PAIR-BACKUP.md. Works on macOS bash 3.2 and Linux.
#
#   pair-backup.sh <config-file> [--dry-run] [--pause-writers]
#   pair-backup.sh <config-file> --ops <script.cjs> [args...]   (run one operator CLI)
#
# --dry-run   only check that writers are quiet and print the SQL facts; nothing is written
#             off-host and no writer is touched.
# default     no pause. Writers must be quiet at the start and the projection fingerprint fence
#             (before dump, after dump, after snapshot) rejects a pair that moved meanwhile.
# --pause-writers  signal both indexers first. Measured 2026-11-25: SIGUSR2 also triggers Nest's
#             shutdown hook, so the whole process exits, query RPC (semantic search) included,
#             and the container did not restart on its own. Search is down until resume.
set -euo pipefail
umask 077

CONFIG="${1:?usage: pair-backup.sh <config-file> [--dry-run] [--pause-writers]}"
shift || true
DRY_RUN=false
PAUSE=false
OPS_ONLY=false
if [ "${1:-}" = "--ops" ]; then
  OPS_ONLY=true
  shift
else
  for flag in "$@"; do
    case "$flag" in
      --dry-run) DRY_RUN=true ;;
      --pause-writers) PAUSE=true ;;
      *) echo "unknown option: $flag" >&2; exit 64 ;;
    esac
  done
fi
# shellcheck disable=SC1090
. "$CONFIG"
: "${REPO_DIR:?}" "${OPS_IMAGE:?}" "${ENV_FILE:?}" "${SECRETS_DIR:?}" "${WORK_DIR:?}"
: "${PG_CONTAINER:?}" "${PG_USER:?}" "${PG_DB:?}" "${INDEXER_CONTAINERS:?}"
: "${NET_SQL:?}" "${NET_VECTOR:?}" "${R2_PREFIX:?}"
if [ -n "${OFFSITE_SSH:-}" ]; then : "${OFFSITE_DIR:?OFFSITE_DIR is required with OFFSITE_SSH}"; fi
SSH_OPTS="${SSH_OPTS:--o BatchMode=yes -o ConnectTimeout=20}"
DRAIN_TIMEOUT="${DRAIN_TIMEOUT:-150}"
KEEP_PLAINTEXT="${KEEP_PLAINTEXT:-false}"
QDRANT_COLLECTION="${QDRANT_COLLECTION:-velora_reel_bge_m3_1024_v1}"
export PATH="$PATH:/usr/local/bin"

log() { printf '%s %s\n' "$(date -u +%FT%TZ)" "$*" >&2; }
sha256_file() { if command -v sha256sum >/dev/null 2>&1; then sha256sum "$1" | cut -d' ' -f1; else shasum -a 256 "$1" | cut -d' ' -f1; fi; }
now_s() { date +%s; }

mkdir -p "$WORK_DIR/archives"
ENV_TMP="$(mktemp "${TMPDIR:-/tmp}/pair-backup-env.XXXXXX")"
DRAINED=false
RESUMED=false
cleanup() {
  rm -f "$ENV_TMP"
  if [ "$DRAINED" = true ] && [ "$RESUMED" = false ]; then
    log "resuming writers after failure"
    resume_writers || log "WARNING: writers did not resume; restart them by hand"
  fi
}
trap cleanup EXIT

# Only the variables the operator container needs, never the whole .env.
for key in REEL_INDEXING_DATABASE_URL QDRANT_COLLECTION AI_EMBEDDING_MODEL AI_EMBEDDING_DIMENSIONS \
  AI_EMBEDDING_VERSION INDEX_VECTOR_SEARCH_BACKEND INDEX_VECTOR_PROJECTION_ENABLED \
  INDEX_VECTOR_PUBLICATION_REQUIRED R2_ACCOUNT_ID R2_BUCKET_NAME R2_ACCESS_KEY_ID R2_SECRET_ACCESS_KEY; do
  grep -E "^${key}=" "$ENV_FILE" | tail -n 1 >>"$ENV_TMP" || true
done
{
  echo "QDRANT_URL=https://qdrant:6333"
  echo "QDRANT_API_KEY_FILE=/run/secrets/qdrant_api_key"
  echo "NODE_EXTRA_CA_CERTS=/run/secrets/qdrant_tls_ca"
  grep -q '^QDRANT_COLLECTION=' "$ENV_TMP" || echo "QDRANT_COLLECTION=$QDRANT_COLLECTION"
} >>"$ENV_TMP"

# One-shot operator container on the SQL network with the vector network attached, no ports.
ops() {
  local name="pairops-$$-$RANDOM" rc=0
  docker create --name "$name" --network "$NET_SQL" --env-file "$ENV_TMP" \
    -v "$SECRETS_DIR/api-key:/run/secrets/qdrant_api_key:ro" \
    -v "$SECRETS_DIR/ca.crt:/run/secrets/qdrant_tls_ca:ro" \
    -v "$SECRETS_DIR/backup-key:/run/secrets/qdrant_backup_key:ro" \
    -v "$WORK_DIR:/work" \
    -v "$REPO_DIR/scripts/ops:/usr/src/app/scripts/ops:ro" \
    --entrypoint node "$OPS_IMAGE" "$@" >/dev/null
  docker network connect "$NET_VECTOR" "$name"
  docker start -a "$name" </dev/null || rc=$?
  docker rm "$name" >/dev/null 2>&1 || true
  return "$rc"
}

# PID 1 in the indexer image is `sh -c "prisma migrate deploy && node ..."`, which swallows
# `docker kill -s USR2`; the signal must reach the node process itself.
signal_node() {
  docker exec "$1" sh -c 'n=0; for d in /proc/[0-9]*; do
      c=$(tr "\0" " " <"$d/cmdline" 2>/dev/null)
      case "$c" in "node dist/apps/reel-indexing-service/main.js"*) kill -USR2 "${d#/proc/}" && n=$((n + 1)) ;; esac
    done; [ "$n" -eq 1 ]' </dev/null
}
drain_writers() {
  local c start settled
  for c in $INDEXER_CONTAINERS; do
    start="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
    signal_node "$c" || { log "could not signal the node process in $c"; return 1; }
    DRAINED=true
    settled=false
    local deadline=$(( $(now_s) + DRAIN_TIMEOUT ))
    while [ "$(now_s)" -lt "$deadline" ]; do
      if docker logs --since "$start" "$c" 2>&1 | grep -q '"event":"index_job_drain","settled":true' \
        || [ "$(docker inspect -f '{{.State.Running}}' "$c")" = false ]; then settled=true; break; fi
      sleep 2
    done
    [ "$settled" = true ] || { log "drain of $c did not settle in ${DRAIN_TIMEOUT}s"; return 1; }
    log "drained $c"
  done
}
# Consumption resumes only through a process restart (infra/qdrant/README.md); the SHORT
# container also serves query RPC, so searches see a short gap while it restarts.
resume_writers() {
  local c
  for c in $INDEXER_CONTAINERS; do
    if [ "$(docker inspect -f '{{.State.Running}}' "$c")" = true ]; then docker restart "$c" >/dev/null; else docker start "$c" >/dev/null; fi
    log "resumed $c"
  done
  RESUMED=true
}

if [ "$OPS_ONLY" = true ]; then
  script="$1"; shift
  ops "/usr/src/app/scripts/ops/$script" "$@"
  exit $?
fi

PAIR_DIR=""
STARTED_S="$(now_s)"
log "pair backup starting (dry-run=$DRY_RUN pause-writers=$PAUSE)"

if [ "$DRY_RUN" = true ]; then
  ops /usr/src/app/scripts/ops/pair-backup.cjs quiesce --dir="/work" || { log "writers are not quiet"; exit 2; }
  exit 0
fi

if [ "$PAUSE" = true ]; then
  PAUSE_START_S="$(now_s)"
  drain_writers
fi

# begin.json carries the pair ID; its directory name is the pair ID too.
BEGIN_TMP="pair-pending-$$"
mkdir -p "$WORK_DIR/$BEGIN_TMP"
if ! ops /usr/src/app/scripts/ops/pair-backup.cjs begin --dir="/work/$BEGIN_TMP" >"$WORK_DIR/$BEGIN_TMP/begin.out"; then
  log "writers are not quiet or begin failed: $(cat "$WORK_DIR/$BEGIN_TMP/begin.out" 2>/dev/null | head -c 600)"
  exit 2
fi
PAIR_ID="$(sed -E 's/.*"pairId":"([a-f0-9-]{36})".*/\1/' "$WORK_DIR/$BEGIN_TMP/begin.out" | head -n 1)"
case "$PAIR_ID" in ????????-????-????-????-????????????) ;; *) log "no pair ID in begin output"; exit 1 ;; esac
PAIR_DIR="$WORK_DIR/pair-$PAIR_ID"
mv "$WORK_DIR/$BEGIN_TMP" "$PAIR_DIR"
log "pair $PAIR_ID"

# 1. PostgreSQL dump (custom format, owners kept so restore needs the same two roles).
DUMP_START_S="$(now_s)"
docker exec -i "$PG_CONTAINER" pg_dump -U "$PG_USER" -d "$PG_DB" -Fc >"$PAIR_DIR/reel-indexing.dump" </dev/null
ENTRIES="$(docker exec -i "$PG_CONTAINER" pg_restore --list <"$PAIR_DIR/reel-indexing.dump" | grep -c . || true)"
[ "$ENTRIES" -gt 50 ] || { log "dump looks empty ($ENTRIES TOC entries)"; exit 1; }
DUMP_BYTES="$(wc -c <"$PAIR_DIR/reel-indexing.dump" | tr -d ' ')"
log "pg_dump done: ${DUMP_BYTES} bytes, ${ENTRIES} TOC entries, $(( $(now_s) - DUMP_START_S ))s"

# 2. Proof binds the dump hash and WAL position to the unchanged SQL state.
ops /usr/src/app/scripts/ops/pair-backup.cjs proof --dir="/work/pair-$PAIR_ID" >"$PAIR_DIR/proof.out"

# 3. Qdrant snapshot under the same proof. The marker appears once the snapshot is taken and
#    the fence re-checked, so writers can resume while encryption and upload continue.
SNAP_START_S="$(now_s)"
ops /usr/src/app/scripts/ops/qdrant-backup.cjs backup \
  --target-label=reel-indexing --confirm=QDRANT_reel-indexing \
  --directory=/work/archives --offhost-r-prefix="$R2_PREFIX" \
  --offhost-proof=VERIFIED_R2_BUCKET_ACCESS \
  --sql-backup-proof="/work/pair-$PAIR_ID/sql-proof.json" \
  --encryption-key-file=/run/secrets/qdrant_backup_key \
  --require-pair=true --snapshot-taken-marker="/work/pair-$PAIR_ID/snapshot-taken.json" \
  >"$PAIR_DIR/qdrant-result.json" &
BACKUP_PID=$!
while [ ! -e "$PAIR_DIR/snapshot-taken.json" ] && kill -0 "$BACKUP_PID" 2>/dev/null; do sleep 1; done
if [ "$PAUSE" = true ]; then
  [ -e "$PAIR_DIR/snapshot-taken.json" ] || { wait "$BACKUP_PID" || true; log "snapshot was not taken"; exit 1; }
  resume_writers
  PAUSE_S=$(( $(now_s) - PAUSE_START_S ))
  log "writers paused for ${PAUSE_S}s"
fi
wait "$BACKUP_PID" || { log "qdrant backup failed: $(head -c 600 "$PAIR_DIR/qdrant-result.json")"; exit 1; }
log "qdrant backup done in $(( $(now_s) - SNAP_START_S ))s"

# 4. Encrypt the dump, publish dump + manifest to R2 with readback verification.
ops /usr/src/app/scripts/ops/pair-backup.cjs finish --dir="/work/pair-$PAIR_ID" \
  --offhost-r-prefix="$R2_PREFIX" --encryption-key-file=/run/secrets/qdrant_backup_key \
  >"$PAIR_DIR/finish.out"

# 5. Second off-site copy (velora-node-2) over ssh, verified by remote sha256.
OFFSITE_RESULT="skipped"
if [ -n "${OFFSITE_SSH:-}" ]; then
  ARCHIVE_NAME="$(sed -E 's/.*"name":"(velora-qdrant-[^"]+\.vqb)".*/\1/' "$PAIR_DIR/qdrant-result.json" | head -n 1)"
  SSH_OPTS="$SSH_OPTS" bash "$(dirname "$0")/pair-offsite-copy.sh" "$OFFSITE_SSH" "$OFFSITE_DIR/$PAIR_ID" \
    "$PAIR_DIR/reel-indexing-$PAIR_ID.vqd" "$WORK_DIR/archives/$ARCHIVE_NAME" "$PAIR_DIR/pair-manifest.json" >&2
  OFFSITE_RESULT="verified"
  log "off-site copy verified on $OFFSITE_SSH"
else
  log "off-site (node-2) copy NOT configured; only R2 holds the pair"
fi

# 6. Prove the R2 copy is decryptable and matches the pair manifest (readback).
VERIFY_DIR="/work/pair-$PAIR_ID/readback"
ops /usr/src/app/scripts/ops/pair-backup.cjs fetch --dir="$VERIFY_DIR" --pair-id="$PAIR_ID" \
  --offhost-r-prefix="$R2_PREFIX" --encryption-key-file=/run/secrets/qdrant_backup_key >"$PAIR_DIR/verify.out"
rm -rf "$PAIR_DIR/readback"
if [ "$KEEP_PLAINTEXT" != true ]; then rm -f "$PAIR_DIR/reel-indexing.dump"; fi

log "pair $PAIR_ID complete in $(( $(now_s) - STARTED_S ))s; off-site=$OFFSITE_RESULT; dir=$PAIR_DIR"
printf '{"pairId":"%s","seconds":%s,"pausedSeconds":%s,"offsite":"%s","dir":"%s"}\n' \
  "$PAIR_ID" "$(( $(now_s) - STARTED_S ))" "${PAUSE_S:-0}" "$OFFSITE_RESULT" "$PAIR_DIR"
