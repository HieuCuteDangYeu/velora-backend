ALTER TABLE "push_tokens" ADD COLUMN "group_lifecycle_version" INTEGER NOT NULL DEFAULT 1;

-- Old queued terminal jobs did not carry isGroupCall. Their group incoming
-- sibling is durable and shares call_id, so mark only the retryable jobs that
-- can still be delivered after this migration.
UPDATE "notification_jobs" AS state
SET "data_json" = jsonb_set(
    COALESCE(state."data_json", '{}'::jsonb),
    '{isGroupCall}',
    'true'::jsonb,
    true
)
WHERE state."type" = 'CALL_STATE_UPDATE'
  AND state."status" IN ('pending', 'failed', 'processing')
  AND state."call_id" IS NOT NULL
  AND EXISTS (
    SELECT 1
    FROM "notification_jobs" AS incoming
    WHERE incoming."call_id" = state."call_id"
      AND incoming."type" = 'INCOMING_CALL'
      AND incoming."data_json"->>'isGroupCall' = 'true'
  );
