---
name: velora-reel-media-pipeline
description: Preserve Velora Reel publish idempotency, upload leases, crop/trim/Fit, validated playback readiness, durable evidence/index handoffs, and attempt/retry fencing.
---

# Velora Reel Media Pipeline

Use this skill for Reel create/reprocess, presigning, upload cleanup, media edits, outbox dispatch, FFmpeg/HLS processing, or evidence/index handoffs.

## Publishing and source ownership

- Modern clients send one secure `publishIntentId` per logical Publish. Enforce `UNIQUE(userId, publishIntentId)` and an immutable normalized request fingerprint; matching replays return the current canonical Reel without resetting state or adding another outbox event. Conflicting reuse returns 409. Reconcile P2002 after the failed transaction has rolled back.
- Create the Reel, adopt its upload lease, and insert the initial media outbox transactionally. An HTTP response lost after commit must remain safely replayable.
- `purpose: reel` presigns bind authenticated owner/intent/type to one deterministic key and sign `If-None-Match: *`. A 412 acknowledges an already-present immutable original. Renew the same key; do not overwrite it or silently generate another intent after uncertainty.
- Content owns upload and media-attempt leases; Media reserves them through RPC. Reservation, adoption and cleanup share a per-key advisory transaction lock, durable cleanup claim and object-existence recheck. Protect live references, active attempts, shared sources and unpublished outbox events; keep deletion behind the existing enable/apply gates.
- Retired upload keys return 410 and require explicit cancellation/new intent. Preserve the adoption receipt and final-Reel deletion grace; do not collect a source still needed by another Reel.
- Preserve user-owned `reels/<user>/...` and legacy `chat-videos/<user>/...` validation. Trusted imported `reels/<canonical UUID Reel ID>/master.m3u8` is an evidence-only exception bound to the stored owner/key/attempt; never extend it into arbitrary external-original downloads.
- Legacy clients without an intent remain compatible, not retry-idempotent. New required fields need database defaults/backfills compatible with the deployed older Prisma client; a client-side UUID default alone does not protect old SQL inserts during rollout.

## Invariants

- Persist Reel state and its media outbox event in the same Content Service transaction. Never publish the initial media job as an uncommitted side effect.
- Treat `mediaAttemptId` / processing attempt IDs as stale-work fences. Duplicate or stale attempts must not overwrite the current Reel state.
- Keep Reel jobs versioned and validate inbound job shape before processing. Malformed jobs go to the DLQ.
- For retryable worker failures, publish the retry job successfully before ACKing the original delivery. Exhausted/permanent failures are rejected without requeue; failures before durable handling may be requeued.
- SOURCE_VIDEO does only source validation, requested edits, HLS/thumbnail publication and complete playback validation. Validate every variant, URI resource, segment and thumbnail before committing usable keys/metadata.
- Atomically persist `mediaStatus=COMPLETED`, `indexStatus=PENDING`, `processingStage=MEDIA_READY` and the EXISTING_HLS evidence outbox event; the source worker returns before audio/visual evidence generation.
- EXISTING_HLS materializes the validated stream, prepares audio/visual manifests, then commits evidence and the indexing outbox together. Preserve original source metadata and legitimate evidence retry/reclaim stages. Duplicate/stale completion creates no extra logical handoff.
- Evidence/index failures never demote completed playable media. Failed media needs normal validation/reprocessing, not promotion from a master-only existence check.
- Publish immutable attempt-scoped output prefixes; stale jobs must not delete or overwrite newer valid HLS.
- Keep Crop, Fit/no-edit, trim, retry, and reprocess on the same asynchronous outbox/RabbitMQ/media-processing architecture; do not add a synchronous or alternate processing path for an edit feature.
- Preserve source/output semantics: `sourceDurationMs` describes the immutable source; published duration is `outputDurationMs ?? sourceDurationMs`. Runtime-invalid trims fail rather than silently changing the requested interval.
- Carry `mediaEdit` through create -> outbox job -> retry/reprocess -> media processing so retries reproduce the same requested output.

## Repository evidence

- `apps/content-service/src/application/use-cases/create-reel.use-case.ts`
- `apps/content-service/prisma/schema.prisma`
- `libs/common/src/content/publish-request-fingerprint.ts`
- `libs/common/src/content/reel-media-key.ts`
- `apps/media-service/src/application/use-cases/get-presigned-url.use-case.ts`
- `apps/content-service/src/infrastructure/jobs/reel-media-cleanup.service.ts`
- `apps/content-service/src/application/use-cases/dispatch-outbox-events.use-case.ts`
- `apps/content-service/src/infrastructure/repositories/content.repository.ts`
- `apps/content-service/src/infrastructure/jobs/outbox-dispatcher.service.ts`
- `apps/media-processing-service/src/application/use-cases/process-reel.use-case.ts`
- `apps/media-processing-service/src/application/use-cases/validate-reel-stream.use-case.ts`
- `apps/media-processing-service/src/infrastructure/controllers/media-processing.controller.ts`
- `libs/common/src/content/schemas/reel-edit.schema.ts`
- `libs/common/src/processing/interfaces/reel-media-job.interface.ts`

Use the create-reel PostgreSQL integration spec for real concurrent creation, cleanup races and legacy-client inserts; mock-only tests do not prove database uniqueness or rollout compatibility. Recheck migration history/checksums and use a bounded direct connection for explicitly authorized production migrations.
