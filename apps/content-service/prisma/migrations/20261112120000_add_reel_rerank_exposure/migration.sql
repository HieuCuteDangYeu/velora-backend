CREATE TABLE "ReelRerankExposure" (
  "feedSessionId" TEXT NOT NULL,
  "reelId" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "arm" TEXT NOT NULL,
  "baseRank" INTEGER NOT NULL,
  "rerankedRank" INTEGER NOT NULL,
  "crossScore" DOUBLE PRECISION NOT NULL,
  "topK" INTEGER NOT NULL,
  "weight" DOUBLE PRECISION NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "ReelRerankExposure_pkey" PRIMARY KEY ("feedSessionId", "reelId")
);
CREATE INDEX "ReelRerankExposure_userId_createdAt_idx" ON "ReelRerankExposure"("userId", "createdAt");
CREATE INDEX "ReelRerankExposure_createdAt_idx" ON "ReelRerankExposure"("createdAt");
