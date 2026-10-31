CREATE TABLE "VectorReelState" ("reelId" TEXT PRIMARY KEY, "generation" BIGINT NOT NULL DEFAULT 0, "deleted" BOOLEAN NOT NULL DEFAULT false);
CREATE TABLE "VectorCollectionState" ("maintenance" BOOLEAN NOT NULL DEFAULT false, "collection" TEXT PRIMARY KEY, "fingerprint" TEXT NOT NULL, "epoch" TEXT NOT NULL, "updatedAt" TIMESTAMP(3) NOT NULL);
CREATE TABLE "VectorProjection" (
  "reelId" TEXT NOT NULL, "indexAttemptId" TEXT NOT NULL, "generation" BIGINT NOT NULL,
  "manifestHash" TEXT NOT NULL, "pointCount" INTEGER NOT NULL, "revoked" BOOLEAN NOT NULL DEFAULT false,
  "readyCollection" TEXT, "readyFingerprint" TEXT, "readyEpoch" TEXT, "readyAt" TIMESTAMP(3),
  "previousIndexAttemptId" TEXT, "previousGeneration" BIGINT,
  "publicationPhase" TEXT NOT NULL DEFAULT 'STAGED' CHECK ("publicationPhase" IN ('STAGED', 'ACTIVATED', 'COMPENSATED', 'FINALIZED')),
  "continuation" JSONB, "continuationToken" TEXT, "continuationUntil" TIMESTAMP(3),
  "continuationAfter" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY ("reelId", "generation")
);
CREATE INDEX "VectorProjection_reelId_indexAttemptId_revoked_idx" ON "VectorProjection" ("reelId", "indexAttemptId", "revoked");
CREATE TABLE "VectorProjectionTask" (
  "id" BIGSERIAL PRIMARY KEY, "reelId" TEXT NOT NULL, "generation" BIGINT NOT NULL,
  "operation" TEXT NOT NULL CHECK ("operation" IN ('UPSERT', 'DELETE')),
  "attempts" INTEGER NOT NULL DEFAULT 0, "availableAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "leaseToken" TEXT, "leaseUntil" TIMESTAMP(3), "completedAt" TIMESTAMP(3), "lastError" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE UNIQUE INDEX "VectorProjectionTask_reelId_generation_operation_key" ON "VectorProjectionTask" ("reelId", "generation", "operation");
CREATE INDEX "VectorProjectionTask_completedAt_availableAt_idx" ON "VectorProjectionTask" ("completedAt", "availableAt");
