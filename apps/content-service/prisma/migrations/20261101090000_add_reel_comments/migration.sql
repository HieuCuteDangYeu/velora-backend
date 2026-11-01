ALTER TABLE "Reel" ADD COLUMN "commentCount" INTEGER NOT NULL DEFAULT 0;
CREATE TABLE "ReelComment" (
  "id" TEXT NOT NULL,
  "reelId" TEXT NOT NULL,
  "authorId" TEXT NOT NULL,
  "parentId" TEXT,
  "clientRequestId" TEXT NOT NULL,
  "fingerprint" TEXT NOT NULL,
  "text" TEXT NOT NULL,
  "replyCount" INTEGER NOT NULL DEFAULT 0,
  "deletedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "ReelComment_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "ReelComment_reelId_fkey" FOREIGN KEY ("reelId") REFERENCES "Reel"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "ReelComment_parentId_fkey" FOREIGN KEY ("parentId") REFERENCES "ReelComment"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "ReelComment_authorId_clientRequestId_key" ON "ReelComment"("authorId", "clientRequestId");
CREATE INDEX "ReelComment_reelId_parentId_createdAt_id_idx" ON "ReelComment"("reelId", "parentId", "createdAt", "id");
