-- Retire PostgreSQL monitoring stores after the Langfuse writer/reader cutover.
-- Existing rows are removed; completed benchmark artifacts must be retained separately.
BEGIN;

DROP TABLE "RagTrace";
DROP TABLE "RagHierarchyShadowObservation";

COMMIT;
