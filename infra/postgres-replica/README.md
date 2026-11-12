# PostgreSQL hot standby on the second VPS

Set up on 2026-11-12. The homelab `postgres` container (PostgreSQL 18.6, databases
`notification` and `call`) streams to a read-only hot standby on `velora-node-2`.
It is a physical replica of the whole cluster. Nothing here is deployed by CI; the
VPS is managed by hand over SSH. The Mongo counterpart is in `../mongo-replica/`.

| Item | Value |
| --- | --- |
| Primary | homelab container `microservices-boilerplate-postgres-1`, tailnet IP `100.102.228.48`, port 5432 forwarded by `tailscale serve` |
| Standby | container `postgres-replica` from `compose.yaml`, files in `/opt/velora/postgres-replica/` on `velora-node-2` (`100.86.68.16`, port 5432 bound to the tailnet IP only) |
| Replication | asynchronous streaming through the physical slot `node2_standby`, role `replicator` (REPLICATION only) |
| Size and speed | about 1.8 GB; the base backup took about 8 minutes at a 10 MB/s cap |

## What was changed on the primary

All of it online, no restart:

1. `CREATE ROLE replicator WITH LOGIN REPLICATION PASSWORD ...`. The password lives
   in `/opt/velora/postgres-replica/replicator.pw` on the VPS (mode 600) and in
   the standby's `postgresql.auto.conf`. It is not in this repo.
2. `ALTER SYSTEM SET max_slot_wal_keep_size = '4GB'`. Without a cap an unreachable
   standby makes the primary keep WAL forever and fill the disk. Past 4 GB behind,
   the slot is invalidated and the standby must be cloned again.
3. One line appended to `pg_hba.conf` in the data volume:
   `host replication replicator 192.168.97.0/24 scram-sha-256`. Replication
   connections that arrive through the published port are seen from the Docker
   bridge gateway (`192.168.97.1`), not from the tailnet address. The existing
   `host all all all scram-sha-256` line does not match replication connections.
4. `sudo tailscale serve --bg --tcp 5432 tcp://localhost:5432` on the homelab. The
   probe on 2026-11-12 showed every login through that port demands a SCRAM
   password, even for the superuser, so this does not open a passwordless path.
   Any device on the tailnet can reach the port, so keep the tailnet private.

## Cloning the standby again

Needed after the slot was invalidated, or to rebuild from scratch. On
`velora-node-2`, in `/opt/velora/postgres-replica`:

```sh
docker compose down            # keep the volume; never add -v
docker volume rm postgres-replica_postgres_replica_data
docker compose create          # recreates the empty volume
docker run --rm --user root \
  -v postgres-replica_postgres_replica_data:/var/lib/postgresql \
  -e PGPASSWORD="$(cat replicator.pw)" postgres:18.6 sh -c '
    mkdir -p /var/lib/postgresql/18/docker &&
    chown -R postgres:postgres /var/lib/postgresql &&
    chmod 700 /var/lib/postgresql/18/docker &&
    exec gosu postgres pg_basebackup -h 100.102.228.48 -p 5432 -U replicator \
      -D /var/lib/postgresql/18/docker -X stream -R -C -S node2_standby \
      --max-rate=10M -v'
docker compose up -d
```

Drop the old slot first if it still exists:
`select pg_drop_replication_slot('node2_standby')` on the primary. Run the base
backup detached (`nohup ... < /dev/null &`) because it takes several minutes.

## Lessons from the first run

- Never leave files owned by `root` inside the primary's data directory (a
  `pg_hba.conf` backup made with `docker exec` did this). The base backup runs as
  `postgres` and aborted on the unreadable file; keep backups outside `PGDATA`.
- A failed `pg_basebackup -C` leaves its slot behind. Drop it before retrying.
- The standby's `max_connections` must be at least the primary's (60).

## Check health

On the primary, `pg_stat_replication` should show `state = streaming` for the
standby and `pg_replication_slots` should show `node2_standby` active with a small
retained WAL. On the standby, `select pg_is_in_recovery()` must be `true` and any
write fails with a read-only transaction error. Verified 2026-11-12: row counts of
`notification_jobs` (1,653,778), `push_tokens` and `_prisma_migrations` matched
exactly and replay delay was zero.

## Using it

Nothing in notification-service reads from the standby yet. The same distance
applies as for Mongo: about 217 ms round trip between Vietnam and France, so a
service on the homelab reading the standby pays that per query. Failover is manual:
`pg_promote()` on the standby makes it writable, after which the primary must not
be used again without being rebuilt as a standby of the new one.
