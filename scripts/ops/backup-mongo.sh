#!/usr/bin/env bash
# Daily logical backup of the self-hosted MongoDB (conversation_db).
# conversation_db is sharded (infra/mongo-shard/README.md), so the dump runs
# through the router (mongos) and covers every shard; a dump from the `mongo`
# container would only hold shard 1's half. Root credentials are read from the
# mongo container's environment and passed on stdin, never on argv.
# Streams a gzip archive to BACKUP_DIR and keeps the newest KEEP archives.
# Restore into a cluster through mongos, or into a plain replica set, with:
#   mongorestore --archive --gzip --drop < archive.gz   (plus credentials)
set -euo pipefail
export PATH="/opt/homebrew/bin:/usr/local/bin:$PATH"

ROUTER="${MONGO_ROUTER_CONTAINER:-mongos}"
CRED_CONTAINER="${MONGO_CONTAINER:-microservices-boilerplate-mongo-1}"
BACKUP_DIR="${BACKUP_DIR:-$HOME/backups/mongo}"
KEEP="${KEEP:-7}"
DB_NAME="${DB_NAME:-conversation_db}"

umask 077
mkdir -p "$BACKUP_DIR"
stamp="$(date -u +%Y%m%dT%H%M%SZ)"
target="$BACKUP_DIR/${DB_NAME}-${stamp}.archive.gz"
tmp="${target}.partial"
trap 'rm -f "$tmp"' EXIT

user="$(docker exec "$CRED_CONTAINER" printenv MONGO_INITDB_ROOT_USERNAME)"
password="$(docker exec "$CRED_CONTAINER" printenv MONGO_INITDB_ROOT_PASSWORD)"
printf 'password: "%s"\n' "$password" |
  docker exec -i "$ROUTER" mongodump --config=/dev/stdin -u "$user" \
    --authenticationDatabase admin --db "$DB_NAME" --archive --gzip \
  > "$tmp"
unset password

gzip -t "$tmp"
[ "$(wc -c < "$tmp")" -gt 1024 ] || { echo "backup suspiciously small" >&2; exit 1; }
mv "$tmp" "$target"
trap - EXIT

# Retention: keep the newest $KEEP archives.
ls -1t "$BACKUP_DIR"/${DB_NAME}-*.archive.gz | tail -n +"$((KEEP + 1))" | xargs -I{} rm -f {}
echo "backup ok: $target ($(wc -c < "$target") bytes)"
