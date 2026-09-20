ALTER TABLE "RefreshToken"
ADD COLUMN "replacedByToken" TEXT,
ADD COLUMN "rotatedAt" TIMESTAMP(3);
