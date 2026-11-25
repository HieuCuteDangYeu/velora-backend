#!/usr/bin/env bash
# Disposable rehearsal of a physical streaming standby for the Reel Indexing PostgreSQL
# (pgvector pg18, same digest as docker-compose.qdrant.yml). Runs the exact primary-side and
# standby-side commands from README.md against throwaway containers, then checks
# pg_stat_replication, replay lag, row counts, refused writes and a manual promotion.
# Creates and removes only containers/volumes/network named rp-*.
set -euo pipefail
IMAGE="${PG_IMAGE:-pgvector/pgvector:pg18@sha256:c29f30688a9ad961691bdf0ec1650717cc132a5814619d80f80463d6e4c42e47}"
NET=rp-net
ADMIN=reel_indexing_admin
PRIMARY_PASSWORD="$(head -c 18 /dev/urandom | base64 | tr -d '/+=\n')"
REPLICATOR_PASSWORD="$(head -c 18 /dev/urandom | base64 | tr -d '/+=\n')"
log() { printf '%s %s\n' "$(date -u +%FT%TZ)" "$*"; }
psql_p() { docker exec -i rp-primary psql -U "$ADMIN" -d reel_indexing -At "$@"; }
psql_s() { docker exec -i rp-standby psql -U "$ADMIN" -d reel_indexing -At "$@"; }
cleanup() { docker rm -f -v rp-primary rp-standby >/dev/null 2>&1 || true; docker volume rm -f rp-standby-data >/dev/null 2>&1 || true; docker network rm "$NET" >/dev/null 2>&1 || true; }
trap cleanup EXIT
cleanup
docker network create "$NET" >/dev/null

log "primary (defaults like production: no command override, wal_level replica)"
docker run -d --name rp-primary --network "$NET" --cpus 1.0 --memory 1536m \
  -e POSTGRES_DB=reel_indexing -e POSTGRES_USER="$ADMIN" -e POSTGRES_PASSWORD="$PRIMARY_PASSWORD" \
  -e PGDATA=/var/lib/postgresql/data "$IMAGE" >/dev/null
until docker exec rp-primary pg_isready -U "$ADMIN" -d reel_indexing -h 127.0.0.1 >/dev/null 2>&1; do sleep 1; done
sleep 3
psql_p -c "CREATE EXTENSION IF NOT EXISTS vector" -c "CREATE TABLE t (id bigserial PRIMARY KEY, body text)" \
  -c "INSERT INTO t (body) SELECT md5(g::text) FROM generate_series(1, 300000) g" >/dev/null

log "primary side, online, no restart"
SUBNET="$(docker network inspect "$NET" -f '{{(index .IPAM.Config 0).Subnet}}')"
psql_p -c "CREATE ROLE replicator_idx WITH LOGIN REPLICATION PASSWORD '$REPLICATOR_PASSWORD'" \
  -c "ALTER SYSTEM SET max_slot_wal_keep_size = '4GB'" >/dev/null
docker exec rp-primary sh -c "printf 'host replication replicator_idx %s scram-sha-256\n' '$SUBNET' >> /var/lib/postgresql/data/pg_hba.conf"
psql_p -c "SELECT pg_reload_conf()"

log "base backup into the standby volume (slot created by -C -S)"
docker run --rm --user root --network "$NET" -v rp-standby-data:/var/lib/postgresql/data \
  -e PGPASSWORD="$REPLICATOR_PASSWORD" "$IMAGE" sh -c '
    chown -R postgres:postgres /var/lib/postgresql/data && chmod 700 /var/lib/postgresql/data &&
    exec gosu postgres pg_basebackup -h rp-primary -U replicator_idx -D /var/lib/postgresql/data \
      -X stream -R -C -S idx_standby --max-rate=10M --checkpoint=fast' 2>&1 | tail -n 2

log "standby: read-only hot standby, same image"
docker run -d --name rp-standby --network "$NET" --cpus 1.0 --memory 768m \
  -e PGDATA=/var/lib/postgresql/data -v rp-standby-data:/var/lib/postgresql/data "$IMAGE" \
  postgres -c hot_standby=on -c max_connections=100 -c shared_buffers=128MB -c max_standby_streaming_delay=900s >/dev/null
until docker exec rp-standby pg_isready -U "$ADMIN" -d reel_indexing -h 127.0.0.1 >/dev/null 2>&1; do sleep 1; done

sleep 3
echo "--- primary: pg_stat_replication"
psql_p -F' | ' -c "select application_name, state, sync_state, coalesce(replay_lag::text,'0') as replay_lag, pg_wal_lsn_diff(pg_current_wal_lsn(), replay_lsn) as replay_bytes_behind from pg_stat_replication"
psql_p -F' | ' -c "select slot_name, active, wal_status from pg_replication_slots"
echo "--- standby: in recovery, row counts, write refused"
psql_s -c "select pg_is_in_recovery()"
echo "rows primary=$(psql_p -c 'select count(*) from t') standby=$(psql_s -c 'select count(*) from t')"
REFUSED="$(psql_s -c "insert into t (body) values ('x')" 2>&1 || true)"
case "$REFUSED" in *"read-only transaction"*) echo "write refused on standby: yes ($REFUSED)" ;; *) echo "write refused on standby: NO"; exit 1 ;; esac
log "primary keeps writing; standby follows"
psql_p -c "INSERT INTO t (body) SELECT md5(g::text) FROM generate_series(1, 50000) g" >/dev/null
sleep 2
echo "rows primary=$(psql_p -c 'select count(*) from t') standby=$(psql_s -c 'select count(*) from t')"
echo "--- standby memory: $(docker stats --no-stream --format '{{.MemUsage}}' rp-standby)"
log "manual failover rehearsal: pg_promote()"
psql_s -c "select pg_promote(wait => true)"
psql_s -c "insert into t (body) values ('after promotion')" && echo "promoted standby accepts writes: yes"
echo "rows after promotion primary(old)=$(psql_p -c 'select count(*) from t') standby(new)=$(psql_s -c 'select count(*) from t')"
