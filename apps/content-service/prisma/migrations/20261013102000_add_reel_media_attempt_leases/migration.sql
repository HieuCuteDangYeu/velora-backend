CREATE TABLE "ReelMediaAttemptLease" (
    "attemptId" TEXT NOT NULL,
    "reelId" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "completedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ReelMediaAttemptLease_pkey" PRIMARY KEY ("attemptId")
);

CREATE INDEX "ReelMediaAttemptLease_expiresAt_completedAt_idx"
ON "ReelMediaAttemptLease"("expiresAt", "completedAt");

CREATE INDEX "ReelMediaAttemptLease_reelId_idx"
ON "ReelMediaAttemptLease"("reelId");
