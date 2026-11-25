#!/usr/bin/env bash
# Restore drill for a paired backup, into DISPOSABLE containers only (never live databases).
# Fetches the pair from R2, restores PostgreSQL and Qdrant into throwaway containers on a
# private network with a throwaway CA and passwords, runs the documented recovery
# (restore, resume, reconcile), then parity, stale-ready, orphans and scoped searches.
# Every container, volume, network and secret it creates is removed at the end.
#
#   pair-restore-drill.sh <config-file> <pair-id>
set -euo pipefail
umask 077

CONFIG="${1:?usage: pair-restore-drill.sh <config-file> <pair-id>}"
PAIR_ID="${2:?pair id required}"
# shellcheck disable=SC1090
. "$CONFIG"
: "${REPO_DIR:?}" "${OPS_IMAGE:?}" "${ENV_FILE:?}" "${SECRETS_DIR:?}" "${WORK_DIR:?}" "${R2_PREFIX:?}"
PG_IMAGE="${DRILL_PG_IMAGE:-pgvector/pgvector:pg18@sha256:c29f30688a9ad961691bdf0ec1650717cc132a5814619d80f80463d6e4c42e47}"
QDRANT_IMAGE="${DRILL_QDRANT_IMAGE:-qdrant/qdrant:v1.20.0@sha256:9bfc89f9914fc14876a88c05270685921a55b8877b254a98bcc1cc2f0a424cd2}"
COLLECTION="${QDRANT_COLLECTION:-velora_reel_bge_m3_1024_v1}"
export PATH="$PATH:/usr/local/bin"
case "$PAIR_ID" in ????????-????-????-????-????????????) ;; *) echo "bad pair id" >&2; exit 64 ;; esac

TAG="drill-$(printf '%s' "$PAIR_ID" | cut -c1-8)-$$"
NET="$TAG-net"
DIR="$WORK_DIR/$TAG"
PG="$TAG-pg"
QD="$TAG-qdrant"
log() { printf '%s %s\n' "$(date -u +%FT%TZ)" "$*" >&2; }
now_s() { date +%s; }
T0="$(now_s)"
mkdir -p "$DIR/secrets" "$DIR/pg-init"
chmod 755 "$DIR" "$DIR/secrets" "$DIR/pg-init"

cleanup() {
  log "cleanup of disposable drill resources"
  docker rm -f -v "$PG" "$QD" >/dev/null 2>&1 || true
  docker network rm "$NET" >/dev/null 2>&1 || true
  rm -rf "$DIR"  # only what this drill created: throwaway secrets, fetched and decrypted copies
}
trap cleanup EXIT

# --- throwaway secrets: random passwords, API key and a private CA with SAN "qdrant"
rand() { head -c 24 /dev/urandom | base64 | tr -d '/+=\n' | cut -c1-32; }
rand >"$DIR/secrets/admin-password"; rand >"$DIR/secrets/app-password"; rand >"$DIR/secrets/api-key"
DRILL_ADMIN="$(cat "$DIR/secrets/admin-password")"; DRILL_APP="$(cat "$DIR/secrets/app-password")"
# The image entrypoint also executes any *.sql in the init directory, and 20-*.sql needs the
# \getenv wrapper in the .sh, so the SQL file is mounted outside the init directory.
sed 's#/docker-entrypoint-initdb.d/20-create-reel-indexing-role.sql#/opt/drill/20-create-reel-indexing-role.sql#' \
  "$REPO_DIR/infra/qdrant/postgres-init/10-create-reel-indexing-role.sh" >"$DIR/pg-init/10-create-reel-indexing-role.sh"
cp "$REPO_DIR/infra/qdrant/postgres-init/20-create-reel-indexing-role.sql" "$DIR/role.sql"
docker run --rm -v "$DIR/secrets:/out" --entrypoint sh "$OPS_IMAGE" -c '
  cd /out &&
  openssl req -x509 -newkey rsa:2048 -nodes -keyout ca.key -out ca.crt -subj "/CN=pair-drill-ca" -days 2 2>/dev/null &&
  openssl req -newkey rsa:2048 -nodes -keyout server.key -out server.csr -subj "/CN=qdrant" 2>/dev/null &&
  printf "subjectAltName=DNS:qdrant\n" > ext.cnf &&
  openssl x509 -req -in server.csr -CA ca.crt -CAkey ca.key -CAcreateserial -out server.crt -days 2 -extfile ext.cnf 2>/dev/null &&
  chmod 644 *'
chmod 644 "$DIR/secrets/"*

docker network create "$NET" >/dev/null

# --- 1. fetch and verify the pair from R2 (the real off-host read path)
ENV_TMP="$DIR/env"
for key in R2_ACCOUNT_ID R2_BUCKET_NAME R2_ACCESS_KEY_ID R2_SECRET_ACCESS_KEY AI_EMBEDDING_MODEL \
  AI_EMBEDDING_DIMENSIONS AI_EMBEDDING_VERSION; do
  grep -E "^${key}=" "$ENV_FILE" | tail -n 1 >>"$ENV_TMP" || true
done
{
  echo "REEL_INDEXING_DATABASE_URL=postgresql://reel_indexing_app:${DRILL_APP}@${PG}:5432/reel_indexing?schema=public"
  echo "QDRANT_URL=https://qdrant:6333"
  echo "QDRANT_COLLECTION=$COLLECTION"
  echo "QDRANT_API_KEY_FILE=/run/secrets/qdrant_api_key"
  echo "NODE_EXTRA_CA_CERTS=/run/secrets/qdrant_tls_ca"
  echo "INDEX_VECTOR_SEARCH_BACKEND=qdrant"
  echo "INDEX_VECTOR_PROJECTION_ENABLED=true"
  echo "INDEX_VECTOR_PUBLICATION_REQUIRED=true"
  echo "PAIR_DRILL_DISPOSABLE=yes"
} >>"$ENV_TMP"
dops() { # operator container on the drill network only; real key only for decrypting the pair
  local name="$TAG-ops-$RANDOM" rc=0
  docker create --name "$name" --network "$NET" --env-file "$ENV_TMP" \
    -v "$DIR/secrets/api-key:/run/secrets/qdrant_api_key:ro" -v "$DIR/secrets/ca.crt:/run/secrets/qdrant_tls_ca:ro" \
    -v "$SECRETS_DIR/backup-key:/run/secrets/qdrant_backup_key:ro" \
    -v "$DIR:/work" -v "$REPO_DIR/scripts/ops:/usr/src/app/scripts/ops:ro" \
    --entrypoint node "$OPS_IMAGE" "$@" >/dev/null
  docker start -a "$name" </dev/null || rc=$?
  docker rm "$name" >/dev/null 2>&1 || true
  return "$rc"
}
step() { STEP_NAME="$1"; STEP_START="$(now_s)"; log "== $1"; }
done_step() { printf 'TIMING %s %ss\n' "$STEP_NAME" "$(( $(now_s) - STEP_START ))"; }
quiet() { grep -v -E "NodeVersionSupportWarning|^versions published|^will require|^To continue|^and security|^More information|trace-warnings|^$|\[Nest\]"; }

step "fetch from R2 and verify"
dops /usr/src/app/scripts/ops/pair-backup.cjs fetch --dir=/work/pair --pair-id="$PAIR_ID" \
  --offhost-r-prefix="$R2_PREFIX" --encryption-key-file=/run/secrets/qdrant_backup_key --decrypt=true 2>&1 | quiet
done_step
ls -l "$DIR/pair" | awk 'NR>1{print "SIZE",$5,$9}'

# --- 2. disposable PostgreSQL, same image and resource caps as production
step "start disposable PostgreSQL"
docker run -d --name "$PG" --network "$NET" --cpus 1.0 --memory 1536m \
  -e POSTGRES_DB=reel_indexing -e POSTGRES_USER=reel_indexing_admin \
  -e POSTGRES_PASSWORD_FILE=/run/secrets/reel_indexing_db_admin_password \
  -e REEL_INDEXING_APP_PASSWORD_FILE=/run/secrets/reel_indexing_db_app_password -e PGDATA=/var/lib/postgresql/data \
  -v "$DIR/pg-init:/docker-entrypoint-initdb.d:ro" -v "$DIR/role.sql:/opt/drill/20-create-reel-indexing-role.sql:ro" \
  -v "$DIR/secrets/admin-password:/run/secrets/reel_indexing_db_admin_password:ro" \
  -v "$DIR/secrets/app-password:/run/secrets/reel_indexing_db_app_password:ro" \
  "$PG_IMAGE" >/dev/null
wait_pg() {
  local i=0
  until docker exec "$PG" pg_isready -U reel_indexing_admin -d reel_indexing -h 127.0.0.1 >/dev/null 2>&1; do
    [ "$(docker inspect -f '{{.State.Running}}' "$PG")" = true ] || { docker logs --tail 20 "$PG" >&2; echo "disposable PostgreSQL exited" >&2; exit 1; }
    i=$((i + 1)); [ "$i" -lt 90 ] || { echo "disposable PostgreSQL not ready" >&2; exit 1; }
    sleep 2
  done
}
wait_pg
sleep 3 # the init scripts restart the server once; wait for the final ready state
wait_pg
done_step

step "restore PostgreSQL dump"
set +e
docker exec -i "$PG" pg_restore -U reel_indexing_admin -d reel_indexing <"$DIR/pair/reel-indexing.dump" 2>"$DIR/pg_restore.err"
RC=$?
set -e
echo "PG_RESTORE_EXIT $RC (stderr lines: $(wc -l <"$DIR/pg_restore.err" | tr -d ' '))"
head -c 600 "$DIR/pg_restore.err" || true
done_step
docker exec -i "$PG" psql -U reel_indexing_admin -d reel_indexing -At -c \
  "select 'ROWS docs='||(select count(*) from \"ReelDocument\")||' chunks='||(select count(*) from \"ReelChunk\")||' scenes='||(select count(*) from \"ReelVisualScene\")||' projections='||(select count(*) from \"VectorProjection\" where not revoked)||' size='||pg_size_pretty(pg_database_size(current_database()))" </dev/null

# --- 3. disposable Qdrant, same image, config, caps and TLS layout as production
step "start disposable Qdrant"
docker run -d --name "$QD" --network "$NET" --network-alias qdrant --cpus 1.0 --memory 768m \
  --entrypoint bash \
  -v "$REPO_DIR/infra/qdrant/config.yaml:/qdrant/config/velora.yaml:ro" \
  -v "$REPO_DIR/infra/qdrant/entrypoint.sh:/qdrant/velora-entrypoint.sh:ro" \
  -v "$DIR/secrets/api-key:/run/secrets/qdrant_api_key:ro" \
  -v "$DIR/secrets/server.crt:/run/secrets/qdrant_tls_cert:ro" \
  -v "$DIR/secrets/server.key:/run/secrets/qdrant_tls_key:ro" \
  -v "$DIR/secrets/ca.crt:/run/secrets/qdrant_tls_ca:ro" \
  "$QDRANT_IMAGE" /qdrant/velora-entrypoint.sh >/dev/null
i=0
until docker exec "$QD" bash -c "exec 3<>/dev/tcp/127.0.0.1/6333" >/dev/null 2>&1; do
  [ "$(docker inspect -f '{{.State.Running}}' "$QD")" = true ] || { docker logs --tail 20 "$QD" >&2; echo "disposable Qdrant exited" >&2; exit 1; }
  i=$((i + 1)); [ "$i" -lt 60 ] || { echo "disposable Qdrant not ready" >&2; exit 1; }
  sleep 2
done
done_step

# --- 4. documented Qdrant recovery on the restored SQL: restore, resume, reconcile
step "qdrant restore (invalidate, upload snapshot, alias)"
ARCHIVE="$(ls "$DIR/pair" | grep -E '^velora-qdrant-.*\.vqb$' | head -n 1)"
dops /usr/src/app/scripts/ops/qdrant-backup.cjs restore --target-label=drill --confirm=QDRANT_drill \
  --archive="/work/pair/$ARCHIVE" --encryption-key-file=/run/secrets/qdrant_backup_key \
  --recovery-proof=READERS_POSTGRES_WRITERS_DRAINED_PUBLICATION_DISABLED 2>&1 | quiet
done_step
step "resume"
dops /usr/src/app/scripts/ops/reel-qdrant.cjs resume --target-label=drill --confirm=QDRANT_drill \
  --recovery-proof=RESTORED_AND_ALIAS_VERIFIED 2>&1 | quiet
done_step
step "reconcile until complete"
for i in 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15 16 17 18 19 20 21 22 23 24 25 26 27 28 29 30 31 32 33 34 35 36 37 38 39 40; do
  OUT="$(dops /usr/src/app/scripts/ops/reel-qdrant.cjs reconcile --target-label=drill --confirm=QDRANT_drill --max-tasks=100 2>&1 | quiet || true)"
  echo "$OUT" | tail -n 1
  case "$OUT" in *'"complete":true'*) break ;; esac
done
done_step

# --- 5. checks
step "verify-parity (list-all)"
dops /usr/src/app/scripts/ops/reel-qdrant.cjs verify-parity --list-all=true --target-label=drill 2>&1 | quiet || true
done_step
step "stale-ready"
dops /usr/src/app/scripts/ops/reel-qdrant.cjs stale-ready --target-label=drill 2>&1 | quiet | cut -c1-1500 || true
done_step
step "orphans"
dops /usr/src/app/scripts/ops/reel-qdrant.cjs orphans --target-label=drill 2>&1 | quiet | cut -c1-900 || true
done_step
step "scoped search smoke"
dops /usr/src/app/scripts/ops/reel-search-smoke.cjs --queries=24 --scope-reels=8 2>&1 | quiet | tail -n 1 || true
done_step

# --- 6. prove the detectors fire: delete a few points in the disposable Qdrant only
if [ "${DRILL_BREAK:-true}" = true ]; then
  step "negative test: remove 5 points from the DISPOSABLE collection"
  dops /usr/src/app/scripts/ops/pair-drill-break.cjs 2>&1 | quiet | cut -c1-400 || true
  dops /usr/src/app/scripts/ops/reel-qdrant.cjs stale-ready --target-label=drill 2>&1 | quiet | cut -c1-700 || true
  dops /usr/src/app/scripts/ops/reel-qdrant.cjs verify-parity --list-all=true --target-label=drill 2>&1 | quiet | cut -c1-900 || true
  done_step
fi
log "drill finished in $(( $(now_s) - T0 ))s"
