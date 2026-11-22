-- Accounts are banned, not deleted. Additive: existing rows become ACTIVE.
CREATE TYPE "UserStatus" AS ENUM ('ACTIVE', 'BANNED');

ALTER TABLE "User"
ADD COLUMN "status" "UserStatus" NOT NULL DEFAULT 'ACTIVE',
ADD COLUMN "bannedAt" TIMESTAMP(3),
ADD COLUMN "banReason" TEXT,
ADD COLUMN "bannedBy" TEXT;
