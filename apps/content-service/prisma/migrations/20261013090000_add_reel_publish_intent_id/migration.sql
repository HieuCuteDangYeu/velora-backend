ALTER TABLE "Reel" ADD COLUMN "publishIntentId" TEXT;

UPDATE "Reel"
SET "publishIntentId" = "id"
WHERE "publishIntentId" IS NULL;

ALTER TABLE "Reel" ALTER COLUMN "publishIntentId" SET NOT NULL;
ALTER TABLE "Reel" ALTER COLUMN "publishIntentId" SET DEFAULT gen_random_uuid()::text;

CREATE UNIQUE INDEX "Reel_userId_publishIntentId_key"
ON "Reel"("userId", "publishIntentId");
