-- Normalized, de-duplicated copy of "tags" used for tag search and tag browsing.
-- A trigger keeps it in sync so no application write path can forget it.
ALTER TABLE "Reel" ADD COLUMN "searchTags" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];

-- Must mirror normalizeReelSearchTag() in domain/reel-search-tag.ts.
CREATE OR REPLACE FUNCTION reel_normalize_search_tags(raw_tags TEXT[])
RETURNS TEXT[]
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT COALESCE(array_agg(DISTINCT normalized), ARRAY[]::TEXT[])
  FROM (
    SELECT lower(btrim(regexp_replace(regexp_replace(btrim(tag), '^#+', ''), '[[:space:]_-]+', ' ', 'g'))) AS normalized
    FROM unnest(COALESCE(raw_tags, ARRAY[]::TEXT[])) AS tag
  ) AS candidates
  WHERE char_length(normalized) BETWEEN 2 AND 32
    AND normalized !~ '^[0-9]+$'
$$;

CREATE OR REPLACE FUNCTION reel_sync_search_tags()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  NEW."searchTags" := reel_normalize_search_tags(NEW."tags");
  RETURN NEW;
END;
$$;

CREATE TRIGGER "Reel_sync_search_tags"
BEFORE INSERT OR UPDATE OF "tags" ON "Reel"
FOR EACH ROW EXECUTE FUNCTION reel_sync_search_tags();

UPDATE "Reel"
SET "searchTags" = reel_normalize_search_tags("tags")
WHERE cardinality("tags") > 0;

CREATE INDEX "Reel_searchTags_idx" ON "Reel" USING GIN ("searchTags");
