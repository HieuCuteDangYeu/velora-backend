# Backup worker on velora-node-2

A nightly batch job that does not depend on real-time latency, so it runs on the VPS in
France. It takes logical backups **from the replicas** that already live there, so the
homelab primaries carry no extra load and the copies sit on another machine. Set up on
2026-11-13. Nothing here is deployed by CI; the VPS is managed by hand over SSH.

| Item | Value |
| --- | --- |
| What | `pg_dump -Fc` of the `notification` and `call` databases, `pg_dumpall --globals-only` (roles), and `mongodump` of `conversation_db` |
| Source | the hot standby `postgres-replica` and the secondary `mongo-replica` (`--readPreference=secondary`) |
| When | every day at 20:30 UTC (03:30 in Vietnam), `Persistent=true` so a missed run happens at the next boot |
| Where | `/opt/velora/backups/<UTC stamp>/`, mode 700, newest 7 kept |
| Run by | `velora-backup.timer` and `velora-backup.service` (systemd, `Nice=10`, idle I/O) |
| Files | `/opt/velora/backup-worker/` holds `backup.sh` and `.env` (mode 600, only `MONGO_DUMP_URI`) |
| Result | `/opt/velora/backups/status.json` (`ok` or `failed` with the reason) and `backup.log` in each backup |

## Why from the replicas

- A dump reads everything. Doing it on the homelab would compete with chat and calls
  on a laptop that is already the bottleneck.
- The script refuses to run if the Postgres container is not a standby.
- A long dump on a standby can be cancelled by a replay conflict. The standby therefore runs
  with `max_standby_streaming_delay = 900s` (in `../postgres-replica/compose.yaml` and set live
  with `ALTER SYSTEM`); replay waits for a running dump instead of killing it.
- The Mongo credentials reach `mongodump` through stdin (`--config=/dev/stdin`), not through
  the command line. The URI uses the Conversation application user, which can read
  `conversation_db` only. A dedicated read-only backup user would be tighter.

## Verified on 2026-11-13

First run: 1 min 35 s, 339 MB (notification 120 MB, call 0.5 MB, Mongo 187 MB compressed).
It was then restored into throwaway containers (no published ports, removed afterwards):

- PostgreSQL: both databases restored; `notification_jobs` 1,653,803 rows, `push_tokens` 28.
- MongoDB: 1,134,929 documents restored, 0 failed; `messages` 1,122,726,
  `conversations` 4,066, `conversation_members` 8,137.

## Restore

```sh
B=/opt/velora/backups/<stamp>
# PostgreSQL into a server whose roles exist (or add --no-owner)
pg_restore -U postgres -C -d postgres $B/postgres-notification.dump
# MongoDB
mongorestore --archive --gzip < $B/mongo-conversation_db.archive.gz
```

Run a restore test again after changing the script, the databases or the Mongo user.

## Limits

- Logical dumps are not point-in-time: Mongo collections are dumped one after another from a
  live secondary, so a dump is consistent per collection, not across them.
- The backups live on the same VPS as the replicas. They protect against a lost or damaged
  homelab and against logical mistakes, but not against losing this VPS; copy them to object
  storage if that matters.
- The Mongo URI in `.env` stops working if the Conversation password is rotated.
- Nothing alerts when a run fails yet: check `status.json` or `journalctl -u velora-backup`.
  node-exporter on this VPS has no textfile collector, so exposing the result to Prometheus
  needs a change in `../vps-agent/compose.yaml`.

## Install or reinstall

```sh
scp infra/backup-worker/{backup.sh,velora-backup.service,velora-backup.timer} root@100.86.68.16:/opt/velora/backup-worker/
ssh root@100.86.68.16 'chmod 700 /opt/velora/backup-worker/backup.sh && mkdir -p /opt/velora/backups && chmod 700 /opt/velora/backups'
# write /opt/velora/backup-worker/.env (mode 600): MONGO_DUMP_URI="mongodb://<app user>:<password>@localhost:27017/conversation_db?authSource=conversation_db&directConnection=true"
ssh root@100.86.68.16 'cp /opt/velora/backup-worker/velora-backup.{service,timer} /etc/systemd/system/ && systemctl daemon-reload && systemctl enable --now velora-backup.timer'
```

Start one run by hand with `systemctl start velora-backup.service`.
