---
name: velora-reel-media-pipeline
description: Preserve Velora Reel creation, outbox, crop/trim/Fit, media processing, retry/DLQ, attempt fencing, and media-to-index handoff invariants.
---

# Velora Reel Media Pipeline

Use this skill for Reel create/reprocess, media edit schemas, outbox dispatch, FFmpeg/HLS processing, media retries, or the media-to-index handoff.

## Invariants

- Persist Reel state and its media outbox event in the same Content Service transaction. Never publish the initial media job as an uncommitted side effect.
- Treat `mediaAttemptId` / processing attempt IDs as stale-work fences. Duplicate or stale attempts must not overwrite the current Reel state.
- Keep Reel jobs versioned and validate inbound job shape before processing. Malformed jobs go to the DLQ.
- For retryable worker failures, publish the retry job successfully before ACKing the original delivery. Exhausted/permanent failures are rejected without requeue; failures before durable handling may be requeued.
- Media completion and creation of the Reel indexing outbox event are one Content Service transaction.
- Keep Crop, Fit/no-edit, trim, retry, and reprocess on the same asynchronous outbox/RabbitMQ/media-processing architecture; do not add a synchronous or alternate processing path for an edit feature.
- Preserve source/output semantics: `sourceDurationMs` describes the immutable source; published duration is `outputDurationMs ?? sourceDurationMs`. Runtime-invalid trims fail rather than silently changing the requested interval.
- Carry `mediaEdit` through create -> outbox job -> retry/reprocess -> media processing so retries reproduce the same requested output.

## Repository evidence

- `apps/content-service/src/application/use-cases/create-reel.use-case.ts`
- `apps/content-service/src/application/use-cases/dispatch-outbox-events.use-case.ts`
- `apps/content-service/src/infrastructure/repositories/content.repository.ts`
- `apps/content-service/src/infrastructure/jobs/outbox-dispatcher.service.ts`
- `apps/media-processing-service/src/application/use-cases/process-reel.use-case.ts`
- `apps/media-processing-service/src/infrastructure/controllers/media-processing.controller.ts`
- `libs/common/src/content/schemas/reel-edit.schema.ts`
- `libs/common/src/processing/interfaces/reel-media-job.interface.ts`
