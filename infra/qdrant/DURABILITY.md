# Reel Indexing pair durability (PostgreSQL + Qdrant)

Written 2026-11-25. Qdrant is the only permanent copy of the vectors; PostgreSQL decides which
points are current (active rows, generation, manifest hash, ready record). A backup of one
without the other is not a backup of the system, so the unit of backup is the **pair**.
Facts below were measured on the homelab on 2026-11-25 unless marked otherwise. Nothing here
changes search behaviour.

## What is in the repo

| File | Purpose |
| --- | --- |
| `scripts/ops/pair-backup.sh` | Host driver: `pg_dump`, Qdrant snapshot, encrypt, R2 + optional off-site copy, readback. Default: no pause, quiet check plus fingerprint fence. `--pause-writers` signals the indexers first (see below). `--dry-run` only checks quiescence. `--ops <script> ...` runs one operator CLI in the isolated container. |
| `scripts/ops/pair-backup.cjs` | Operator-container helper: `begin` (quiescence + SQL facts), `proof` (binds dump hash and LSN), `finish` (encrypts the dump, uploads, writes the pair manifest), `fetch` (read the pair back from R2 and verify). |
| `scripts/ops/qdrant-backup.cjs` | Existing tool. `backup` now validates a paired SQL proof (fresh, malformed, live SQL fingerprint unchanged before and after the snapshot), records the pair in the archive manifest, writes a marker when the snapshot is taken, and reports snapshot and archive size against their caps. `--require-pair=true` refuses legacy proofs. Without a `pairId` it behaves as before. |
| `scripts/ops/pair-offsite-copy.sh` | Ciphertext copy to velora-node-2 over ssh, verified by remote `sha256sum`. |
| `scripts/ops/pair-restore-drill.sh` | Restore drill into disposable containers. |
| `scripts/ops/reel-qdrant.cjs` | New: `verify-parity --list-all=true`, `stale-ready`, `orphans`. |
| `scripts/ops/reel-qdrant-audit.cjs` | Read-only implementation of `stale-ready` and `orphans`. |
| `scripts/ops/reel-search-smoke.cjs` | Scoped searches through the real repository (SQL scope capture, Qdrant exact search, RRF). Used for the drill and for latency before and after. |
| `scripts/ops/test-pair-durability.cjs`, `test-pair-offsite-copy.sh` | Unit tests (`node --test scripts/ops/test-pair-durability.cjs`, `bash scripts/ops/test-pair-offsite-copy.sh`). |
| `infra/qdrant/pair-backup/` | Config example, launchd plist and systemd unit and timer. **None is installed.** |
| `infra/qdrant/pg-standby/` | `rehearse.sh` (disposable rehearsal) and `compose.yaml` (the standby on homelab 2). |
| `infra/qdrant/cluster-rehearsal/rehearse.py` | Disposable two-node Qdrant rehearsal. |

## Paired backup

Order of one run (`pair-backup.sh <config>`):

1. `begin`: waits up to 60 s for quiet (no open projection task, no publication in flight, no
   `PROCESSING` attempt touched in the last 10 minutes), then records the WAL position, row
   counts and the projection fingerprint (the same fingerprint `verify-parity` uses). Old
   `PROCESSING` attempts do not count as busy; 26 from 2026-11-03 still exist. Note that
   `reconcile()` re-opens completed DELETE tasks of revoked generations every five minutes, so
   "pending" flickers to a few tasks for about a second even when nothing is indexed.
2. `pg_dump -Fc` of the Indexing database (owners kept: a restore needs the same two roles,
   which the init scripts create).
3. `proof`: the fingerprint must be unchanged; writes `sql-proof.json` with pair ID, time, WAL
   position before and after the dump, dump SHA-256, fingerprint and table counts.
4. `qdrant-backup.cjs backup --require-pair=true`: validates the proof (fresh, well formed, live
   fingerprint equal), takes the snapshot, re-checks the fingerprint, writes a marker, encrypts and
   uploads the archive, verifies readback. If SQL moved, the pair is rejected and the temporary
   snapshot deleted; run again.
5. `finish`: encrypts the dump (chunked AES-256-GCM, scrypt key, each chunk bound to its index
   and a final flag), uploads dump and `pair-manifest.json` to `<R2_PREFIX>/<pairId>/`, verifies
   readback. The key is the existing `qdrant-secrets/backup-key`, kept off R2 and out of the repo.
6. Optional off-site copy (`OFFSITE_SSH`), then `fetch` reads the pair back from R2, checks both
   checksums and decrypts the dump to compare its content hash with the manifest. The plaintext
   dump is then removed (`KEEP_PLAINTEXT=true` keeps it).

### Why there is no pause by default

The documented drain (`SIGUSR2`, `README.md`) does not behave as written in the deployed image.
Measured on 2026-11-25: PID 1 is `sh -c "prisma migrate deploy && node ..."`, which swallows
`docker kill -s USR2`, so the signal has to reach the node process. When it does, the job
consumers drain (log `index_job_drain settled:true`) but Nest's `enableShutdownHooks()` also treats
`SIGUSR2` as a shutdown signal, so the whole process exits with code 0, **including the query RPC
that serves semantic search**. The SHORT container did not restart on its own although its
policy is `restart: always`; I started it by hand. RabbitMQ consumers on `reel_index_query` were 0
from 13:33:48 to 13:34:35 UTC (47 s, ended by my manual start). A pause is therefore a search
outage of at least the snapshot time plus a restart. `--pause-writers` exists (signals the node
process, waits for exit, restarts both containers) but was **not** exercised end to end: the one
attempt was aborted by hand after the outage. The fence gives the same guarantee without it: a
pair taken while a writer moved is rejected, not silently accepted.

### Limits to watch

- The Qdrant snapshot cap is 128 MiB and the archive cap 180 MiB (both are in-memory
  bounds). The second 2026-11-25 run had a 120.95 MB snapshot (90 % of the cap) and a 161.3 MB
  archive (85 %) at 11,316 points. About 10 % more points will make the backup fail with a size error. Raise the caps
  (and the operator container memory) before scheduling it.
- Off-site copy to velora-node-2 needs a key-based login; none exists in this environment.

### Schedule (not enabled)

`infra/qdrant/pair-backup/` has a launchd plist (the homelab is macOS) and a systemd
service and timer. Enable one only after a drill has passed on the production host. The unit does not pause writers unless `--pause-writers` is added.

## Restore drill

`pair-restore-drill.sh <config> <pairId>` fetches the pair from R2, restores PostgreSQL and
Qdrant into disposable containers on a private network with a throwaway CA, passwords and API
key, runs the documented Qdrant recovery (`restore`, `resume`, `reconcile`), then `verify-parity
--list-all`, `stale-ready`, `orphans` and the scoped search smoke. It then deletes five points from
the disposable collection to prove the detectors fire, and removes everything it created.

## Measured results (2026-11-25, homelab, production data)

| Item | Result |
| --- | --- |
| Paired backup, no pause, two runs | 123 s and 124 s end to end; `pg_dump` 25-26 s, 126.66 MB; Qdrant snapshot, encrypt and upload 38-39 s, archive 159-161 MB; encrypted dump 126.67 MB; R2 readback verified; dump content hash verified after decryption |
| Pair 9e43f7e6-119f-4ac0-b044-774ca29e551a | WAL 1/B982B818 before the dump, 1/B9BC1348 after; 299 documents, 252 sections, 4,293 chunks, 6,068 scenes, 298 projections, 10,885 current points, 11,316 points in Qdrant |
| Restore drill from R2 (227 s total) | fetch and verify 29 s; PostgreSQL start 6 s; `pg_restore` 18 s, exit 0, no errors, 353 MB; Qdrant start 5 s; Qdrant `restore` 4 s; `resume` 2 s; `reconcile` until complete 110 s (many invocations exit on transient errors and are simply re-run); `verify-parity` 13 s; `stale-ready` 8 s; `orphans` 1 s |
| Drill checks | `recordsConsistent=true`, 298 of 298 manifests, 10,885 points verified, 431 orphans (same as production); `stale-ready` 0; scoped search 24 of 24 own chunk at rank 1, p50 318 ms, p95 461 ms (production baseline p50 317, p95 458) |
| Detectors fire | after deleting 5 points from the disposable collection: `stale-ready` listed 5 reels, `verify-parity --list-all` listed 5 `points_missing` failures, `recordsConsistent=false` |

## After a PostgreSQL restore or promotion

Neither a restored dump nor an asynchronous standby is guaranteed to match Qdrant. Qdrant may
have deleted points that the older SQL still lists as ready, or still hold points the older SQL
has deleted. Nothing re-checks ready records at read time, and `reconcile` re-opens work only
when `readyAt` is empty or the collection state changed. Staged R2 bundles are deleted at
finalize, so missing points cannot be rebuilt from SQL.

1. Keep writers off the restored database. Drain the indexers (`docker kill -s USR2 ...`) or
   leave them stopped until step 5.
2. Run the read-only checks (`pair-backup.sh <config> --ops reel-qdrant.cjs ... --target-label=...`):
   - `verify-parity --list-all=true`: every mismatching record with a reason code
     (`points_missing`, `payload_mismatch`, `manifest_mismatch`, `not_ready`, ...). It does not stop at
     the first error. `recordsConsistent=true` means records and points agree even when orphans
     keep `complete` false.
   - `stale-ready`: ready records whose points are missing in Qdrant (exit 2 when any).
   - `orphans`: points no current record accounts for, by reason.
3. Stale records: re-index each listed reel through Content (`scripts/ops/reindex-reel.cjs
   <reelId>`, pattern `index.reindex_reel`). A re-index writes a new generation; the stale one is
   revoked and cleaned up. If the ready record was written after the restore point, the reel's
   current media must still exist.
4. Reels deleted after the restore point come back in SQL (rows and ready record). Re-issue the
   delete for every reel Content no longer serves (`index.delete_reel`, see
   `delete-reel.use-case.ts`) before enabling reads. Their points may still be in Qdrant and
   searchable until then.
5. Re-run steps 2 until `stale-ready` is clean, then restart the indexers.
6. After restoring Qdrant as well, use the existing procedure in `README.md` (`restore`,
   `resume`, `reconcile` until `complete=true`).

Orphans are harmless to search (the `has_id` filter excludes them) and are not repaired by
these tools.

## Findings that are not fixed here

- `reconcile()` re-opens every completed DELETE task of a revoked generation every five minutes
  forever (task 466 had 2,897 attempts). Harmless but noisy; it makes "pending" briefly non-zero
  and was why `verify-parity` reported `vectorTasksPending: 2` on a healthy system.
- Production has 431 orphan points (`unreferenced_generation`) from the 2026-11-09 merge, so
  `verify-parity` can never report `complete=true` there. Use `recordsConsistent`.
- `infra/qdrant/postgres-init/20-create-reel-indexing-role.sql` is also executed directly by the
  image entrypoint (it runs every `*.sql` in the directory) and fails without the `\getenv`
  wrapper from the `.sh` file. The drill works around it; a fresh volume built from that
  directory as-is fails to initialise.
- The Qdrant collection can report `yellow` for seconds to minutes after a write burst
  (12 s in the rehearsal), and `identity()` requires `green`, so vector search fails while it is
  yellow.

## PostgreSQL standby for the Indexing database on homelab 2: applied 2026-11-25

Physical streaming replica of `reel-indexing-postgres`, read-only hot standby, asynchronous,
physical slot `idx_standby`, failover manual. Nothing reads from it and search is unchanged.
No restart of, or compose change to, the primary was needed.

### What was changed

| Where | Change | Reversible by |
| --- | --- | --- |
| Primary database (online) | `CREATE ROLE replicator_idx LOGIN REPLICATION CONNECTION LIMIT 2` with a generated password; `ALTER SYSTEM SET max_slot_wal_keep_size = '4GB'` (was `-1`, unlimited); one line appended to `pg_hba.conf` in the data volume: `host replication replicator_idx 192.168.97.0/24 scram-sha-256`; `pg_reload_conf()` | `DROP ROLE`, `ALTER SYSTEM RESET max_slot_wal_keep_size`, delete the two `pg_hba` lines, reload |
| Homelab host | container `reel-indexing-pg-forwarder` (`alpine/socat`, 0.25 CPU, 32 MB, `restart: unless-stopped`) on `microservices-net` publishing **`100.102.228.48:15432`** (the tailnet address only, the Mac's `utun9`) and forwarding to `reel-indexing-postgres:5432`. It is not part of any compose file, so a CI deploy does not touch it | `docker rm -f reel-indexing-pg-forwarder` |
| Homelab host | password file `~/velora-operations/pair-backup/secrets/replicator_idx.pw` (mode 600) | delete it |
| Homelab 2 (WSL, `/opt/velora/reel-indexing-standby/`) | `compose.yaml` (this folder), `replicator.pw` (mode 600), `standby-up.sh`, volume `reel-indexing-standby_reel_indexing_standby_data`, container `reel-indexing-standby` (768 MB, 1 CPU, published on `127.0.0.1:5433` only) | `docker compose down` and remove the volume |

Why no restart was needed: the primary's `pg_hba` and `max_slot_wal_keep_size` are reloadable, and
the Mac already has a private route to the laptop (its tailnet address, 3 ms round trip). The
route to the container is the forwarder, because the database container publishes no port and
`tailscale serve` needs sudo, which is not available over ssh. The replica holds the same
role password hashes as production, so its port is loopback only.

The password was generated on the dev machine, copied to both hosts through ssh stdin, and the
local copy shredded. The `CREATE ROLE` statement received it through stdin only. It is not in
this repo, in a process argument list, or in any log.

### Measured

| Item | Result |
| --- | --- |
| Base backup (402 MB, `--checkpoint=fast --max-rate=10M`) | 46 s |
| `pg_stat_replication` | `walreceiver`, client 192.168.97.26 (the forwarder), `streaming`, `async`, 0 bytes behind |
| Replay lag, 8 samples over 2 minutes plus 1 spot check | 41-50 ms (write, flush and replay all about equal); standby `now() - last replay` 173 ms once |
| Slot | `idx_standby` active, `reserved`, 0 bytes retained |
| Row counts, primary vs standby | equal on all seven tables checked: ReelDocument 299, ReelSection 252, ReelChunk 4,293, ReelVisualScene 6,068, VectorProjection (non-revoked) 298, IndexingAttempt 1,472, TranscriptionSegment 199,474; database size 402 MB on both |
| Writes on the standby | refused: "cannot execute CREATE TABLE in a read-only transaction" and the same for INSERT; `pg_is_in_recovery() = t` |
| RAM on homelab 2 (WSL, 4,921 MiB total) | before: used 1,144 MiB, available 3,776 MiB (node-exporter 3,788); after the base backup: available 3,762; with the standby running: used 1,210, available 3,710; node-exporter about 7 minutes later 3,731 MiB, swap free 2,026 of 2,048 MiB. The standby container itself uses 52 MiB of its 768 MiB cap. Net cost about 60 MiB; Mongo shard (407 MiB) and conversation services unaffected |
| Primary | connections 16 to 17, no restart, indexers and Qdrant untouched. Scoped search smoke after the change: 24 of 24 own chunk at rank 1, p50 322 ms, p95 461 ms (baseline 317 and 458) |

Cross-architecture note: the primary is ARM64 and the standby x86_64. It replayed without error
and the counts match, but replication of text indexes across glibc builds can in principle differ;
the image is the same digest on both sides. A `pg_dump`-based check from the standby is the way to
see it (not run).

### Not exercised

Promotion was not run on the live standby: it would end the replica and require a rebuild. It was
rehearsed on a disposable copy (`rehearse.sh`). To promote for real: stop the primary or its
writers first, `SELECT pg_promote()` on the standby, then follow "After a PostgreSQL restore or
promotion". The primary must not be used again without being rebuilt as a standby of the new
one. Repointing the indexers needs an `.env` change and the deploy controller's env hash approval,
so it is a decision for the owner, not part of this step.

### Operating it

- Health, on the primary: `select application_name, state, replay_lag from pg_stat_replication`
  and `select slot_name, active, wal_status from pg_replication_slots`. A standby that stays down
  makes the primary keep WAL up to 4 GB (about 0.7 GB/day measured when idle), after which the slot
  is invalidated and the standby must be rebuilt with `standby-up.sh`.
- Rebuild: `docker compose down` and remove the volume on homelab 2, `SELECT pg_drop_replication_slot('idx_standby')` on the primary, then `standby-up.sh`.
- Dumps taken from the standby need `max_standby_streaming_delay` (already 900 s).
- Nothing alerts on replica lag yet.

### Rollback (full)

1. Homelab 2: `cd /opt/velora/reel-indexing-standby && docker compose down -v`.
2. Primary: `SELECT pg_drop_replication_slot('idx_standby')`; `DROP ROLE replicator_idx`;
   remove the two lines at the end of `pg_hba.conf` (the comment and the `host replication` line);
   `SELECT pg_reload_conf()`; optionally `ALTER SYSTEM RESET max_slot_wal_keep_size` then reload.
3. Homelab: `docker rm -f reel-indexing-pg-forwarder`; delete `secrets/replicator_idx.pw`.

## Qdrant replica on homelab 2: rehearsed, not applied

Rehearsal (`cluster-rehearsal/rehearse.py`): two disposable containers, the production image,
config and resource caps, 11,316 synthetic points, the exact `initialize()` collection body, 13
payload indexes, alias. Results:

| Question | Result |
| --- | --- |
| Enable cluster mode on the existing storage | works with `QDRANT__CLUSTER__ENABLED=true`, `QDRANT__CLUSTER__P2P__ENABLE_TLS=true` and `--uri`; restart about 6 s; `created_at` unchanged (so the fingerprint is unchanged); points and searches intact |
| Add a replica without recreating | works: second peer with `--bootstrap`, then `POST /collections/<c>/cluster {replicate_shard: {shard_id: 0, from_peer_id, to_peer_id, method: "snapshot"}}`; 2.1 s here; same `created_at` and count on both; `PATCH` collection `replication_factor: 2` accepted; searches 12/12 on both nodes during and after the transfer |
| Kill the peer that leads the shard (B) | search on A still answers (12/12, 3 ms); **writes fail** with HTTP 500 "Failed to apply update with Strong ordering via leader peer"; creating a collection or alias fails after a 10 s timeout; everything recovers by itself when B restarts (16 s), counts equal |
| Kill the other peer (A) | search on B answers; the first write timed out at 15 s, a later one succeeded (3.2 s); consensus operations fail ("leader is not established"); A rejoined and caught up (both 11,444 points) |
| Permanent loss of the shard-leading peer | `DELETE /cluster/peer/<id>` is refused (shards on it); with `?force=true` it fails too ("leader is not established within 10 s"); writes keep failing. No way to repair topology with one of two peers gone was found; manual Raft state surgery was not tried |
| Write latency, 128-point `wait=true&ordering=strong` batch, one peer behind netem | 36 ms no delay; 117 ms at 6 ms; 340 ms at 18 and 30 ms; 0.96 s at 6 ms with 3 ms jitter; 4.3 s median and 6.0 s max at 30 ms with 10 ms jitter, above the adapter's 5 s deadline. netem jitter reorders packets, so this over-states a wired LAN, but the laptop is on Wi-Fi with 30-45 ms peaks |
| Memory | 170-190 MiB per node idle |

Blockers, so it was **not** applied to production:

1. A two-peer Raft cluster has no quorum with one peer down. Search survives, but every topology
   change fails, and so does every write when the dead peer leads the shard; no forced recovery
   path worked. That is a worse failure mode for indexing than today's single node.
2. Synchronous cross-host writes put the indexer's 5 s deadline at risk over Wi-Fi.
3. The adapter has one `QDRANT_URL`, so failover is a manual repoint, and both nodes need
   certificates with SANs for their peer addresses (production's has SAN `qdrant` only).
4. (Access to homelab 2 has since been granted, but this does not change 1-3.)

No before/after production latency exists for a change that was not made. Baseline (24 scoped
queries over 8 reels, all returned their own chunk at rank 1): p50 317 ms, p95 458 ms at 13:09
UTC; p50 326 ms, p95 429 ms at 15:05 UTC.

Alternatives: a third peer (velora-node-2 at 217 ms is too far for synchronous writes) or a
warm copy by restoring the paired backup on homelab 2 on demand (227 s in the drill).

## What lives outside git on the homelab, and how to re-apply

- `~/velora-operations/pair-backup/`: `repo/` (copy of `scripts/ops` and `infra/qdrant`),
  `work/` (pair directories, `archives/`, sampler log), `pair-backup.env`, `sampler.sh`.
  Re-create by copying the repo directories and the config from
  `infra/qdrant/pair-backup/pair-backup.env.example`. `repo/scripts/ops/_dbg.cjs` is a debugging
  shim, not in git.
- R2 objects under `velora-private-backups/reel-indexing-pairs/` (two pairs). Nothing was
  deleted anywhere.
- Nothing in the deploy path changed: no compose file, overlay, `.env`, image, crontab or launchd
  entry. A CI deploy therefore cannot drop any of it; only the host files above must be kept.
- Standby pieces (see the standby section): forwarder container `reel-indexing-pg-forwarder`,
  `secrets/replicator_idx.pw`, the `replicator_idx` role, the `pg_hba` line and
  `max_slot_wal_keep_size` on the primary, and `/opt/velora/reel-indexing-standby/` on homelab 2.
  Re-apply from the steps in the standby section; the forwarder is not in any compose file and the
  CI deploy does not remove it.
- Host keys for `100.104.227.44` and `100.86.68.16` were added to the homelab user's
  `known_hosts` while probing access.
