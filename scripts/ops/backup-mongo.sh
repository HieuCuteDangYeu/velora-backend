#!/usr/bin/env bash
# Daily logical backup of the self-hosted MongoDB (conversation_db).
# Streams a gzip archive from the mongo container to BACKUP_DIR and keeps the
# newest KEEP archives. Restore with:
#   docker exec -i <mongo> sh -c 'mongorestore -u "$MONGO_INITDB_ROOT_USERNAME" -p "$MONGO_INITDB_ROOT_PASSWORD" --authenticationDatabase admin --archive --gzip --drop' < archive.gz
set -euo pipefail
export PATH="/opt/homebrew/bin:/usr/local/bin:$PATH"

CONTAINER="${MONGO_CONTAINER:-microservices-boilerplate-mongo-1}"
BACKUP_DIR="${BACKUP_DIR:-$HOME/backups/mongo}"
KEEP="${KEEP:-7}"
DB_NAME="${DB_NAME:-conversation_db}"

umask 077
mkdir -p "$BACKUP_DIR"
stamp="$(date -u +%Y%m%dT%H%M%SZ)"
target="$BACKUP_DIR/${DB_NAME}-${stamp}.archive.gz"
tmp="${target}.partial"
trap 'rm -f "$tmp"' EXIT

docker exec "$CONTAINER" sh -c \
  "mongodump -u \"\$MONGO_INITDB_ROOT_USERNAME\" -p \"\$MONGO_INITDB_ROOT_PASSWORD\" --authenticationDatabase admin --db \"$DB_NAME\" --archive --gzip" \
  > "$tmp"

gzip -t "$tmp"
[ "$(wc -c < "$tmp")" -gt 1024 ] || { echo "backup suspiciously small" >&2; exit 1; }
mv "$tmp" "$target"
trap - EXIT

# Retention: keep the newest $KEEP archives.
ls -1t "$BACKUP_DIR"/${DB_NAME}-*.archive.gz | tail -n +"$((KEEP + 1))" | xargs -I{} rm -f {}
echo "backup ok: $target ($(wc -c < "$target") bytes)"
