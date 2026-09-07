CREATE TABLE "ReelIndexQualityReview" (
  "id" TEXT NOT NULL,
  "reelId" TEXT NOT NULL,
  "indexAttemptId" TEXT NOT NULL,
  "indexVersion" TEXT NOT NULL,
  "embeddingProvider" TEXT NOT NULL,
  "embeddingModel" TEXT NOT NULL,
  "embeddingDimensions" INTEGER NOT NULL,
  "embeddingVersion" TEXT NOT NULL,
  "acceptable" BOOLEAN NOT NULL,
  "confidence" DOUBLE PRECISION NOT NULL,
  "summary" TEXT NOT NULL,
  "issues" JSONB NOT NULL,
  "reviewProvider" TEXT NOT NULL,
  "reviewModel" TEXT NOT NULL,
  "reviewVersion" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "ReelIndexQualityReview_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "ReelIndexQualityReview_reelId_indexAttemptId_key"
  ON "ReelIndexQualityReview"("reelId", "indexAttemptId");
CREATE INDEX "ReelIndexQualityReview_reelId_createdAt_idx"
  ON "ReelIndexQualityReview"("reelId", "createdAt");
CREATE INDEX "ReelIndexQualityReview_indexAttemptId_idx"
  ON "ReelIndexQualityReview"("indexAttemptId");

CREATE TABLE "RagEvaluationRun" (
  "benchmarkRunId" TEXT NOT NULL,
  "datasetName" TEXT NOT NULL,
  "datasetVersion" TEXT NOT NULL,
  "datasetHash" TEXT NOT NULL,
  "productionSha" TEXT NOT NULL,
  "configHash" TEXT NOT NULL,
  "providerConfig" JSONB NOT NULL,
  "status" TEXT NOT NULL,
  "hardGatePass" BOOLEAN,
  "ragasRun" BOOLEAN NOT NULL DEFAULT false,
  "summaryMetrics" JSONB NOT NULL,
  "artifactHash" TEXT NOT NULL,
  "startedAt" TIMESTAMP(3),
  "completedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "RagEvaluationRun_pkey" PRIMARY KEY ("benchmarkRunId")
);

CREATE INDEX "RagEvaluationRun_datasetName_datasetVersion_createdAt_idx"
  ON "RagEvaluationRun"("datasetName", "datasetVersion", "createdAt");

CREATE TABLE "RagEvaluationCase" (
  "id" TEXT NOT NULL,
  "benchmarkRunId" TEXT NOT NULL,
  "caseId" TEXT NOT NULL,
  "reelId" TEXT,
  "indexAttemptId" TEXT,
  "traceId" TEXT,
  "status" TEXT NOT NULL,
  "recallAt1" DOUBLE PRECISION,
  "recallAt3" DOUBLE PRECISION,
  "recallAt5" DOUBLE PRECISION,
  "recallAt10" DOUBLE PRECISION,
  "mrr" DOUBLE PRECISION,
  "ndcgAt5" DOUBLE PRECISION,
  "ndcgAt10" DOUBLE PRECISION,
  "evidenceHit" DOUBLE PRECISION,
  "citationPrecision" DOUBLE PRECISION,
  "citationRecall" DOUBLE PRECISION,
  "wrongReel" BOOLEAN,
  "wrongModality" BOOLEAN,
  "accessViolation" BOOLEAN,
  "answerCorrect" DOUBLE PRECISION,
  "grounded" DOUBLE PRECISION,
  "faithfulness" DOUBLE PRECISION,
  "factualCorrectness" DOUBLE PRECISION,
  "responseRelevancy" DOUBLE PRECISION,
  "contextPrecision" DOUBLE PRECISION,
  "contextRecall" DOUBLE PRECISION,
  "failureCategory" TEXT,
  "metrics" JSONB NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "RagEvaluationCase_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "RagEvaluationCase_benchmarkRunId_fkey"
    FOREIGN KEY ("benchmarkRunId") REFERENCES "RagEvaluationRun"("benchmarkRunId")
    ON DELETE RESTRICT ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "RagEvaluationCase_benchmarkRunId_caseId_key"
  ON "RagEvaluationCase"("benchmarkRunId", "caseId");
CREATE INDEX "RagEvaluationCase_caseId_idx"
  ON "RagEvaluationCase"("caseId");
CREATE INDEX "RagEvaluationCase_reelId_indexAttemptId_idx"
  ON "RagEvaluationCase"("reelId", "indexAttemptId");
