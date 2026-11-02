#!/usr/bin/env bash
set -eu

export REEL_INDEXING_APP_PASSWORD="$(
  tr -d '\r\n' < /run/secrets/reel_indexing_db_app_password
)"
psql \
  --set=ON_ERROR_STOP=1 \
  --username="$POSTGRES_USER" \
  --dbname="$POSTGRES_DB" \
  --file=/docker-entrypoint-initdb.d/20-create-reel-indexing-role.sql
unset REEL_INDEXING_APP_PASSWORD
