-- CreateTable
CREATE TABLE "call_records" (
    "call_id" TEXT NOT NULL,
    "conversation_id" TEXT NOT NULL,
    "is_group_call" BOOLEAN NOT NULL,
    "call_type" TEXT NOT NULL,
    "group_name" TEXT,
    "group_avatar_url" TEXT,
    "initiator_id" TEXT NOT NULL,
    "outcome" TEXT NOT NULL,
    "terminal_reason" TEXT,
    "started_at" TIMESTAMP(3) NOT NULL,
    "answered_at" TIMESTAMP(3),
    "ended_at" TIMESTAMP(3) NOT NULL,
    "duration_sec" INTEGER,
    "lifecycle_revision" INTEGER NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "call_records_pkey" PRIMARY KEY ("call_id")
);

-- CreateTable
CREATE TABLE "call_record_participants" (
    "call_id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "role" TEXT NOT NULL,
    "result" TEXT NOT NULL,
    "started_at" TIMESTAMP(3) NOT NULL,
    "seen_at" TIMESTAMP(3),

    CONSTRAINT "call_record_participants_pkey" PRIMARY KEY ("call_id","user_id")
);

-- CreateIndex
CREATE INDEX "call_record_participants_user_id_started_at_call_id_idx" ON "call_record_participants"("user_id", "started_at" DESC, "call_id" DESC);

-- CreateIndex
CREATE INDEX "call_record_participants_user_id_result_seen_at_idx" ON "call_record_participants"("user_id", "result", "seen_at");

-- AddForeignKey
ALTER TABLE "call_record_participants" ADD CONSTRAINT "call_record_participants_call_id_fkey" FOREIGN KEY ("call_id") REFERENCES "call_records"("call_id") ON DELETE CASCADE ON UPDATE CASCADE;

