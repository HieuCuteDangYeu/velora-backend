set -eu
export PATH=$PATH:/usr/local/bin
PG=microservices-boilerplate-reel-indexing-postgres-1
PW=$HOME/velora-operations/pair-backup/secrets/replicator_idx.pw
psqlp() { docker exec -i "$PG" psql -U reel_indexing_admin -d reel_indexing -v ON_ERROR_STOP=1 -At "$@"; }
echo "before: $(psqlp -c "select count(*) from pg_roles where rolname='replicator_idx'") role(s), slot keep=$(psqlp -c 'show max_slot_wal_keep_size')"
# password goes through stdin only (printf is a shell builtin, so it never appears in a process list)
printf "CREATE ROLE replicator_idx WITH LOGIN REPLICATION PASSWORD '%s' CONNECTION LIMIT 2;\n" "$(cat "$PW")" | psqlp -f - </dev/stdin
psqlp -c "ALTER SYSTEM SET max_slot_wal_keep_size = '4GB'"
docker exec -u postgres "$PG" sh -c "printf '%s\n' '# reel-indexing standby on homelab 2, added 2026-11-25 (forwarder subnet)' 'host replication replicator_idx 192.168.97.0/24 scram-sha-256' >> /var/lib/postgresql/data/pg_hba.conf"
psqlp -c "select pg_reload_conf()"
sleep 1
echo "after: slot keep=$(psqlp -c 'show max_slot_wal_keep_size')"
psqlp -c "select rolname, rolreplication, rolcanlogin, rolconnlimit, rolsuper from pg_roles where rolname='replicator_idx'"
docker exec "$PG" tail -3 /var/lib/postgresql/data/pg_hba.conf
