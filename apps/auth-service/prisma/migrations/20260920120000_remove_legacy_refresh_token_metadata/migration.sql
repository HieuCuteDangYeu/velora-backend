UPDATE "RefreshToken" AS previous_token
SET "replacedByTokenId" = replacement_token."id"
FROM "RefreshToken" AS replacement_token
WHERE previous_token."replacedByToken" IS NOT NULL
  AND previous_token."replacedByTokenId" IS NULL
  AND replacement_token."token" = previous_token."replacedByToken";

DO $$
DECLARE
  unresolved_count INTEGER;
BEGIN
  SELECT COUNT(*)
  INTO unresolved_count
  FROM "RefreshToken"
  WHERE "replacedByToken" IS NOT NULL
    AND "replacedByTokenId" IS NULL;

  IF unresolved_count > 0 THEN
    RAISE EXCEPTION
      'Cannot remove RefreshToken.replacedByToken: % legacy references remain unresolved',
      unresolved_count;
  END IF;
END $$;

ALTER TABLE "RefreshToken"
DROP COLUMN "replacedByToken";
