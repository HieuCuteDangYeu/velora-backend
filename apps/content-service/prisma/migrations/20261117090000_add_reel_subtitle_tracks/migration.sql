CREATE TABLE "ReelSubtitleTrack" (
  "id" TEXT NOT NULL,
  "reelId" TEXT NOT NULL,
  "language" TEXT NOT NULL,
  "sourceHash" TEXT NOT NULL,
  "cues" JSONB NOT NULL,
  "model" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "ReelSubtitleTrack_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "ReelSubtitleTrack_reelId_fkey" FOREIGN KEY ("reelId") REFERENCES "Reel"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "ReelSubtitleTrack_reelId_language_key" ON "ReelSubtitleTrack"("reelId", "language");
