ALTER TABLE "RefreshToken"
ADD COLUMN "encryptedToken" TEXT,
ADD COLUMN "absoluteExpiresAt" TIMESTAMP(3),
ADD COLUMN "replacedByTokenId" TEXT,
ADD COLUMN "rotationRequestId" TEXT,
ADD COLUMN "rotationRequestExpiresAt" TIMESTAMP(3);
