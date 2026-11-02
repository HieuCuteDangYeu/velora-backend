# Reel Indexing storage rollout — live status (2026-11-03)

## Live verified

- A fresh Aiven Reel Indexing database dump is stored in the private homelab operations directory and copied off-host. Both copies have SHA-256 `6fedf341311505f44732fdcbe2ed98f7d59ba73d0a3942e5793ed8aaf9a4f49b`.
- The dump was restored into dedicated private `reel-indexing-postgres` on the homelab. It runs PostgreSQL 18.6 on ARM64 with pgvector 0.8.7; application login `reel_indexing_app` is non-superuser.
- A source/target comparison matched counts, active counts, null-vector counts and per-row JSON hashes for ReelDocument (180), ReelSection (1), ReelChunk (1,262), and ReelVisualScene (2,567). It also matched 801 attempts, 4,350 cache rows, 188 projection generations, zero pending projection tasks and the completed Prisma migration history. The provider-only `aiven_extras` extension entries were excluded from restore; this is an application database restore, not an exact provider-role/extension clone.
- Both SHORT and LONG indexers now connect to `reel-indexing-postgres`, with Qdrant retrieval, projection capture and publication enforcement enabled. They run `velora-reel-indexing-qdrant:30405eea`.
- Reconciliation against the restored SQL database completed with `pending=0`, `unreadyActiveCandidates=0`, `complete=true`. A scoped Reel Indexing RPC smoke test returned the expected result through Qdrant. Telemetry for that query recorded Qdrant 157 ms, SQL 19 ms, total 177 ms. An earlier single Aiven-backed smoke request recorded SQL 952 ms and total 1,089 ms; these single requests are indicative only, not a benchmark.
- The old Aiven database remains intact. At the last check it had zero other active sessions while inspected from an independent connection.

## Remaining implementation and acceptance

- The next image must deploy the R2-backed temporary embedding cache and per-candidate vector bundle writer. The live service still runs `30405eea`; SQL embeddings have not been removed.
- `scripts/narto-scraper/sync.cjs` was changed locally to queue indexing through Content RPC. That version is not deployed to scraper runners yet.
- The additive staging migration `20261103100000_stage_qdrant_only_embeddings` is local and has not yet been applied to the target database.
- The two source attempts still marked PROCESSING have no updates since `2026-10-02T02:11:41.703Z` and no active database work. Their Content-side disposition remains to be checked before closure.
- The complete detailed vector validation result, a new-Reel indexing canary, multi-query retrieval/access/lexical comparison, Qdrant off-host backup/restore exercise, final SQL vector-column/index removal, and automatic restart/deploy verification are not yet proven.

**Status: PostgreSQL relocation complete; Qdrant retrieval live; SQL-vector removal in progress.** The Aiven backup remains the rollback source. The dedicated PostgreSQL volume and private `.env.qdrant-indexing`/password files must be preserved. Future restarts must use the Qdrant/indexing rollout overlay.
