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
| `infra/qdrant/cluster-rehearsal/` | `rehearse.py` (two nodes), `rehearse3.py` (three nodes with netem latency, kill matrix, permanent loss, read distribution, Raft soak) and `rehearse4.py` (layout D: two nodes on the homelab, one on the laptop; peer-id forcing, host-loss failover): disposable Qdrant clusters. |

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

## Two-node Qdrant replica on homelab 2: rehearsed, not applied

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

## Three-node Qdrant rehearsal (homelab + homelab 2 + node-2): one layout passes, with conditions

Rehearsed 2026-11-25/26 on disposable containers only (`cluster-rehearsal/rehearse3.py`, logs kept
outside the repo). Nothing on any production host, and no production Qdrant, was touched.
Setup: production image and config, `QDRANT__CLUSTER__ENABLED=true` and p2p TLS, the real
collection body (1,024 float32 cosine, HNSW m16 ef_construct 100, 13 payload indexes, alias),
11,316 points, caps 768 MB (h and l 1 CPU, n 0.5 CPU). netem on each node's egress, one way:
homelab-laptop 6 ms with 3 ms jitter (RTT 12 ms), homelab-node-2 108 ms with 10 ms jitter (RTT 217 ms),
laptop-node-2 115 ms with 10 ms jitter, 25 % correlation. All nodes are x86 here: the real homelab
is ARM64, so snapshot transfer between ARM64 and x86_64 shards is **not** tested.
Layouts: A replicas on all three (replication_factor 3); B replicas on homelab and laptop, node-2 a
data-less Raft voter (replication_factor 2); C replicas on homelab and node-2, laptop a data-less
voter (replication_factor 2).

### Results

| Question | Result |
| --- | --- |
| 1. Formation on existing storage | works in all three runs: restart 1.3-2.5 s, 11,316 points intact, `created_at` identical on every peer (fingerprint unchanged), all three peers visible at once. Replica transfer by snapshot: laptop 6-8.5 s, node-2 75 s the first time (45 MB over 217 ms RTT) and 15-20 s when re-added. Going back to single-node mode on that storage also works (count and `created_at` unchanged) |
| 2. A data-less voter | allowed and kept: a peer with no shard replica stays in Raft, takes part in elections (it was elected leader several times) and keeps quorum. It can be removed with a plain `DELETE /cluster/peer/<id>` |
| 3a. Search after killing any one node | answered on both survivors at every checkpoint (3, 12, 30, 60 s), 3-33 ms, in all layouts. One exception: in B, the data-less node answered in 237 ms because it forwards to a remote replica |
| 3b. Raft after killing the leader | new leader within 3 s (term +1); consensus operations (collection alias creation) succeeded 0.5-2 s later at 12 s and 60 s in every case, because two of three voters remain |
| 3c. Writes with `ordering=strong` (what the adapter uses), write_consistency_factor 1 | fail with HTTP 500 for as long as the replica with the **highest peer id** is down (checked 60 s, every time) even though the replica is marked Dead and Raft is healthy; they succeed when any other node is down. Consistent in all 16 three-node kill runs with wcf 1 (and wcf 2 in A) plus the two earlier two-node runs; the peer ids were recorded in the last 7 of them. `ordering=medium` and `weak` succeed in the same situation (A and B, 12 s checkpoint) |
| 3d. Recovery after restart | ready in 3.6-26 s (the homelab node 9-26 s), replicas Active and counts equal within 0-1.3 s after that, no manual step |
| 3e. Permanent loss | a node holding a replica: plain removal is refused ("shards on it"), `?force=true` works in 0.1-1.1 s while two voters remain, writes and search carry on at once; a data-less node: plain removal works. A removed node restarted on its old storage stays `503 not ready`; it must be wiped and rejoined as a new peer, then re-replicated (5-20 s). With one of two voters gone (earlier two-node test) none of this worked |
| 4. Write latency, 128-point batch, `wait=true&ordering=strong`, through the homelab | A: median 1.98 s, max 4.8 s with wcf 1; median 4.6 s with wcf 2 (deadline 5 s). B: median 0.28-0.33 s, max 0.9-1.0 s (wcf 1), 0.19-0.21 s (wcf 2). C: median 0.31 s but max 9.7 s once (wcf 1), median 1.15 s (wcf 2). Read-back of every point with vectors straight after the write (the projection worker's verify): 0 batches missing points in all layouts, 30-62 ms through the homelab, 138 ms through the laptop in C |
| 4b. wcf 2 | with two replicas (B, C) every loss of a replica holder blocks all writes (500 in 0.4-4.3 s), and in B a write failure marked the surviving, healthy replica Dead for a time. With three replicas (A) wcf 2 survives the loss of a non-highest node. Keep wcf 1 |
| 5. Reads | a query to the homelab is answered by its local replica: 60 queries produced 0 internal requests on the other nodes. With `read_fan_out_factor` 1, 13 of 40 (A) and 21 of 40 (B) queries sent one sub-request to the laptop, none to node-2. Closed-loop exact search over a 6,000-id scope (12 threads, 12 s; node-2 pays a simulated 217 ms RTT, laptop 12 ms): A homelab only 108 qps (median 103 ms), homelab+laptop 200 qps (median 59 ms, p95 96 ms), all three 139 qps (p95 229 ms because node-2 is slow and has 0.5 CPU). B homelab only 28.5 qps, homelab+laptop 59.8 qps (2.1 times). Absolute rates varied 4 times between runs on this shared machine; the ratio near 2 is the stable result. At saturation one 1-CPU node answers in 100-417 ms, so sharing load with the laptop is what keeps the 250 ms identity/search deadline |
| 6. Raft timing, layout A, 10 minutes, laptop link raised to 40 ms for 3 s every 30 s, 86 writes of 128 points in minutes 3-8 | 0 term changes (term 1 throughout), 0 leader changes, 0 samples without a leader, 0 send failures on 120 samples of each node; writes 0 failures, median 1.33 s, max 2.19 s. Default election and tick settings survive 217 ms RTT with jitter here. Not covered: packet loss, a real WAN, a node-2 host stall |

### Verdict

- **Layout A (three replicas): not safe.** Strong-ordered writes cost 2-5 s and sit on the 5 s deadline; losing the highest-id node stops indexing.
- **Layout C (node-2 holds the second copy): not safe.** One 9.7 s write, 4.4 s medians through the laptop with wcf 2, and every write waits for a 217 ms replica.
- **Layout B (replicas on homelab and laptop, node-2 a data-less voter): passes, under conditions.**
  Median write 0.2-0.33 s (max about 1 s), search never interrupted, any single node loss keeps
  quorum and topology operations, losing the laptop or node-2 does not stop writes or search,
  permanent loss of either is recoverable in seconds, Raft was stable for 10 minutes.
  Conditions it needs:
  1. **The homelab must hold the highest peer id among the replica holders**, otherwise losing the
     laptop stops indexing. IDs are random for a new peer, so re-roll the laptop (remove with
     `?force=true`, wipe, rejoin, re-replicate, about 30 s a try) until its id is lower than the
     homelab's, which is fixed in the existing storage (`raft_state.json`; `GET /cluster` after
     enabling). `rehearse3.py layout B form,order` does this. Loss of the homelab itself still stops
     strong-ordered writes (as today), but now search can be repointed to the laptop.
  2. `write_consistency_factor` stays 1 and `replication_factor` 2. Do not use wcf 2.
  3. Read capacity is real (about 2 times with the laptop) only if something sends queries to the
     laptop: the adapter has one `QDRANT_URL`, and no client change was made or tested.
  4. The rule "writes need the highest-id replica" is inferred from the consistent runs above (ids recorded in 7),
     not from Qdrant source or documentation.
  5. Not verified: ARM64-to-x86_64 shard transfer, real packet loss and node-2 hardware, a
     certificate with SANs for the three tailnet addresses, publishing 6335 on the homelab, and
     the laptop's 5 GB next to the Mongo shard that already depends on it.

### Production runbook for layout B (not applied; needs approval and node-2 access)

Access needed, none of which exists today: a key-based login to velora-node-2 (`100.86.68.16`, user
that can run docker; the two keys tried got `publickey` denied) and permission to open TCP 6335
(Raft and shard transfer) and 6333 (REST) between the three tailnet addresses (homelab
`100.102.228.48`, laptop `100.104.227.44`, node-2 `100.86.68.16`). The Qdrant API key and CA stay
where they are; node-2 would receive the API key, the new server certificate and key, and the CA
certificate only.

1. Before: `pair-backup.sh` (about 2 minutes), `verify-parity --list-all`, `stale-ready`,
   `reel-search-smoke.cjs` for the latency baseline (p50 317-326 ms, p95 429-458 ms).
2. Re-issue the server certificate from the existing CA (`qdrant-secrets/ca.key`) with SANs
   `qdrant`, and the three tailnet IPs (or DNS names). Peers verify SANs on port 6335.
3. Homelab overlay (outside git; the CI deploy drops it, re-apply with
   `ensure-reel-indexing-qdrant`): add `QDRANT__CLUSTER__ENABLED=true`,
   `QDRANT__CLUSTER__P2P__ENABLE_TLS=true`, command `--uri https://100.102.228.48:6335`, publish
   `100.102.228.48:6335`, mount the new certificate. This recreates the Qdrant container:
   **downtime** about 6 s in the rehearsal, budget 30-60 s in production (start period and readiness
   check); semantic search returns no vector hits and the indexers' publication retries meanwhile.
   Text and tag search are unaffected.
4. Laptop and node-2: start Qdrant with the same image, config and certificate, `--bootstrap
   https://100.102.228.48:6335 --uri https://<own tailnet IP>:6335`. Confirm `GET /cluster` shows
   three peers and a leader.
5. Re-roll the laptop until its peer id is below the homelab's. Re-create the alias `velora_reel_semantic` through consensus (it predates cluster mode and does not reach new peers; see the layout D section). Then
   `POST /collections/<c>/cluster {replicate_shard: {shard_id: 0, from_peer_id: homelab, to_peer_id: laptop, method: "snapshot"}}`,
   wait for Active, `PATCH` the collection `replication_factor: 2` (leave `write_consistency_factor` 1).
   Do not replicate to node-2 and never recreate the collection.
6. After: `created_at` unchanged, counts equal, `verify-parity --list-all` (`recordsConsistent`),
   `stale-ready`, `reel-search-smoke.cjs`, a test write batch (expect under 1 s).
7. Rollback: `DELETE /cluster/peer/<laptop>?force=true` and `<node-2>`, then recreate the homelab
   container from the previous overlay (cluster off). The rehearsal shows a node that was in cluster
   mode returns to single-node mode with the collection, count and `created_at` intact (1.4 s). Not
   rehearsed with peers that were removed first; the fallback is the paired backup restore (227 s).
8. Add monitoring first: peer count, Raft term changes, replica state, write error rate. None exists.

Decision for the owner: B gives a warm copy on the laptop and about twice the read capacity if
queries are sent there, at the price of a cluster mode change on production, a 30-60 s search
interruption, a new certificate, two new nodes to operate, and an unchanged single point for
writes (the homelab). It does not give automatic write failover.

## Layout D rehearsal: two Qdrant nodes on the homelab host and one on the laptop (no node-2)

Rehearsed 2026-11-26 on disposable containers only (`cluster-rehearsal/rehearse4.py`; logs kept
outside the repo). Nothing on any production host or Qdrant was touched. Setup as for the
three-node rehearsal, but only the homelab-laptop link is emulated (netem, 6 ms one way with 3 ms
jitter, 25 % correlation, plus spikes to 40 ms for 3 s every 30 s in the soak); the two homelab
nodes talk locally. H1 (`h`, 1 CPU, 768 MB) holds the replica and serves queries, H2 (`m`, 0.5 CPU,
384 MB, own storage and peer port) is a data-less Raft voter, L (`l`, the laptop) holds the second
replica; replication_factor 2, write_consistency_factor 1. D2 additionally replicates to H2
(replication_factor 3). All nodes are x86; the real homelab is ARM64 (untested).

| Question | Result |
| --- | --- |
| 1. Formation on existing storage | restart 1.3 s, 11,316 points, `created_at` identical on all three peers; laptop replica by snapshot 4.3 s (D) and 8.2 s (D2), H2 replica 4.2 s. **Found: the alias `velora_reel_semantic` does not reach the new peers.** It was created before cluster mode, so `GET /aliases` on H2 and the laptop is empty (the adapter's `identity()` would fail there). Re-creating it through consensus fixes it for all peers: one request with `delete_alias` then `create_alias` for the same name (200 in 0.2 s). This applies to every layout in this document, including B |
| 2. Kill H1 (D) | search answered on H2 and the laptop (2/2, 3-5 ms); Raft leader moved to H2 immediately; replica marked Dead; topology operations worked (0.5 s); strict writes (`ordering=strong`) **depend on the peer ids**, see 4: with the laptop holding the highest id they succeeded (0.04-0.7 s); with H1 holding it they fail with HTTP 500 for the whole 40 s. `medium` writes succeed either way. Restart: ready in 6-10 s, converged within 0.1 s |
| Kill H2 (D) | no effect: search 2/2, strict writes succeed (0.1-0.6 s), topology works; restart ready in 3.5-9 s |
| Kill L (D) | search 2/2; strict writes succeed if H1 holds the highest id among the replica holders (verified 27-60 ms for 60 s), fail (500) if the laptop does; topology works; restart ready in 4.7-10 s |
| Kill H1 and H2 together (host loss, D) | the laptop alone: search answers (2/2, 3-5 ms); topology operations fail (500 after 10 s, one voter of three); strict writes fail (500) when H1 held the highest id, and when the laptop held it they hung 12 s twice and then succeeded at 40 s (59 ms), which cannot be relied on; `medium` write took 6 s. After the host returns: ready in 6.5-8 s, converged within 0.1 s, counts equal; the isolated laptop's Raft term had climbed to 22-23 (harmless) |
| D2 (replica also on H2), same four kills | identical outcome to D: H1 holds the highest id, so killing H1 stops strict writes even though two replicas are alive; killing H2 or L is harmless; host loss leaves the laptop searchable but not writable. D2 therefore adds no write availability and no host-loss protection |
| 3. Host loss: laptop as a standalone writable Qdrant | works, 2.7 s of manual steps. Steps: (1) stop the laptop container (0.7 s); (2) offline, edit `collections/<c>/0/replica_state.json` on its storage so `peers` holds only its own peer id (original kept as `.orig`; 0.4 s); (3) start the same storage with cluster mode off, i.e. without `QDRANT__CLUSTER__ENABLED` and the `--uri` argument (ready in 1.2 s, green at once); (4) make sure the alias exists (create it if absent, see 1). Verified afterwards: `created_at` unchanged (so the collection fingerprint is), 11,316 points before and all present after (11,700 once the test writes are counted), 1,024 float32 cosine, no quantization, status green, search 3/3, strict writes 200 in 25-35 ms, `GET /cluster` says disabled. **Skipping step 2 leaves strict writes failing** ("no address found for peer <dead>"; `medium` and `weak` work; `drop_replica` is refused in standalone mode with HTTP 405). Rebuild afterwards: the old homelab storage diverges from the laptop's, so re-join it as a new peer from the laptop's data after wiping it; not rehearsed |
| 4. The peer-id rule | tied to the highest peer id among the nodes that **hold a replica**, not among all peers. Case X (H2 highest of all, H1 highest holder, ids m > h > l): killing H2 did not stop strict writes, killing the laptop did not, killing H1 did. Case Y (laptop highest of all and of the holders): killing the laptop stopped them, H2 and H1 did not. The unforced D formation (H2 highest overall, laptop highest holder) gave the same pattern. Nine kills, all consistent with the rule. Inference from observation, not from Qdrant documentation |
| 5. Write latency, 128-point batch, strong, wait=true | D, ids as formed (laptop highest holder, so writes go to the laptop): through H1 median 0.49 s, max 0.83 s (wcf 1), 0.55 s / 1.5 s (wcf 2). D2 with H1 highest: through H1 0.20 s / 0.96 s (wcf 1), 0.24 s / 0.28 s (wcf 2); via the laptop 0.63 s / 0.92 s. Read-back of every point straight after each write (the projection worker's verify): 0 batches with missing points, 27-62 ms. Nothing near the 5 s deadline. The 6 ms link costs 0.2-0.5 s per batch |
| 6. Reads | a query to H1 is answered by H1's own replica (0 internal requests in 60 queries). With `read_fan_out_factor` 1, 20-27 of 40 queries sent one sub-request to the laptop. Closed-loop exact search over 6,000 ids, 12 threads: H1 alone 113 qps (median 102 ms, p95 163 ms); H1 + laptop 198 qps (median 51 ms, p95 107 ms), 1.75 times; **H2 alone 84 qps**: a data-less node forwards each query to a replica, so pointing the single `QDRANT_URL` at H2 spreads reads over H1 and the laptop with no client change and keeps answering when H1 dies (search 2/2 with H1 killed). H1 + H2 141 qps. A first, noisier run on the same machine gave 34 / 63 qps, the same ratio of 1.8. In D2 the H2 replica adds nothing real: it shares the homelab's CPU (the host already runs near its limit), and measured H1+H2 109 qps against 58 qps for H1 alone only because the rehearsal gives H2 its own CPU quota |
| 7. Raft stability, 10 minutes, laptop link at 6 ms with 40 ms spikes, 119 writes of 128 points in minutes 3-8 | 0 term changes, 0 leader changes, 0 samples without a leader on 120 samples of each node; 0 write failures, median 0.23 s, max 1.7 s; one transient connection reset between H2 and H1 left from an earlier kill. Laptop away for 60 s (container killed): with H1 the highest holder, strict writes kept succeeding (27-60 ms), search and topology operations worked, Raft stayed on H1; the laptop returned ready in 9.1 s, converged within 0.1 s, counts equal, no new election. With the laptop the highest holder, every strict write failed for the 60 s; the laptop returned ready in 4.7 s |

### Verdict on D

- **D is safe to operate for the failures it targets, with two conditions.** (a) H1 must hold the
  highest peer id among the replica holders: re-roll the laptop's id until it is lower than H1's
  (`rehearse4.py layout D form,order`); otherwise losing the laptop stops indexing. (b)
  `write_consistency_factor` stays 1. Alias recreation (1) is also required, in every cluster layout.
- **What D protects against:** loss of the laptop (no interruption: verified 60 s with writes at
  27-60 ms); loss of the H2 container; a crash of the H1 container for reads (search keeps answering
  on H2 and the laptop, and if `QDRANT_URL` points at H2 without any repoint); and loss of H1's
  storage, because the laptop holds a current copy (counts equal after every kill) that can seed a
  rebuild (rebuilding H1 from it was not rehearsed). It also gives about 1.8 times the read
  throughput if queries are spread over H1 and the laptop.
- **What it cannot protect against:** loss of the homelab host. Two of the three voters live there,
  so one voter remains: no topology operations, and strict writes fail unless the replica set is
  edited offline. The laptop keeps a full, current copy and can become a standalone writable
  Qdrant in about 3 seconds of manual work, but nothing in this plan runs the indexers, Content or
  AI services on the laptop, so search for users only returns if those are moved too (not rehearsed).
  An H1 crash still stops strict-ordered writes until H1 restarts (6-14 s), as today.
- **Against layout B:** D needs no node-2 (no login, no 217 ms replica, no extra host), keeps writes
  at 0.2-0.5 s, and gives the same laptop and container protection. B keeps a quorum when the
  homelab host dies (the laptop and node-2 are two of three voters), so the cluster stays
  operable (consensus works; `?force=true` removal of the dead peer would unblock writes, measured
  for other peers, not for the homelab node itself) instead of needing the offline edit. D is the
  simpler one to run; B is the only one that survives a host loss without surgery.
- **Two replicas on one host (D2) are not worth it:** no gain in strict-write availability (H1 still
  decides), no gain on host loss, no real read capacity on a host that is already CPU-bound, a larger
  write path and more memory. Keep H2 data-less (about 15 MiB in the rehearsal, against about 50 MiB
  for a replica).

### Runbook for D (attempted 2026-11-26, rolled back; production remains single-node)

Needs no node-2. Prerequisites: the TLS certificate re-issued from the existing CA with SANs for
the H1 and H2 peer addresses and the laptop's tailnet address (completed 2026-11-26 on the homelab),
port 6335 reachable from H2 and the laptop to H1, a non-internal bridge network alongside the
internal `reel-vector-net` so homelab Qdrant containers can reach the laptop over Tailscale, and the
standby already on the laptop untouched.

1. Take a paired backup; record baseline latency.
2. H1: add `QDRANT__CLUSTER__ENABLED=true`, `QDRANT__CLUSTER__P2P__ENABLE_TLS=true`,
   `QDRANT_URI=https://100.102.228.48:6335` (the deployed `master` `infra/qdrant/entrypoint.sh` on
   the homelab omits `"$@"`, so Compose `command: ["--uri", ...]` is ignored unless `entrypoint.sh`
   is deployed with `"$@"` or `QDRANT_URI`/`QDRANT_BOOTSTRAP` env vars are used), a `6335` listener
   on `100.102.228.48`, and a non-internal bridge network (`qdrant-cluster-net`) to the Qdrant
   overlay (outside git; the CI deploy drops the overlay for the indexers, so re-apply with
   `ensure-reel-indexing-qdrant`) and recreate: about 1.3 s of restart in the rehearsal, budget
   30-60 s (max 90 s) in production, during which vector search returns nothing.
3. Start H2 (second Qdrant container, own volume, 0.5 CPU, 384 MB) and the laptop node with
   `QDRANT_BOOTSTRAP=https://100.102.228.48:6335` (or `--bootstrap` once `"$@"` is deployed).
4. Re-create the alias through consensus (`delete_alias` and `create_alias` in one request).
5. Re-roll the laptop until its peer id is below H1's, then replicate the shard to it and set
   `replication_factor` 2. Do not replicate to H2.
6. Verify: counts, `created_at`, `verify-parity --list-all`, `stale-ready`, search smoke, a test
   write batch.
7. Optionally point `QDRANT_URL` at H2 for read failover (a one-line overlay change; the certificate
   SAN must cover H2). Note: rehearsal read-scaling showed H2 (`0.5` CPU) bottlenecks forwarding
   heavy exact queries and amplifies backend load back onto H1, so do not route normal read scaling
   through H2.
8. Rollback before the laptop is added or after: force-remove the peers, recreate H1 with cluster
   mode off (rehearsed: 1.4 s, count and `created_at` intact); fallback the paired backup restore
   (227 s).
9. Host-loss procedure, written down and drilled once: promote the PostgreSQL standby, run the four
   standalone steps above on the laptop, start the services against it.

## Production Layout D attempt and read-scaling results (2026-11-26)

### Production attempt and 90-second gate rollback (homelab + homelab 2)

1. **Gate A0 & A1 (passed):** homelab load1 `2.68`, RabbitMQ `reel_index_*` active queues `0`,
   `pair-backup.cjs quiesce` `quiet: true`, standby `walreceiver` `streaming` (`replay_lag: 41.9 ms`),
   homelab 2 available RAM `3,801 MiB`. Verified paired backup `74159ce7-deaa-4ddd-a53f-2977944b611d`
   completed in `126 s` (`10,885` current points across `298` projections, `11,316` points in Qdrant,
   `pg_dump` `126,664,547` bytes, R2 readback verified).
2. **Gate A2 (`C0` production single-node baseline, `scripts/ops/qdrant-read-stress.cjs` in a
   2-CPU container on `reel-vector-net`):**
   - `reel-search-smoke.cjs` (`24` queries, `8` scope-reels): `24/24` own chunk at rank 1,
     `p50 325 ms`, `p95 477 ms`.
   - `WIDE` (`10,885` points, `298` tuples, `535,259 B` body, `30 s` after `10 s` warmup):
     `28.26 qps` (`c=4`, `p50 136.94 ms`, `p95 170.73 ms`, `3/850 >250ms`), `28.25 qps` (`c=16`,
     `p50 556.97 ms`, `848/848 >250ms`), `26.34 qps` (`c=64`, `p50 2293.83 ms`, `835/835 >250ms`),
     `0` errors. Qdrant CPU `93.82-104.83%` (median `98.57%`), generator CPU `1.99-10.94%`.
   - `NARROW` (`8` reels, `CHUNK`, `21,347 B` body): `947.24 qps` (`c=4`, `p50 3.77 ms`),
     `962.24 qps` (`c=16`, `p50 13.07 ms`, `p95 40.16 ms`), `920.69 qps` (`c=64`, `p50 72.36 ms`,
     `p95 106.30 ms`), `0` errors, `0` >250 ms. Qdrant CPU `95.57-99.86%`, generator CPU `31.66-58.95%`
     (out of `200%`).
3. **Gate A3 (passed):** re-issued `~/velora-operations/qdrant-secrets/server.crt` from the existing
   CA (`ca.key`, `ca.crt`), keeping backup `server.crt.bak-20261125T190227Z`, with SANs
   `DNS:qdrant, DNS:qdrant-h2, DNS:localhost, IP:127.0.0.1, IP:100.102.228.48, IP:100.104.227.44`
   and EKU `serverAuth, clientAuth`.
4. **H1 recreate failed 90-second gate and rolled back:** `index-rollout.yml` was backed up to
   `index-rollout.yml.bak-20261125T190304Z` and updated with `qdrant` (`command: ["--uri", ...]`),
   `qdrant-h2`, and `qdrant-cluster-net`. Recreating `microservices-boilerplate-qdrant-1` panicked
   with `Can't initialize consensus: First peer should specify its uri.` because the homelab's
   `master` `infra/qdrant/entrypoint.sh` omits `"$@"`. The 90-second watchdog rolled back
   `index-rollout.yml` and recreated `microservices-boilerplate-qdrant-1` in single-node mode from
   `qdrant-staging/reviewed` (`cluster: disabled`, `status: green`, `11,316` points, `created_at`
   unchanged `2026-11-01T11:35:26.728Z`); total search outage was ~95-100 s. Post-rollback checks:
   `reel-search-smoke.cjs` `24/24` (`p50 329 ms`, `p95 443 ms`), `verify-parity --list-all=true`
   (`298/298` manifests, `10,885` verified points, `431` orphans, `recordsConsistent: true`),
   `stale-ready` `0`, `ensure-reel-indexing-qdrant --check` ok, standby streaming (`42.5 ms` lag).
   A subsequent **disposable** container test on the homelab verified that `QDRANT_URI=https://100.102.228.48:6335`
   starts cluster TLS and consensus cleanly with the homelab's unmodified `entrypoint.sh`.

### Phase B read-scaling experiment (rehearsal, not production)

Because production rolled back at the 90-second gate, Phase B was stopped on production and run
against the disposable three-node x86_64 Layout D rehearsal (`cluster-rehearsal/rehearse4.py`,
`11,316` points, `298` tuples, `r4-h` 1.0 CPU, `r4-m` 0.5 CPU data-less, `r4-l` 1.0 CPU behind
`6 ms ± 3 ms` symmetric `netem`, client RTT `0.3-0.5 ms` to `H1`/`H2` and `12.0-13.3 ms` to `L`).
Three rotated rounds (`R1: C1 C2 C3 C4`, `R2: C4 C3 C2 C1`, `R3: C2 C4 C1 C3`) across
`concurrencies=1,2,4,8,16,32,64` (`3 s` warmup + `12 s` measure) plus a `10 s` warmup + `45 s`
steady-state check on `C1` vs `C2` (`WIDE`):

| Scope (rehearsal, not prod) | Config | Knee c | Median saturated qps (min..max) | Ratio vs C1 (min..max) | Max Qdrant CPU |
| --- | --- | --- | --- | --- | --- |
| WIDE (`520 KB`, `11,316` pts) | `C1` (`H1`) | `1, 1, 1` | `22.57` (`21.95..23.17`) | `1.000` | `H1 105.8%` |
| WIDE | `C2` (`H1+L` RR) | `4, 4, 2` | `38.10` (`34.83..38.81`) | `1.644` (`1.543..1.768`) | `H1 103.1%`, `L 104.2%` |
| WIDE | `C3` (`H2` only) | `1, 1, 1` | `20.05` (`19.81..20.08`) | `0.888` (`0.867..0.903`) | `H2 51.5%`, `H1 104.2%`, `L 105.0%` |
| WIDE | `C4` (`H1+H2+L` RR) | `2, 2, 2` | `29.58` (`29.11..29.63`) | `1.313` (`1.256..1.348`) | `H1 105.6%`, `H2 51.7%`, `L 103.9%` |
| NARROW (`8` reels `CHUNK`) | `C1` (`H1`) | `2, 2, 2` | `620.92` (`616.58..625.78`) | `1.000` | `H1 103.6%` |
| NARROW | `C2` (`H1+L` RR) | `16, 16, 16` | `1067.15` (`1061.09..1070.17`) | `1.719` (`1.710..1.721`) | `H1 102.2%`, `L 103.5%` |
| NARROW | `C3` (`H2` only) | `2, 2, 2` | `241.57` (`239.06..244.75`) | `0.389` (`0.388..0.391`) | `H2 51.2%` |
| NARROW | `C4` (`H1+H2+L` RR) | `8, 8, 8` | `651.69` (`650.30..652.80`) | `1.050` (`1.039..1.059`) | `H1 105.6%`, `H2 51.7%`, `L 103.9%` |

Key findings (rehearsal, not production):
- **The replica increases saturated read throughput by ~1.64x-1.78x when querying `H1+L` directly (`C2`)**: `45 s + 10 s` `WIDE` steady state gave `37.46 qps` (`C2@c=4`, `p50 96.22 ms`, `9/1689 >250ms`) vs `21.02 qps` (`C1@c=4`, `p50 185.78 ms`, `13/949 >250ms`), a `1.782x` ratio while cutting `c=4` `p50` latency in half. On `NARROW`, `C2` needed `c=16` to fill the `12 ms` RTT pipe to `L` (`1067.15 qps`, `1.719x`); at low concurrency (`c=2`) round-robin paid the `12 ms` RTT half the time (`199.98 qps` vs `C1` `620.92 qps`).
- **Routing through data-less `H2` (`C3`, `C4`) hurts read scaling**: `H2` hit its `0.5` CPU cap (`51.2-51.7%`) and telemetry showed `1.32x-1.61x` internal gRPC sub-requests (`R1_C3`: `29,618` REST to `H2` produced `29,090` gRPC to `H1` plus `10,053` to `L`), overloading `H1` and leaving `C3` slower than `C1` (`0.888x` WIDE, `0.389x` NARROW).

## What lives outside git on the homelab, and how to re-apply

- `~/velora-operations/pair-backup/`: `repo/` (copy of `scripts/ops` and `infra/qdrant`),
  `work/` (pair directories including `pair-74159ce7-deaa-4ddd-a53f-2977944b611d`, `archives/`, sampler log), `pair-backup.env`, `sampler.sh`.
  Re-create by copying the repo directories and the config from
  `infra/qdrant/pair-backup/pair-backup.env.example`. `repo/scripts/ops/_dbg.cjs` is a debugging
  shim, not in git.
- `~/velora-operations/qdrant-secrets/server.crt`: re-issued on 2026-11-26 from existing `ca.key`/`ca.crt`
  with SANs for `qdrant`, `qdrant-h2`, `localhost`, `127.0.0.1`, `100.102.228.48`, `100.104.227.44`
  (original backed up as `server.crt.bak-20261125T190227Z`); currently served by single-node
  `microservices-boilerplate-qdrant-1`.
- `~/velora-operations/qdrant-staging/index-rollout.yml`: restored byte-for-byte to pre-change
  state (backup `index-rollout.yml.bak-20261125T190304Z` retained). Re-apply indexers after a CI
  deploy with `scripts/deploy/ensure-reel-indexing-qdrant --apply`.
- `~/velora-operations/read-scaling/`: `qdrant-read-stress.cjs`, `active-tuples.json`, `c0-smoke.out`,
  `c0-stress.log`, `c0-stats.log`, `post-rollback-smoke.out`.
- R2 objects under `velora-private-backups/reel-indexing-pairs/` (three pairs including
  `74159ce7-deaa-4ddd-a53f-2977944b611d`). Nothing was deleted anywhere.
- Standby pieces (see the standby section): forwarder container `reel-indexing-pg-forwarder`,
  `secrets/replicator_idx.pw`, the `replicator_idx` role, the `pg_hba` line and
  `max_slot_wal_keep_size` on the primary, and `/opt/velora/reel-indexing-standby/` on homelab 2.
  Re-apply from the steps in the standby section; the forwarder is not in any compose file and the
  CI deploy does not remove it.
- Host keys for `100.104.227.44` and `100.86.68.16` were added to the homelab user's
  `known_hosts` while probing access.
