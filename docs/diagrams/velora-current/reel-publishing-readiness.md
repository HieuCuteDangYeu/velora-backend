# Reel publishing, media readiness and owner playback

The changes are implemented and have been authorized for commit, push and the five additive Content production migrations. Production migration and publication receipts are recorded separately after execution. The 58 unrelated dirty RAG files were preserved byte-for-byte.

## Architecture before and after

| Boundary | Before | After |
| --- | --- | --- |
| Publish retry | Fresh presign, object and Reel identity per attempt | One secure client UUID per logical Publish; durable owner-scoped checkpoints; deterministic original key; canonical server replay |
| Database create | Atomic Reel/outbox, without logical request deduplication | `UNIQUE(userId, publishIntentId)` plus immutable request fingerprint; Reel, upload adoption and initial outbox commit together |
| Playback readiness | Audio/visual preparation delayed media completion | Validate all HLS assets and thumbnail, then atomically commit `COMPLETED / PENDING / MEDIA_READY` and an evidence outbox event |
| Evidence/indexing | Artifacts produced before the media-ready boundary | Separate durable `EXISTING_HLS` job prepares audio/visual manifests; a second transactional outbox hands available evidence to the existing indexing workflow |
| Creator playback | Wait for remote HLS | Canonical creation acknowledgement binds retained local media to owner/device/Reel, navigates immediately, and continues metadata follow-ups |
| Other viewers | Remote processing status | Validated HLS only; local preview does not change public readiness |

NestJS service ownership, Content PostgreSQL/Prisma, RabbitMQ, the transactional outbox, R2, FFmpeg, TanStack Query and the existing React Native player/coordinator remain in place.

## Database migrations

Five additive Content migrations were added:

1. `20261013090000_add_reel_publish_intent_id`
2. `20261013100000_add_reel_upload_leases`
3. `20261013101000_add_reel_publish_request_fingerprint`
4. `20261013102000_add_reel_media_attempt_leases`
5. `20261013103000_add_reel_upload_cleanup_claim`

Existing Reel IDs backfill publish identities. PostgreSQL supplies a UUID default for legacy clients and direct seed callers, including the currently deployed older Content client during the rollout. The compound unique index scopes intents to authenticated users. A nullable fingerprint preserves historical records without resetting their current state. Upload and attempt leases are Content-owned operational records; their correlations are not invented foreign keys.

## API and DTO changes

`POST /media/upload-url` accepts `{ fileType, purpose: "reel", publishIntentId }` for modern Reel clients. The UUID is optional for legacy callers and valid only with Reel purpose. The response remains `{ uploadUrl, key, expiresIn: 300 }`.

Modern keys are `reels/<userId>/<publishIntentId>.<extension>`. R2 PUT is signed with `If-None-Match: *`; the client supplies that header. A 412 acknowledges an existing immutable original. A presign lasts 300 seconds; the source lease lasts 24 hours so an upload started near URL expiry is not collected immediately.

`POST /content/reels` adds optional UUID `publishIntentId` to the existing payload and returns the canonical Reel, including its intent. Matching replays preserve processing state and add no outbox event. Changed immutable payloads return 409. A P2002 race is reconciled after rollback against the owner-scoped winner. Invalid/foreign/missing sources are rejected. Reusing identical content with a different intent remains valid.

The internal `content.reserve_reel_upload` RPC reserves the source lease. Retired keys return 410 and are never silently reused. Mobile persists `requiresCancellation`, suppresses automatic retries and offers explicit discard before a new intentional Publish. Existing-HLS claims additionally carry owner and canonical HLS key, which Content checks with the current attempt.

Public-link creation/resolution, direct sharing and search require completed media plus an HLS key. Mobile normalization rejects original MP4 and device-local URLs as remote HLS, including old cached feed records. Link and playback permissions otherwise retain their existing boundaries.

## Durable publication and cleanup

The creator acquires a synchronous tap lock before awaiting work and generates `expo-crypto.randomUUID()` once. Immutable payload/source and presign/upload/create/visibility/Series checkpoints are persisted under the user account. Corrupt storage fails closed. Resume reuses completed uploads and reconciles uncertain creation using the same intent; a metadata follow-up never starts another upload. A created Series ID remains saved when attachment fails, so retry attaches to the same Series.

Source copies are staged atomically before upload. Cleanup/adoption/renewal use a per-key PostgreSQL advisory transaction lock, a durable cleanup claim and a second object existence check. Apply cleanup is opt-in: `REEL_MEDIA_CLEANUP_ENABLED=true`, with deletion only when `REEL_MEDIA_CLEANUP_APPLY=true`; otherwise the collector is disabled or dry-run. It protects adopted/live sources, active attempt leases, current playback/evidence references and unpublished outbox jobs. Shared sources survive until the last Reel is deleted, then receive a 24-hour grace period. Completed cleanup tombstones prevent unsafe reupload/adoption races. Attempt outputs use immutable UUID prefixes; legacy output roots are excluded from broad orphan collection.

## Media readiness and evidence

SOURCE_VIDEO downloads/probes/validates, applies requested edits, encodes HLS, uploads playlists/required resources and thumbnail, and validates master, every variant, URI resources, segments and thumbnail. Only then does Content atomically persist playable keys/metadata, `mediaStatus=COMPLETED`, `indexStatus=PENDING`, `processingStage=MEDIA_READY` and the evidence outbox event. The source worker returns at this boundary.

The separately delivered EXISTING_HLS job claims completed media as evidence-only, materializes validated HLS, prepares audio and visual manifests, preserves original source metadata, and commits evidence plus the indexing outbox. Existing transcription, visual analysis, embedding and semantic candidate/checkpoint workflows consume those artifacts. Redelivery, retry queues/DLQ, attempt IDs, stale-result fencing and claim/lease renewal remain active. Duplicate completion does not add another logical indexing handoff. Evidence/indexing failures preserve playable HLS.

Completed legacy imports with stored `reels/<canonical UUID Reel ID>/master.m3u8` can still enrich through the trusted stored-playlist path. Their external original URL is never downloaded by this evidence job, and Content binds owner/key/attempt before processing. Normal publishing and source jobs retain user-owned-key validation. Failed media must use normal reprocessing rather than a master-only check to become ready. Already-completed legacy `.m3u8` media keys remain playback-compatible; original MP4 keys are not inferred as HLS.

## Owner preview and HLS handoff

After canonical creation, the app persists an owner/device/Reel association, updates query caches and navigates to detail immediately, before visibility/Series continuation. The retained source uses the existing ReelVideo, trim/crop preview components, player controls and playback coordinator. Device URIs stay local and never enter backend DTOs. Applied trim/crop are represented locally; queued handoff position is output-relative and the trim offset is added exactly once.

The source resolver distinguishes authorized local availability, queued/processing/failed media, validated remote readiness and indexing outcomes. A pending Reel is locally playable only on the uploading owner/device. Remote HLS becomes preferred when completed media has a valid HLS URL; existing HLS warmup/cache runs independently. Source/player generations fence stale callbacks, and a bounded remote/local fallback tries each candidate once. Playback errors do not mutate server processing failure state.

The local fallback is retained for 14 days, pinned while the actual player uses it, and safely expired by startup/hourly cleanup. Remote first-frame readiness does not delete it. Logout/account switching revokes old-owner records and rejects in-flight stale work. Draft cleanup does not delete a canonical retained preview; explicit cancellation removes only unbound prepared source copies.

## Executed verification

| Check | Actual result |
| --- | --- |
| Backend focused unit run | 31 suites / 158 tests passed; PostgreSQL suite intentionally separate |
| Final mapper/enrichment regressions | 3 suites / 23 tests passed; overlaps the focused run |
| Final review corrections | 7 suites / 52 tests passed; includes share readiness, legacy enrichment/claim binding and existing media behavior |
| Independent backend verification | 22 suites / 126 tests passed before final corrective patches |
| Real disposable PostgreSQL integration | 6 tests passed, including an old-client insert that omits the new intent column; concurrent create produced one Reel/initial outbox; cleanup races and shared-source deletion checked |
| Prisma | Generate and validate passed; all 32 Content migrations, including the five additions, applied to disposable PostgreSQL |
| Backend builds | Gateway, Content, Media, Media Processing and Reel Indexing passed; affected Gateway/Content/Media Processing rerun after final patches |
| Backend TypeScript/lint | Relevant no-emit checks and scoped lint passed; four pre-existing unsafe-any warnings in a test remain |
| Final mobile focused tests | 71 passed, 0 failed |
| Final mobile full suite | 385 passed, 1 unchanged Android manifest failure, 3 TODO |
| Final mobile TypeScript/lint | Passed |
| Final Android Expo export | Passed; Hermes bundle produced; this is bundle validation, not native/device proof |
| Whitespace/preservation | Both `git diff --check` passed; all 58 unrelated files retain their original hashes |
| Diagram editability/source bounds | 48 page payloads and combined export match the editable source; 15 changed visible exports use portable colors; bounded references validated |

The sole full-suite failure is `tests/call-lifecycle-contract.test.cjs:283`, which expects `VeloraFirebaseMessagingReceiver` in the unchanged Android manifest. It is outside this task. No global all-tests PASS is claimed.

Final independent review found no additional introduced blocker: scoped Reel behavior and final diagrams pass. Its overall verdict remains BLOCK because of the unchanged full-suite manifest failure. The full review evidence is `/tmp/velora-reel-review-report.md`.

Reproducible focused commands:

```sh
# Backend
pnpm exec jest --runInBand --runTestsByPath \
  apps/content-service/src/application/use-cases/create-reel-share-link.use-case.spec.ts \
  apps/content-service/src/application/use-cases/enrich-reel-from-existing-hls.use-case.spec.ts \
  apps/content-service/src/application/use-cases/reel-media-edit-flow.use-case.spec.ts \
  apps/content-service/src/infrastructure/repositories/content.repository.spec.ts \
  apps/media-processing-service/src/application/use-cases/process-reel.use-case.spec.ts \
  apps/media-processing-service/src/infrastructure/controllers/media-processing.controller.spec.ts \
  libs/common/src/content/reel-media-key.spec.ts
pnpm exec tsc --noEmit -p apps/content-service/tsconfig.app.json
pnpm exec tsc --noEmit -p apps/media-processing-service/tsconfig.app.json
pnpm exec prisma validate --schema=apps/content-service/prisma/schema.prisma

# Mobile checkout
node --test tests/reel-publish-recovery-contract.test.cjs \
  tests/reel-playback-prefetch-contract.test.cjs tests/reel-orientation-playback-contract.test.cjs \
  tests/reel-crop-contract.test.cjs tests/reel-crop-geometry.test.cjs \
  tests/reel-trim-geometry.test.cjs tests/reel-series-contract.test.cjs
pnpm type-check
pnpm lint
npx expo export --platform android --output-dir /tmp/velora-reel-mobile-final-review-export

# Diagram source/export validation in backend checkout
python3 scripts/diagrams/build_reel_flow_sequences.py
DRAWIO_BIN=/path/to/drawio python3 scripts/diagrams/export_drawio_figures.py --png-dir /tmp/velora-reel-native-diagram-qa
python3 scripts/diagrams/validate_reel_exports.py
```

`export_drawio_figures.py` invokes the official native draw.io desktop exporter. The release recheck used version 32.4.1 with a light theme and uncompressed editable payloads. No production runtime dependency was added. The partial DSH renderer and its wrapper were removed from delivery.

## Release integration checks

The scoped commits were integrated in isolated clean checkouts based on the current remote backend master and mobile main, preserving unrelated working-tree edits and recent mobile font/auth fixes. The integrated backend passed all five service builds and 9 focused suites / 63 tests. The integrated mobile passed TypeScript, lint, 73 focused tests (including the current font contract), and the full tracked-source suite: 393 passed, zero failed, three TODO. Android export is checked separately after preparing a physical dependency directory; Metro cannot use the initial external dependency symlink. The clone does not include the caller's untracked generated Android manifest; its earlier receiver-contract failure is not claimed fixed or device-verified. Source/export validation also passed against the integrated repository sources: 48 payloads plus combined, root legality, 15 visible exports, 249 bounded references.

The first additive migration now declares a PostgreSQL UUID default, tested with a legacy raw SQL insert omitting publishIntentId. All 32 migrations were replayed in disposable PostgreSQL and all six integration tests passed. Production preflight found exactly the 27 historical migrations with matching checksums, no failed migration, and the five intended additions pending; the production runtime uses a direct connection with connection_limit=1 and provides gen_random_uuid(). Production application requires a separate executed receipt, not inference from these checks.

## Diagram recheck (2026-10-14)

The previous fallback export did not satisfy visual/template acceptance. It was replaced with native draw.io 32.4.1 export. All 15 changed pages were rechecked against the committed figure families and unchanged pages 18, 14 and 05: original architecture/DFD palette, open-ended stores, ER cardinality annotations, and Arial 15 black/white UML frames/lifelines/message arrows are retained. Page 02 label/icon collisions and mid-word wrapping are corrected. Page 13 operational lease cells are inside the legal graph root. New sequence guards and changed share routes have direct source evidence.

Independent correction review passed 19/19 guards and the mechanical check: 48 page payloads plus combined equality, root legality, 15 changed visible exports and 249 distinct bounded references. Native raster readability was inspected separately from source/reference validation; this is practical figure-template consistency, not a blanket full UML-conformance claim.

## Diagram delivery and visual proof

Editable source: `docs/diagrams/velora-current/velora-architecture.drawio`. Combined importable SVG: `docs/diagrams/velora-current/velora-diagrams.drawio.svg`.

Updated page SVGs under `docs/diagrams/velora-current/importable-svg/`: `01-microservices-architecture`, `02-application-architecture`, `08-dfd-media`, `08a-dfd-streaming`, `09-dfd-index`, `13-content`, `27-upload-retry`, `28-media-processing`, `29-index-normal`, `30-index-resume`, `31-index-commit`, `32-reel-feed-sequence`, `34-hls-streaming`, `37-sharing-ai-direct`, `38-sharing-public-link`.

Pages 27/28/34 preserve the new sequence semantics while matching the established Arial 15, black/white UML frame, ref, lifeline and arrow styles. Page 02 uses compact node descriptions and separates its phone figures from text. Architecture/DFD palettes, native open-ended stores, ER cardinality annotations, sequence operator tabs and connector routing are rendered by draw.io itself. Four operational lease cells on page 13 were moved to the legal graph root so native draw.io displays them. Source evidence for changed capabilities and share-link routes was refreshed against the actual code.

The native visible SVG bodies retain draw.io figure geometry and word wrapping; embedded source remains editable. All 48 page payloads and the combined proper mxfile match the source. The validator also rejects misplaced graph cells. Final native PNGs and freshness hashes are in `/tmp/velora-reel-native-diagram-qa/`. Source fidelity and practical figure-template/style review are separate from visual inspection; no blanket full UML-conformance claim is made.

## Rollout and remaining proof limits

Apply additive Content migrations, deploy the compatible backend contracts, then release mobile. Old clients that omit publish intent remain compatible but cannot gain retry identity guarantees. Enable cleanup only through its explicit gates after operator validation of the retention policy. Production migration execution is authorized for these five additive migrations; no destructive reset, db push or unrelated migration is part of this release.

No live R2 conditional upload, RabbitMQ delivery/retry/DLQ, native Android/iOS install, emulator/device playback or HLS transition was exercised. Trusted existing-HLS materialization retains the existing external CDN-reference behavior used by operator imports; this task does not change its provider/egress architecture. Independent review and fresh rendered-image inspection are reported separately from passing unit/build checks.

## Exact changed files

This manifest excludes the 58 preserved unrelated RAG files.

### Backend

- `apps/api-gateway/src/content/content.controller.ts`
- `apps/api-gateway/src/content/public-reel-share.controller.ts`
- `apps/api-gateway/src/media/media.controller.ts`
- `apps/api-gateway/src/search/search-reel-readiness.spec.ts`
- `apps/api-gateway/src/search/search.controller.ts`
- `apps/content-service/prisma/migrations/20261013090000_add_reel_publish_intent_id/migration.sql`
- `apps/content-service/prisma/migrations/20261013100000_add_reel_upload_leases/migration.sql`
- `apps/content-service/prisma/migrations/20261013101000_add_reel_publish_request_fingerprint/migration.sql`
- `apps/content-service/prisma/migrations/20261013102000_add_reel_media_attempt_leases/migration.sql`
- `apps/content-service/prisma/migrations/20261013103000_add_reel_upload_cleanup_claim/migration.sql`
- `apps/content-service/prisma/schema.prisma`
- `apps/content-service/src/application/use-cases/claim-reel-processing-attempt.use-case.ts`
- `apps/content-service/src/application/use-cases/complete-reel-media-processing.use-case.spec.ts`
- `apps/content-service/src/application/use-cases/complete-reel-media-processing.use-case.ts`
- `apps/content-service/src/application/use-cases/create-reel-share-link.use-case.spec.ts`
- `apps/content-service/src/application/use-cases/create-reel-share-link.use-case.ts`
- `apps/content-service/src/application/use-cases/create-reel.use-case.integration.spec.ts`
- `apps/content-service/src/application/use-cases/create-reel.use-case.spec.ts`
- `apps/content-service/src/application/use-cases/create-reel.use-case.ts`
- `apps/content-service/src/application/use-cases/delete-reel.use-case.spec.ts`
- `apps/content-service/src/application/use-cases/delete-reel.use-case.ts`
- `apps/content-service/src/application/use-cases/enrich-reel-from-existing-hls.use-case.spec.ts`
- `apps/content-service/src/application/use-cases/enrich-reel-from-existing-hls.use-case.ts`
- `apps/content-service/src/application/use-cases/reel-media-edit-flow.use-case.spec.ts`
- `apps/content-service/src/application/use-cases/reprocess-reel.use-case.spec.ts`
- `apps/content-service/src/application/use-cases/reprocess-reel.use-case.ts`
- `apps/content-service/src/application/use-cases/reserve-reel-upload-lease.use-case.ts`
- `apps/content-service/src/application/use-cases/resolve-reel-share-link.use-case.ts`
- `apps/content-service/src/application/use-cases/share-reel.use-case.ts`
- `apps/content-service/src/application/use-cases/update-reel-status.use-case.ts`
- `apps/content-service/src/content-service.module.ts`
- `apps/content-service/src/domain/entities/reel.entity.ts`
- `apps/content-service/src/domain/errors/content.error.ts`
- `apps/content-service/src/domain/interfaces/content.repository.interface.ts`
- `apps/content-service/src/infrastructure/adapters/conversation-message.adapter.spec.ts`
- `apps/content-service/src/infrastructure/adapters/conversation-message.adapter.ts`
- `apps/content-service/src/infrastructure/controllers/content.controller.ts`
- `apps/content-service/src/infrastructure/jobs/reel-media-cleanup.service.spec.ts`
- `apps/content-service/src/infrastructure/jobs/reel-media-cleanup.service.ts`
- `apps/content-service/src/infrastructure/repositories/content.repository.spec.ts`
- `apps/content-service/src/infrastructure/repositories/content.repository.ts`
- `apps/content-service/src/infrastructure/repositories/recommendation.repository.ts`
- `apps/content-service/src/infrastructure/repositories/reel-record.mapper.spec.ts`
- `apps/content-service/src/infrastructure/repositories/reel-record.mapper.ts`
- `apps/media-processing-service/src/application/use-cases/prepare-reel-media.use-case.ts`
- `apps/media-processing-service/src/application/use-cases/process-reel.use-case.spec.ts`
- `apps/media-processing-service/src/application/use-cases/process-reel.use-case.ts`
- `apps/media-processing-service/src/application/use-cases/validate-reel-stream.use-case.spec.ts`
- `apps/media-processing-service/src/application/use-cases/validate-reel-stream.use-case.ts`
- `apps/media-processing-service/src/domain/interfaces/content-service.interface.ts`
- `apps/media-processing-service/src/infrastructure/adapters/content-service.adapter.ts`
- `apps/media-processing-service/src/infrastructure/controllers/media-processing.controller.spec.ts`
- `apps/media-processing-service/src/infrastructure/controllers/media-processing.controller.ts`
- `apps/media-service/src/application/use-cases/get-presigned-url.use-case.ts`
- `apps/media-service/src/domain/interfaces/reel-upload-lease.service.interface.ts`
- `apps/media-service/src/infrastructure/adapters/content-upload-lease.adapter.ts`
- `apps/media-service/src/infrastructure/controllers/media.controller.ts`
- `apps/media-service/src/infrastructure/services/s3.service.spec.ts`
- `apps/media-service/src/infrastructure/services/s3.service.ts`
- `apps/media-service/src/media-service.module.ts`
- `docs/diagrams/velora-current/importable-svg/01-microservices-architecture.drawio.svg`
- `docs/diagrams/velora-current/importable-svg/02-application-architecture.drawio.svg`
- `docs/diagrams/velora-current/importable-svg/08-dfd-media.drawio.svg`
- `docs/diagrams/velora-current/importable-svg/08a-dfd-streaming.drawio.svg`
- `docs/diagrams/velora-current/importable-svg/09-dfd-index.drawio.svg`
- `docs/diagrams/velora-current/importable-svg/13-content.drawio.svg`
- `docs/diagrams/velora-current/importable-svg/27-upload-retry.drawio.svg`
- `docs/diagrams/velora-current/importable-svg/28-media-processing.drawio.svg`
- `docs/diagrams/velora-current/importable-svg/29-index-normal.drawio.svg`
- `docs/diagrams/velora-current/importable-svg/30-index-resume.drawio.svg`
- `docs/diagrams/velora-current/importable-svg/31-index-commit.drawio.svg`
- `docs/diagrams/velora-current/importable-svg/32-reel-feed-sequence.drawio.svg`
- `docs/diagrams/velora-current/importable-svg/34-hls-streaming.drawio.svg`
- `docs/diagrams/velora-current/importable-svg/37-sharing-ai-direct.drawio.svg`
- `docs/diagrams/velora-current/importable-svg/38-sharing-public-link.drawio.svg`
- `docs/diagrams/velora-current/reel-publishing-readiness.md`
- `docs/diagrams/velora-current/velora-architecture.drawio`
- `docs/diagrams/velora-current/velora-diagrams.drawio.svg`
- `libs/common/src/content/dtos/create-reel.dto.spec.ts`
- `libs/common/src/content/dtos/create-reel.dto.ts`
- `libs/common/src/content/interfaces/reel-response.interface.ts`
- `libs/common/src/content/interfaces/reel-share-link.interface.ts`
- `libs/common/src/content/publish-request-fingerprint.spec.ts`
- `libs/common/src/content/publish-request-fingerprint.ts`
- `libs/common/src/content/reel-media-key.spec.ts`
- `libs/common/src/content/reel-media-key.ts`
- `libs/common/src/media/dtos/get-presigned-url.dto.spec.ts`
- `libs/common/src/media/dtos/get-presigned-url.dto.ts`
- `libs/common/src/processing/interfaces/reel-media-output.interface.ts`
- `scripts/diagrams/build_reel_flow_sequences.py`
- `scripts/diagrams/export_drawio_figures.py`
- `scripts/diagrams/validate_reel_exports.py`

### Mobile

- `src/components/reels/ReelFeedItem.tsx`
- `src/components/reels/create/crop-preview.tsx`
- `src/components/reels/create/trimmed-reel-video.tsx`
- `src/constants/reel-creator.ts`
- `src/hooks/useOfflineReelVideoSource.ts`
- `src/hooks/useReelCreator.ts`
- `src/hooks/useReels.ts`
- `src/lib/localReelPlayback.ts`
- `src/lib/offlineReelVideoCache.ts`
- `src/lib/reelProcessing.ts`
- `src/lib/reelPublishPersistence.ts`
- `src/lib/reelPublishRecovery.ts`
- `src/providers/AuthProvider.tsx`
- `src/types/reel-creator.ts`
- `src/types/reel.types.ts`
- `tests/reel-playback-prefetch-contract.test.cjs`
- `tests/reel-publish-recovery-contract.test.cjs`
- `tests/reel-series-contract.test.cjs`
