DROP INDEX IF EXISTS "ReelDocument_embedding_hnsw_idx";
DROP INDEX IF EXISTS "ReelSection_embedding_hnsw_idx";
DROP INDEX IF EXISTS "ReelChunk_embedding_hnsw_idx";
DROP INDEX IF EXISTS "ReelVisualScene_embedding_hnsw_idx";

ALTER TABLE "ReelDocument" DROP COLUMN "embedding";
ALTER TABLE "ReelSection" DROP COLUMN "embedding";
ALTER TABLE "ReelChunk" DROP COLUMN "embedding";
ALTER TABLE "ReelVisualScene" DROP COLUMN "embedding";
ALTER TABLE "EmbeddingCacheEntry" DROP COLUMN "embedding";
