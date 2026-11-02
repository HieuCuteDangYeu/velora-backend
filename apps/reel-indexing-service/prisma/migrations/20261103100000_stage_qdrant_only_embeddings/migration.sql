ALTER TABLE "ReelDocument" ALTER COLUMN "embedding" DROP NOT NULL;
ALTER TABLE "ReelSection" ALTER COLUMN "embedding" DROP NOT NULL;
ALTER TABLE "ReelChunk" ALTER COLUMN "embedding" DROP NOT NULL;
ALTER TABLE "ReelVisualScene" ALTER COLUMN "embedding" DROP NOT NULL;

ALTER TABLE "VectorProjection"
  ADD COLUMN "bundleKey" TEXT,
  ADD COLUMN "bundleSha256" TEXT;

ALTER TABLE "EmbeddingCacheEntry"
  ADD COLUMN "storageKey" TEXT,
  ADD COLUMN "sha256" TEXT,
  ADD COLUMN "offset" INTEGER;

CREATE INDEX "EmbeddingCacheEntry_storageKey_idx"
  ON "EmbeddingCacheEntry"("storageKey");
