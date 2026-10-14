CREATE TABLE "ReelUploadLease" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "publishIntentId" TEXT NOT NULL,
    "mediaKey" TEXT NOT NULL,
    "fileType" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "adoptedAt" TIMESTAMP(3),
    "cancelledAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ReelUploadLease_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "ReelUploadLease_userId_publishIntentId_fileType_key"
ON "ReelUploadLease"("userId", "publishIntentId", "fileType");

CREATE INDEX "ReelUploadLease_expiresAt_adoptedAt_cancelledAt_idx"
ON "ReelUploadLease"("expiresAt", "adoptedAt", "cancelledAt");

CREATE INDEX "ReelUploadLease_mediaKey_idx"
ON "ReelUploadLease"("mediaKey");
