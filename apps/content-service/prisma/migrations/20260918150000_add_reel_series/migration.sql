CREATE TABLE "ReelSeries" (
    "id" TEXT NOT NULL,
    "ownerId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT,
    "visibility" TEXT NOT NULL DEFAULT 'public',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ReelSeries_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "Reel"
ADD COLUMN "seriesId" TEXT,
ADD COLUMN "episodeNumber" INTEGER;

CREATE INDEX "ReelSeries_ownerId_idx" ON "ReelSeries"("ownerId");
CREATE INDEX "ReelSeries_visibility_createdAt_idx" ON "ReelSeries"("visibility", "createdAt" DESC);
CREATE UNIQUE INDEX "Reel_seriesId_episodeNumber_key" ON "Reel"("seriesId", "episodeNumber");
CREATE INDEX "Reel_seriesId_episodeNumber_idx" ON "Reel"("seriesId", "episodeNumber");

ALTER TABLE "Reel"
ADD CONSTRAINT "Reel_seriesId_fkey"
FOREIGN KEY ("seriesId") REFERENCES "ReelSeries"("id") ON DELETE SET NULL ON UPDATE CASCADE;
