# Reel Indexing storage rollout — live status (2026-11-03)

## Live verified

- A fresh Aiven Reel Indexing database dump is stored in the private homelab operations directory and copied off-host. Both copies have SHA-256 `6fedf341311505f44732fdcbe2ed98f7d59ba73d0a3942e5793ed8aaf9a4f49b`.
- The dump was restored into dedicated private `reel-indexing-postgres` on the homelab. It runs PostgreSQL 18.6 on ARM64 with pgvector 0.8.7; application login `reel_indexing_app` is non-superuser.
- A source/target comparison matched counts, active counts, null-vector counts and per-row JSON hashes for ReelDocument (180), ReelSection (1), ReelChunk (1,262), and ReelVisualScene (2,567). It also matched 801 attempts, 4,350 cache rows, 188 projection generations, zero pending projection tasks and the completed Prisma migration history. The provider-only `aiven_extras` extension entries were excluded from restore; this is an application database restore, not an exact provider-role/extension clone.
- Both SHORT and LONG indexers connect to `reel-indexing-postgres`, with Qdrant retrieval, projection capture and publication enforcement enabled. They run `velora-reel-indexing-qdrant:c0965e02`.
- Reconciliation completes with `pending=0`, `unreadyActiveCandidates=0`, and 180 ready generations. Point-manifest verification reports 3,986 Qdrant points, matching the ready projection point count.
- The new indexing canary completed successfully. Its Reel document and two chunks have SQL `embedding=NULL`; the R2 candidate bundle was published and removed after Qdrant verification and Content completion. The exact candidate vector returned through `index.search_reels` at rank 1. Visual analysis for this Reel was skipped because the configured Cloudflare vision account had reached its daily quota; it did not block semantic indexing.
- The legacy 4,350-row SQL embedding cache was moved to checksummed R2 staging, then cache metadata and 137 R2 cache batches were purged after confirming there were no active attempts or projection tasks. Two source attempts whose Content records were already `COMPLETED/READY` were reconciled to `COMPLETED` in the local Indexing target; no attempts remain `PROCESSING`.
- A fresh pre-cleanup PostgreSQL dump is stored locally and off-host with SHA-256 `0bc9c78473957f57939b35c2a067dd86bdf6e6e55115deba5030953178ad277e8`. A Qdrant collection snapshot was encrypted and uploaded to R2 with ciphertext readback verification; isolated restore verified 3,986 points and 16 sampled vectors, then deleted its temporary collection.
- Twelve scoped RPC searches using existing vectors had p50 96.7 ms and p95 137.8 ms on the relocated database. An earlier same-query sample logged 1,089 ms total against Aiven and 177 ms after relocation; these observations are not a statistically rigorous relevance/latency benchmark.
- The Aiven database and its off-host source dump remain intact. The Aiven DB had zero other sessions at the last read-only check.

## Remaining implementation and acceptance

- The additive staging migrations `20261103100000_stage_qdrant_only_embeddings` and `20261103101500_allow_external_embedding_cache` are applied.
- The final forward migration `20261103110000_remove_sql_embedding_vectors` is committed locally but not yet applied. It removes four PostgreSQL embedding columns, the JSON cache vector column and HNSW indexes. The SQL vector columns are still present with historical vectors; the new writer does not populate them.
- The scraper source now queues reindexing through Content RPC and no longer writes semantic rows directly. The updated runner source is committed locally; no running scraper process was observed. Older copied scraper binaries should remain disabled.
- The 12-query retrieval sample is not a relevance evaluation, and the canary had no visual scenes because of the provider quota. A newly indexed visual-scene canary and content-quality comparison remain unproven.
- Normal restart/deploy preservation of the private overlay and same-server PostgreSQL service is configured in the reviewed rollout file but has not yet been exercised after the final SQL cleanup.

**Status: PostgreSQL relocation complete; Qdrant retrieval and new vector publication live; final SQL-vector removal pending.** The Aiven source dump and fresh target dump remain available for rollback. Keep the dedicated PostgreSQL volume, R2 backup key, and private `.env.qdrant-indexing`/password files. Future restarts must use the Qdrant/indexing rollout overlay.
