# Reel Indexing storage rollout — live status (2026-11-03)

## Live verified

- Final Prisma migration `20261103110000_remove_sql_embedding_vectors` is applied. `ReelDocument`, `ReelSection`, `ReelChunk`, `ReelVisualScene`, and `EmbeddingCacheEntry` no longer have an embedding column; all four HNSW embedding indexes are gone. The pgvector extension remains installed but Reel Indexing no longer queries it. There are zero SQL cache rows and zero pending projection tasks.
- A fresh Aiven Reel Indexing database dump is stored in the private homelab operations directory and copied off-host. Both copies have SHA-256 `6fedf341311505f44732fdcbe2ed98f7d59ba73d0a3942e5793ed8aaf9a4f49b`.
- The dump was restored into dedicated private `reel-indexing-postgres` on the homelab. It runs PostgreSQL 18.6 on ARM64 with pgvector 0.8.7; application login `reel_indexing_app` is non-superuser.
- A source/target comparison matched counts, active counts, null-vector counts and per-row JSON hashes for ReelDocument (180), ReelSection (1), ReelChunk (1,262), and ReelVisualScene (2,567). It also matched 801 attempts, 4,350 cache rows, 188 projection generations, zero pending projection tasks and the completed Prisma migration history. The provider-only `aiven_extras` extension entries were excluded from restore; this is an application database restore, not an exact provider-role/extension clone.
- Both SHORT and LONG indexers connect to `reel-indexing-postgres`, with Qdrant retrieval, projection capture and publication enforcement enabled. They run `velora-reel-indexing-qdrant:6ca1491e`.
- Reconciliation completes with `pending=0`, `unreadyActiveCandidates=0`, and 180 ready generations. Point-manifest verification reports 3,986 Qdrant points, matching the ready projection point count.
- Three end-to-end indexing canary attempts were made; two completed successfully, including one after the final SQL schema migration. The final canary produced a Reel document and two chunks, wrote no embeddings into PostgreSQL, published the R2-staged bundle to Qdrant, completed Content, and returned the exact candidate through `index.search_reels` at rank 1. The first attempt exposed and led to a fix for premature cache cleanup. Visual analysis for the canaries was skipped because the configured Cloudflare vision account had reached its daily quota; it did not block semantic indexing.
- The legacy 4,350-row SQL embedding cache was moved to checksummed R2 staging, then cache metadata and 137 R2 cache batches were purged after confirming there were no active attempts or projection tasks. Two source attempts whose Content records were already `COMPLETED/READY` were reconciled to `COMPLETED` in the local Indexing target; no attempts remain `PROCESSING`.
- The final PostgreSQL dump `reel-indexing-qdrant-only-final.dump` is stored locally and off-host with SHA-256 `7a1a0c46f194063043fd564832b5acba1f31e601992b0e1437f9a2c61652a43f`. Encrypted Qdrant archive `velora-qdrant-1793649660332-aaf5a960-3cd7-4f8b-a13f-c3c8e2e237a4.vqb` has SHA-256 `9a3d704872c267449c659fa53b5173f914b0f0918a7b2716e969fef9afda2d89` and is in the private R2 backup prefix. Its isolated restore verified 3,986 points and 16 sampled vectors, then deleted its temporary collection.
- Twelve scoped RPC searches using existing vectors had p50 96.7 ms and p95 137.8 ms on the relocated database. An earlier same-query sample logged 1,089 ms total against Aiven and 177 ms after relocation; these observations are not a statistically rigorous relevance/latency benchmark.
- After the final schema migration, a full read-only parity operation retrieved all 3,986 Qdrant points across 180 current generations and recomputed every manifest against PostgreSQL metadata. It returned `complete=true`, zero pending tasks and zero unready active candidates. A post-migration scoped RPC smoke also returned the active candidate from Qdrant at rank 1.
- The dedicated PostgreSQL container was restarted after cutover; it returned healthy on its persistent volume and the post-restart Qdrant RPC smoke passed.
- The Aiven database and its off-host source dump remain intact. The Aiven DB had zero other sessions at the last read-only check.

## Remaining operational follow-up

- The additive staging migrations `20261103100000_stage_qdrant_only_embeddings` and `20261103101500_allow_external_embedding_cache` are applied.
- The final migration `20261103110000_remove_sql_embedding_vectors` is applied. PostgreSQL has zero `embedding` columns in the semantic or cache tables and zero semantic HNSW indexes. The pgvector extension remains installed but the Reel Indexing service no longer requires it.
- The current scraper source queues indexing through Content RPC. The old source copy in the original homelab checkout still contains its direct SQL writer; it was not running and no matching crontab/launchd entry was found. Keep that copy disabled until the updated source is deployed there.
- The 12-query retrieval sample is not a relevance evaluation, and the canaries had no visual scenes because of the provider quota. Existing visual-scene retrieval was checked from Qdrant; a new visual-scene indexing canary and judged recommendation-quality comparison remain unproven.
- The deployed private Compose override retains the database URL and service flags through indexing-container restarts. A full host reboot/release-controller redeploy has not been exercised.

**Status: storage migration complete; development canary, exact manifest parity and isolated recovery pass.** PostgreSQL owns indexing content, lexical search and lifecycle state; Qdrant is the sole persistent Reel vector store. The Aiven source dump and final target dump remain available for comparison/rollback, and the encrypted Qdrant snapshot is in R2. Keep the dedicated PostgreSQL volume, R2 backup key, and private `.env.qdrant-indexing`/password files. Future restarts must use the Qdrant/indexing rollout overlay.

## Update 2026-11-09: database merge and cutover

The indexers had been using the Aiven database since the 2026-11-06 overlay re-apply, because the private overlay takes
`REEL_INDEXING_DATABASE_URL` from the root `.env`. Aiven and the dedicated Postgres had diverged (Aiven: 71 reels reindexed by the
visual-reindex job; dedicated Postgres: 79 reels Aiven never indexed, plus a few newer attempts). The two were merged per reel,
keeping the projection with the highest generation whose Qdrant point count matches in full (Aiven on ties), and the merged
database became `reel_indexing` on the dedicated Postgres. Validation: 257 reels, one active document each, every projection
ready with matching epoch, fingerprint and collection, Qdrant counts equal to `pointCount`, and a real `index.search_reels` over
all 257 reels returned four deliberately awkward reels at rank 1. The previous dedicated database was kept as
`reel_indexing_pre_merge_20261109`; Aiven is untouched. About 435 superseded Qdrant points remain unreferenced. The root `.env`
now carries the dedicated database URL and the `INDEX_VECTOR_*` / `QDRANT_*` settings so the overlay and the plain Compose model
agree.
