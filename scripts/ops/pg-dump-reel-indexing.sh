#!/bin/sh
set -eu

: "${PGHOST:?PGHOST is required}"
: "${PGUSER:?PGUSER is required}"
: "${PGPASSWORD:?PGPASSWORD is required}"
: "${PGDATABASE:?PGDATABASE is required}"
: "${REEL_INDEXING_DUMP_FILE:?REEL_INDEXING_DUMP_FILE is required}"

exec pg_dump --format=custom --no-owner --no-acl \
  --host="$PGHOST" --port="${PGPORT:-5432}" --username="$PGUSER" \
  --dbname="$PGDATABASE" --file="$REEL_INDEXING_DUMP_FILE"
