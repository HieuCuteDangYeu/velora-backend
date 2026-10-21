#!/usr/bin/env bash
# Daily logical backup of the self-hosted PostgreSQL databases (currently: notification, call).
# Streams a custom-format dump from the postgres container to BACKUP_DIR and keeps the
# newest KEEP archives per database. Restore with:
#   docker exec -i <postgres> pg_restore -U postgres -d <db> --clean --if-exists --no-owner < archive.dump
set -euo pipefail
export PATH="/opt/homebrew/bin:/usr/local/bin:$PATH"

CONTAINER="${POSTGRES_CONTAINER:-microservices-boilerplate-postgres-1}"
BACKUP_DIR="${BACKUP_DIR:-$HOME/backups/postgres}"
KEEP="${KEEP:-7}"
DATABASES="${DATABASES:-notification call}"

umask 077
mkdir -p "$BACKUP_DIR"
stamp="$(date -u +%Y%m%dT%H%M%SZ)"

for db in $DATABASES; do
  target="$BACKUP_DIR/${db}-${stamp}.dump"
  tmp="${target}.partial"
  trap 'rm -f "$tmp"' EXIT
  docker exec "$CONTAINER" sh -c "pg_dump -U \"\${POSTGRES_USER:-postgres}\" -Fc --no-owner \"$db\"" > "$tmp"
  [ "$(wc -c < "$tmp")" -gt 1024 ] || { echo "backup of $db suspiciously small" >&2; exit 1; }
  docker exec -i "$CONTAINER" pg_restore --list < "$tmp" > /dev/null   # the archive must be readable
  mv "$tmp" "$target"
  trap - EXIT
  ls -1t "$BACKUP_DIR"/${db}-*.dump | tail -n +"$((KEEP + 1))" | xargs -I{} rm -f {}
  echo "backup ok: $target ($(wc -c < "$target") bytes)"
done
