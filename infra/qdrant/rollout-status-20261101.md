# Reel Indexing Qdrant rollout: live status (2026-11-01)

## Verified in the live environment

- The production-named `microservices-boilerplate-qdrant-1` runs healthy on the private Docker network with TLS and API-key access. Its configured collection was initialized in an earlier operator run; **no vector import or reader cutover has occurred**.
- The SHORT and LONG Reel Indexing services still run `eaeb0df899d3ee020ba5acf95d5b2f63d5cc6bfa`, not the reviewed `c207b663` Qdrant implementation.
- The Aiven Reel Indexing database still lacks `VectorProjection`. The live SQL vector row counts are `ReelDocument=180`, `ReelChunk=1264`, `ReelSection=1`, and `ReelVisualScene=2375` (3,820 total).
- A 79 MiB `pg_dump` exists in the private remote operations directory. An off-host copy has matching SHA-256 `c86861d9c3e5dad599d62ec889e56c015adbfc439513c0318483e108b5457b43`.
- An isolated, disposable `pgvector/pgvector:pg18` restore **successfully restored all four vector tables and counts** from that dump, with vector extension 0.8.7. The full unmodified restore first failed because the provider-specific `aiven_extras` extension does not exist in the pgvector image. The successful data-recovery rehearsal filtered 27 `aiven_extras` entries from the dump TOC and used `--no-owner --no-acl`. Thus, it proves the application vector data can be restored; **it does not prove byte-for-byte recovery of Aiven-specific extensions, role ownership or privileges**. The disposable container was removed. The filtered TOC and command log are retained outside the repository in the private remote operations directory.

## Blocking live migration / cutover

`scripts/narto-scraper/sync.cjs` runs direct SQL deletes/inserts for ReelDocument and ReelChunk in both normal ingestion and `--index-queued`, without the reviewed projection journal or per-Reel lock. No active scraper process or obvious dedicated scheduler was observed in this inspection, but that does **not** prevent future runs of existing source copies.

The running indexers authenticate as `avnadmin`; `avnadmin` inherits membership of the `neondb_owner` role that owns all four SQL vector tables. The scraper also reads `REEL_INDEXING_DATABASE_URL` from the shared environment. Simply revoking direct table grants or stopping one process is therefore **not** an effective all-writer exclusion. This boundary must be resolved by a reviewed credential/ownership separation or a fully captured compatible writer path before production enrollment/export and publication.

## Next safe sequence

1. Inventory all manual, cron, CI and maintenance writers and establish enforceable SQL credential/permission isolation for the legacy scraper and any old revisions. Prove excluded identities cannot reconnect/write and have no remaining transactions.
2. Deploy the reviewed SHORT and LONG implementation with PostgreSQL reads and publication enforcement disabled, preserving query/delete RPC and draining/recovering active jobs. Apply the additive vector-projection migration at the reviewed schema stage.
3. Enable projection capture on **both** Indexing lanes; run bounded enrollment, checksum export, dry-run and actual Qdrant import, then reconcile until pending tasks and unready active candidates both reach zero. Verify counts, identity and access/score contracts.
4. Complete encrypted off-host Qdrant snapshot **and restore** proof, then publication enforcement and reader-first cutover/rollback rehearsals. Run a *new* immutable Qdrant-vs-Postgres benchmark; retain the frozen prior benchmark and SQL data.

**Status: PARTIAL / CUTOVER BLOCKED.** Qdrant availability and isolated SQL vector restoration are verified. Live projection migration, Qdrant data parity, role exclusion, off-host Qdrant recovery, query cutover and latency/quality improvement remain unproven.
