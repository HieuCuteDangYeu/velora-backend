-- The retry scheduler takes the next unfinished jobs in this order. Without an
-- index in that order PostgreSQL read and sorted every unfinished job for each
-- batch of 20, so draining a backlog of N jobs cost about N * N / 20 row reads.
--
-- The index is partial: it holds only the jobs that can still be delivered, so
-- it stays as small as the backlog and terminal history adds nothing to it.
-- Prisma 5 cannot describe a partial index in schema.prisma; it exists only here.
CREATE INDEX IF NOT EXISTS "notification_jobs_retry_order_idx"
  ON "notification_jobs" ("expires_at" ASC NULLS LAST, "created_at" ASC)
  WHERE "status" IN ('pending', 'failed', 'processing');
