#!/usr/bin/env bash
# Daily logical backups of the Mongo and PostgreSQL data, taken from the REPLICAS on
# velora-node-2, so the homelab primaries carry no extra load and the copies live on
# another machine. Run by velora-backup.timer; see README.md.
set -Eeuo pipefail

ROOT="${BACKUP_ROOT:-/opt/velora/backups}"
KEEP="${BACKUP_KEEP:-7}"
ENV_FILE="${ENV_FILE:-/opt/velora/backup-worker/.env}"
PG_CONTAINER="${PG_CONTAINER:-postgres-replica}"
MONGO_CONTAINER="${MONGO_CONTAINER:-mongo-replica}"
PG_DATABASES="${PG_DATABASES:-notification call}"

if [[ -f "$ENV_FILE" ]]; then
  set -a
  # shellcheck disable=SC1090
  . "$ENV_FILE"
  set +a
fi
: "${MONGO_DUMP_URI:?MONGO_DUMP_URI must be set in $ENV_FILE}"

umask 077
stamp="$(date -u +%Y%m%dT%H%M%SZ)"
work="$ROOT/$stamp.partial"
final="$ROOT/$stamp"
mkdir -p "$work"

log() { printf '%s %s\n' "$(date -u +%FT%TZ)" "$*" | tee -a "$work/backup.log" >&2; }
write_status() {
  printf '{"result":"%s","stamp":"%s","finished":"%s","detail":"%s"}\n' \
    "$1" "$stamp" "$(date -u +%FT%TZ)" "$2" >"$ROOT/status.json"
}
die() {
  log "FAILED: $1; the previous backups are untouched"
  write_status failed "$1"
  rm -rf "$work.failed"
  mv "$work" "$work.failed" 2>/dev/null || true
  exit 1
}
trap 'die "unexpected error at line $LINENO"' ERR

log "backup $stamp started (keep $KEEP)"

# --- PostgreSQL, from the hot standby
in_recovery="$(docker exec "$PG_CONTAINER" psql -U postgres -At -c 'select pg_is_in_recovery()')"
[[ "$in_recovery" == "t" ]] || die "the Postgres container is not a standby; refusing to back it up"
docker exec "$PG_CONTAINER" pg_dumpall -U postgres --globals-only >"$work/postgres-globals.sql"
for db in $PG_DATABASES; do
  log "pg_dump $db"
  docker exec "$PG_CONTAINER" pg_dump -U postgres -Fc "$db" >"$work/postgres-$db.dump"
  entries="$(docker exec -i "$PG_CONTAINER" pg_restore --list <"$work/postgres-$db.dump" | grep -c .)"
  [[ "$entries" -gt 10 ]] || die "postgres-$db.dump looks empty ($entries entries)"
  log "postgres-$db.dump ok: $entries entries, $(du -h "$work/postgres-$db.dump" | cut -f1)"
done

# --- MongoDB, from the secondary (credentials come through stdin, not argv)
log "mongodump conversation_db from the secondary"
printf 'uri: "%s"\n' "$MONGO_DUMP_URI" |
  docker exec -i "$MONGO_CONTAINER" mongodump --config=/dev/stdin --readPreference=secondary \
    --archive --gzip 2>"$work/mongodump.log" >"$work/mongo-conversation_db.archive.gz"
gzip -t "$work/mongo-conversation_db.archive.gz"
docs="$(grep -o 'done dumping [^ ]* ([0-9]* documents)' "$work/mongodump.log" | tr '\n' ';')"
[[ -n "$docs" ]] || die "mongodump reported no collections"
log "mongo archive ok: $(du -h "$work/mongo-conversation_db.archive.gz" | cut -f1); $docs"

# --- publish, then prune (only after a fully successful run)
mv "$work" "$final"
work="$final"
ls -1d "$ROOT"/20* 2>/dev/null | grep -v -E '\.(partial|failed)$' | sort -r | tail -n +"$((KEEP + 1))" | xargs -r rm -rf
rm -rf "$ROOT"/*.failed 2>/dev/null || true
write_status ok "$(du -sh "$final" | cut -f1) in $final"
log "backup $stamp finished: $(du -sh "$final" | cut -f1); kept $(ls -1d "$ROOT"/20* | wc -l) backups"
