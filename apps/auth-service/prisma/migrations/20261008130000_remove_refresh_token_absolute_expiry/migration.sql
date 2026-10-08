-- Remove the unused session cap while preserving token rows and recovery state.
BEGIN;
SET LOCAL lock_timeout = '5s';
ALTER TABLE "RefreshToken" DROP COLUMN "absoluteExpiresAt";
COMMIT;
