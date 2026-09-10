ALTER TABLE "notification_jobs"
ADD COLUMN "idempotency_key" TEXT;

CREATE UNIQUE INDEX "notification_jobs_idempotency_key_key"
ON "notification_jobs"("idempotency_key");
