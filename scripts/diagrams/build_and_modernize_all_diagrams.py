#!/usr/bin/env python3
"""Build and modernize all Velora sequence diagrams and architectures with natural language labels and split sub-flows."""
from pathlib import Path
import xml.etree.ElementTree as ET
import html
import json
import re

ROOT = Path(__file__).resolve().parents[2]
DIR = ROOT / 'docs/diagrams/velora-current'
ARCH_DRAWIO = DIR / 'velora-architecture.drawio'
COMBINED_SVG = DIR / 'velora-diagrams.drawio.svg'
IMPORTABLE_DIR = DIR / 'importable-svg'
MOBILE = Path('/home/hieucutedangyeu/Velora-Mobile')

STYLE = 'html=1;fontFamily=Arial;fontSize=15;fontColor=light-dark(#202020,#eeeeee);strokeColor=light-dark(#202020,#eeeeee);'

def msg(a, b, label, *e, reply=False):
    return dict(type='message', **{'from': a, 'to': b}, label=label,
                sort='asynchSignal' if 'broker' in (a, b) or 'queue' in (a, b) else 'reply' if reply else 'synchCall',
                evidence=list(e))

def note(label, *e):
    return dict(type='ref', label=label, evidence=list(e))

def frame(operator, *operands):
    return dict(type='frame', operator=operator, operands=[dict(guard=g, steps=s) for g, s in operands])

# Verified references
C_REF = 'backend:apps/content-service/src/application/use-cases/create-reel.use-case.ts:32-52'
R_REF = 'backend:apps/content-service/src/infrastructure/repositories/content.repository.ts:713-733'
MP_REF = 'backend:apps/media-processing-service/src/application/use-cases/process-reel.use-case.ts:60-120'
PM_REF = 'backend:apps/media-processing-service/src/application/use-cases/prepare-reel-media.use-case.ts:101-121'
VAL_STREAM_REF = 'backend:apps/media-processing-service/src/application/use-cases/validate-reel-stream.use-case.ts:80-100'
PREP_EVID_REF = 'backend:apps/media-processing-service/src/application/use-cases/prepare-existing-hls-evidence.use-case.ts:100-120'
OUTBOX_REF = 'backend:apps/content-service/src/application/use-cases/dispatch-outbox-events.use-case.ts:85-105'
INDEX_JOB_REF = 'backend:apps/reel-indexing-service/src/application/use-cases/process-reel-index-job.use-case.ts:43-63'
INDEX_WORKFLOW_REF = 'backend:apps/reel-indexing-service/src/infrastructure/workflows/reel-index-langgraph.workflow.ts:219-240'
PRESIGN_REF = 'backend:apps/media-service/src/application/use-cases/get-presigned-url.use-case.ts:14-103'
AUTH_REFRESH_REF = 'backend:apps/auth-service/src/application/use-cases/refresh-token.use-case.ts:46-66'
AUTH_CAS_REF = 'backend:apps/auth-service/src/application/use-cases/refresh-token.use-case.ts:147-167'
USER_ADAPTER_REF = 'backend:apps/auth-service/src/infrastructure/adapters/user-service.adapter.ts:134-154'
CLIENT_MUTEX_REF = 'mobile:src/api/client.ts:19-39'
CLIENT_CLIENT_REF = 'mobile:src/api/client.ts:46-87'
REEL_CREATOR_REF = 'mobile:src/hooks/useReelCreator.ts:625-645'
REELS_HOOK_REF = 'mobile:src/hooks/useReels.ts:833-837'
FEED_REC_REF = 'backend:apps/content-service/src/application/use-cases/get-recommended-reels.use-case.ts:81-101'
FEED_REPO_REF = 'backend:apps/content-service/src/infrastructure/repositories/recommendation.repository.ts:698-718'
RAG_SCOPE_REF = 'backend:apps/ai-service/src/infrastructure/adapters/langgraph-rag-chat-workflow.adapter.ts:541-561'
RAG_TEI_REF = 'backend:apps/ai-service/src/infrastructure/adapters/tei-embedding.adapter.ts:1-21'
RAG_VERIFY_REF = 'backend:apps/ai-service/src/application/use-cases/verifier-agent.use-case.ts:77-97'
RAG_CONV_REF = 'backend:apps/conversation-service/src/application/use-cases/process-bot-reply.use-case.ts:36-47'
RAG_AI_CTRL_REF = 'backend:apps/ai-service/src/infrastructure/controller/ai.controller.ts:229-249'
PRISMA_UNIQUE_REF = 'backend:apps/content-service/prisma/schema.prisma:1-20'
AUTH_REG_REF = 'backend:apps/auth-service/src/application/use-cases/register.use-case.ts:1-70'
AUTH_CONFIRM_REF = 'backend:apps/auth-service/src/application/use-cases/confirm-account.use-case.ts:1-28'
FRIEND_SEND_REF = 'backend:apps/friend-service/src/application/use-cases/send-friend-request.use-case.ts:1-99'
FRIEND_ACCEPT_REF = 'backend:apps/friend-service/src/application/use-cases/accept-friend-request.use-case.ts:1-89'
FRIEND_REJECT_REF = 'backend:apps/friend-service/src/application/use-cases/reject-friend-request.use-case.ts:1-41'
FRIEND_CANCEL_REF = 'backend:apps/friend-service/src/application/use-cases/cancel-friend-request.use-case.ts:1-41'
FRIEND_REMOVE_REF = 'backend:apps/friend-service/src/application/use-cases/remove-friend.use-case.ts:1-33'
SERIES_CREATE_REF = 'backend:apps/content-service/src/application/use-cases/create-reel-series.use-case.ts:1-21'
SERIES_REORDER_REF = 'backend:apps/content-service/src/application/use-cases/reorder-reel-series.use-case.ts:1-46'
SERIES_EPISODES_REF = 'backend:apps/content-service/src/application/use-cases/get-reel-series-episodes.use-case.ts:1-49'
SHARE_REEL_REF = 'backend:apps/content-service/src/application/use-cases/share-reel.use-case.ts:1-162'
SHARE_LINK_CREATE_REF = 'backend:apps/content-service/src/application/use-cases/create-reel-share-link.use-case.ts:1-102'
SHARE_LINK_RESOLVE_REF = 'backend:apps/content-service/src/application/use-cases/resolve-reel-share-link.use-case.ts:1-61'
RAG_MEMORY_TURN_REF = 'backend:apps/conversation-service/src/application/use-cases/build-completed-turn-memory-context.use-case.ts:1-42'
RAG_MEMORY_AGENT_REF = 'backend:apps/ai-service/src/application/use-cases/memory-agent.use-case.ts:1-115'
LANGFUSE_TRACING_REF = 'backend:apps/ai-service/src/infrastructure/services/langfuse-tracing.service.ts:1-338'

SPLIT_MODELS = [
    # 20a
    dict(id='20a-auth-refresh-standard', title='20a · Standard session token rotation',
         participants=[('mobile', 'Velora-Mobile'), ('gateway', 'API Gateway'), ('auth', 'Auth Service'), ('db', 'Auth Database'), ('user', 'User Service'), ('secure', 'Mobile SecureStore')],
         steps=[
             msg('mobile', 'gateway', 'Request session token rotation\n(Refresh token & request ID)', CLIENT_CLIENT_REF),
             msg('gateway', 'auth', 'Forward token refresh request via RabbitMQ', AUTH_REFRESH_REF),
             msg('auth', 'auth', 'Verify refresh token signature and expiration', AUTH_REFRESH_REF),
             msg('auth', 'db', 'Query active refresh token session by hash', AUTH_REFRESH_REF),
             msg('db', 'auth', 'Return active token session', AUTH_REFRESH_REF, reply=True),
             msg('auth', 'user', 'Verify user account active and in good standing', USER_ADAPTER_REF),
             msg('user', 'auth', 'Confirm user account is active', USER_ADAPTER_REF, reply=True),
             msg('auth', 'db', 'Atomically rotate token session\n(Revoke active token & issue replacement)', AUTH_CAS_REF),
             msg('db', 'auth', 'Replacement token session persisted', AUTH_CAS_REF, reply=True),
             msg('auth', 'auth', 'Sign new 15-minute access token and replacement refresh token', AUTH_REFRESH_REF),
             msg('auth', 'gateway', 'Return rotated access and refresh token pair', AUTH_REFRESH_REF, reply=True),
             msg('gateway', 'mobile', 'Deliver rotated access and refresh token pair', AUTH_REFRESH_REF, reply=True),
             msg('mobile', 'secure', 'Persist refreshed tokens in SecureStore', CLIENT_CLIENT_REF),
             note('Standard rotation complete; replay original protected request with new access token', CLIENT_CLIENT_REF)
         ]),

    # 20b
    dict(id='20b-auth-refresh-deduplication', title='20b · Concurrent client request deduplication & mutex',
         participants=[('caller1', 'Concurrent API Call 1'), ('caller2', 'Concurrent API Call 2'), ('interceptor', 'HTTP Interceptor'), ('mutex', 'Refresh Promise Mutex'), ('gateway', 'API Gateway')],
         steps=[
             msg('caller1', 'interceptor', 'First protected request receives 401 Unauthorized', CLIENT_MUTEX_REF),
             msg('caller2', 'interceptor', 'Parallel protected request receives 401 Unauthorized', CLIENT_MUTEX_REF),
             msg('interceptor', 'mutex', 'Acquire single shared refresh promise', CLIENT_MUTEX_REF),
             msg('mutex', 'gateway', 'Dispatch single token refresh request to Gateway', CLIENT_MUTEX_REF),
             note('Concurrent callers observe active refresh in progress and await existing promise without flooding server', CLIENT_MUTEX_REF),
             msg('gateway', 'mutex', 'Deliver renewed token session', CLIENT_MUTEX_REF, reply=True),
             msg('mutex', 'interceptor', 'Resolve shared refresh promise with new token', CLIENT_MUTEX_REF),
             msg('mutex', 'mutex', 'Clear active mutex promise reference', CLIENT_MUTEX_REF),
             msg('interceptor', 'caller1', 'Retry first call with new access token', CLIENT_MUTEX_REF),
             msg('interceptor', 'caller2', 'Retry second call with new access token', CLIENT_MUTEX_REF)
         ]),

    # 20c
    dict(id='20c-auth-refresh-recovery-theft', title='20c · Grace recovery and stolen token replay protection',
         participants=[('mobile', 'Mobile Client'), ('gateway', 'API Gateway'), ('auth', 'Auth Service'), ('db', 'Auth Database')],
         steps=[
             frame('alt',
                   ('legitimate network drop retry (grace period)', [
                       msg('mobile', 'gateway', 'Retry refresh with previous token and stable request ID', AUTH_REFRESH_REF),
                       msg('gateway', 'auth', 'Forward retry request with request ID', AUTH_REFRESH_REF),
                       msg('auth', 'db', 'Query rotated token and check grace-period recovery window', AUTH_REFRESH_REF),
                       msg('db', 'auth', 'Token was recently rotated under matching request ID', AUTH_REFRESH_REF, reply=True),
                       msg('auth', 'gateway', 'Re-issue replacement token pair without penalty', AUTH_REFRESH_REF, reply=True),
                       msg('gateway', 'mobile', 'Deliver replacement token pair', AUTH_REFRESH_REF, reply=True),
                   ]),
                   ('malicious token replay / breach attempt', [
                       msg('mobile', 'gateway', 'Attempt refresh with expired or previously consumed token', AUTH_REFRESH_REF),
                       msg('gateway', 'auth', 'Forward refresh request', AUTH_REFRESH_REF),
                       msg('auth', 'db', 'Query token hash and check revocation status', AUTH_REFRESH_REF),
                       msg('db', 'auth', 'Token is revoked outside recovery window (Replay detected!)', AUTH_REFRESH_REF, reply=True),
                       msg('auth', 'db', 'Emergency security action: Revoke all active sessions for user', AUTH_REFRESH_REF),
                       msg('auth', 'gateway', 'Reject refresh with 401 Invalid Token', AUTH_REFRESH_REF, reply=True),
                       msg('gateway', 'mobile', 'Return 401 Unauthorized', AUTH_REFRESH_REF, reply=True),
                       note('Client clears local session credentials and redirects user to login', CLIENT_CLIENT_REF)
                   ])
             )
         ]),

    # 27a
    dict(id='27a-reel-upload-flow', title='27a · Publish request, upload lease and video upload',
         participants=[('mobile', 'Mobile creator'), ('gateway', 'API Gateway'), ('media', 'Media service'), ('content', 'Content service'), ('db', 'Content DB / outbox'), ('r2', 'Cloudflare R2')],
         steps=[
             note('Creator taps Publish: synchronous UI tap lock acquired', REEL_CREATOR_REF),
             msg('mobile', 'gateway', 'Request upload authorization & presigned URL\n(Reel intent, file type)', PRESIGN_REF),
             msg('gateway', 'media', 'Forward upload lease & presign request via RPC', PRESIGN_REF),
             msg('media', 'content', 'Reserve 24-hour deterministic upload lease', R_REF),
             msg('content', 'db', 'Acquire key advisory lock & protect against cleanup', R_REF),
             msg('media', 'gateway', 'Return presigned upload URL & storage key (5-min expiry)', PRESIGN_REF, reply=True),
             msg('gateway', 'mobile', 'Deliver presigned upload URL & checkpoint key', PRESIGN_REF, reply=True),
             msg('mobile', 'r2', 'Upload raw video directly to Cloudflare R2\n(PUT with If-None-Match: *)', REELS_HOOK_REF),
             msg('r2', 'mobile', 'Confirm video upload (200 OK or already present)', REELS_HOOK_REF, reply=True),
             note('Client checkpoints upload status and prepares publish payload', REELS_HOOK_REF),
             msg('mobile', 'gateway', 'Submit Reel publication with intent ID & metadata', C_REF),
             msg('gateway', 'content', 'Forward validated Reel creation to Content Service', C_REF),
             msg('content', 'db', 'Atomically commit Reel, adopt lease & queue initial outbox job', R_REF, PRISMA_UNIQUE_REF),
             msg('db', 'content', 'Confirm Reel committed to database', R_REF, reply=True),
             msg('content', 'gateway', 'Acknowledge canonical Reel record', C_REF, reply=True),
             msg('gateway', 'mobile', 'Deliver confirmed Reel ID to mobile creator', REEL_CREATOR_REF, reply=True),
             note('Creator navigates to Reel detail; owner-device local preview rendered immediately', REEL_CREATOR_REF)
         ]),

    # 27b
    dict(id='27b-reel-publish-idempotency', title='27b · Publish idempotency, fingerprint and race reconciliation',
         participants=[('mobile', 'Mobile creator'), ('gateway', 'API Gateway'), ('content', 'Content service'), ('db', 'Content DB / outbox'), ('publisher', 'Content Outbox')],
         steps=[
             note('Network timeout or client retries submission with existing intent ID', REELS_HOOK_REF),
             msg('mobile', 'gateway', 'Resubmit Reel publication with existing intent ID', C_REF),
             msg('gateway', 'content', 'Check publish intent uniqueness in database', C_REF),
             msg('content', 'db', 'Query existing Reel by user and publish intent', PRISMA_UNIQUE_REF),
             frame('alt',
                   ('matching intent and identical fingerprint', [
                       msg('db', 'content', 'Existing Reel found with matching fingerprint', C_REF, reply=True),
                       msg('content', 'gateway', 'Return existing canonical Reel (Idempotent replay)', C_REF, reply=True),
                       msg('gateway', 'mobile', 'Acknowledge Reel creation without duplicating pipeline', REEL_CREATOR_REF, reply=True),
                   ]),
                   ('matching intent with conflicting fingerprint', [
                       msg('db', 'content', 'Existing Reel found with mismatched payload', C_REF, reply=True),
                       msg('content', 'gateway', 'Reject conflicting payload (HTTP 409 Conflict)', C_REF, reply=True),
                       msg('gateway', 'mobile', 'Display conflict error to creator', REEL_CREATOR_REF, reply=True),
                   ]),
                   ('concurrent insert collision (Prisma P2002)', [
                       msg('content', 'db', 'Parallel transaction attempts duplicate insert', R_REF),
                       msg('db', 'content', 'Unique constraint rollback', R_REF, reply=True),
                       msg('content', 'db', 'Concurrent race: Reload winning Reel by user & intent', C_REF),
                       msg('db', 'content', 'Return winning canonical Reel', C_REF, reply=True),
                       msg('content', 'gateway', 'Acknowledge winning Reel to client', C_REF, reply=True),
                       note('Outbox dispatcher ensures exactly one media job is dispatched to queue', OUTBOX_REF)
                   ])
             )
         ]),

    # 28a
    dict(id='28a-media-playback-readiness', title='28a · Source transcode and immediate HLS playback readiness',
         participants=[('broker', 'RabbitMQ Job Queue'), ('worker', 'Media Processing Worker'), ('assets', 'FFmpeg & Storage Assets'), ('content', 'Content Service'), ('db', 'Content DB / outbox')],
         steps=[
             msg('broker', 'worker', 'Deliver source video transcode job from queue', MP_REF),
             msg('worker', 'content', 'Claim processing lease for current transcode attempt', MP_REF),
             msg('content', 'worker', 'Processing lease granted for attempt', MP_REF, reply=True),
             msg('worker', 'assets', 'Download video, apply trim/crop filters, and transcode HLS', PM_REF),
             msg('worker', 'assets', 'Upload HLS playlists, segments, and thumbnail to Cloudflare R2', PM_REF),
             msg('worker', 'assets', 'Validate master manifest, variant playlists, and all segment resources', VAL_STREAM_REF),
             msg('assets', 'worker', 'Validation passed: Stream is fully playable', VAL_STREAM_REF, reply=True),
             msg('worker', 'content', 'Commit HLS playback assets and playback metadata', MP_REF),
             msg('content', 'db', 'Atomically mark Reel MEDIA_READY and queue evidence outbox job', R_REF),
             msg('db', 'content', 'State committed in database', R_REF, reply=True),
             msg('content', 'worker', 'Confirm media status updated to ready for playback', MP_REF, reply=True),
             msg('worker', 'broker', 'Acknowledge transcode job completion to queue', MP_REF),
             note('On accepted commit: Validated HLS is immediately playable! Multimodal evidence extraction runs decoupled in background.', MP_REF)
         ]),

    # 28b
    dict(id='28b-media-evidence-pipeline', title='28b · Durable multimodal evidence extraction and index handoff',
         participants=[('publisher', 'Content Outbox Dispatcher'), ('broker', 'RabbitMQ Job Queue'), ('worker', 'Media Processing Worker'), ('assets', 'FFmpeg / Vision Tools'), ('content', 'Content Service'), ('db', 'Content DB / outbox'), ('indexer', 'Reel Indexing Worker')],
         steps=[
             msg('publisher', 'db', 'Claim committed multimodal evidence outbox jobs', OUTBOX_REF),
             msg('publisher', 'broker', 'Publish EXISTING_HLS evidence extraction job to RabbitMQ', OUTBOX_REF),
             msg('broker', 'worker', 'Deliver multimodal evidence extraction job to worker', MP_REF),
             msg('worker', 'content', 'Claim evidence lease against completed media attempt', MP_REF),
             msg('worker', 'assets', 'Extract audio track from validated HLS and upload audio manifest', PREP_EVID_REF),
             msg('worker', 'assets', 'Extract keyframes and upload checksummed visual manifest', MP_REF),
             msg('worker', 'content', 'Commit audio and visual evidence manifests', MP_REF),
             msg('content', 'db', 'Atomically commit evidence manifests and queue indexing outbox job', R_REF),
             msg('publisher', 'broker', 'Dispatcher publishes indexing job to RabbitMQ queue', OUTBOX_REF),
             msg('broker', 'indexer', 'Deliver indexing job with audio and visual manifest dependencies', INDEX_JOB_REF),
             note('Indexing starts with verified audio & visual evidence; playback remains uninterrupted.', INDEX_JOB_REF)
         ]),

    # 29a
    dict(id='29a-index-intake-routing', title='29a · Indexing attempt claim and route classification',
         participants=[('broker', 'RabbitMQ Index Jobs'), ('worker', 'Reel Indexing Worker'), ('checkpoint', 'Index Checkpoint Store'), ('content', 'Content Service'), ('r2', 'Cloudflare R2 Evidence')],
         steps=[
             msg('broker', 'worker', 'Deliver Reel indexing job from RabbitMQ', INDEX_JOB_REF),
             msg('worker', 'checkpoint', 'Fetch checkpoint to resume indexing attempt', INDEX_WORKFLOW_REF),
             msg('worker', 'content', 'Claim indexing attempt lease via Content Service RPC', INDEX_WORKFLOW_REF),
             msg('content', 'worker', 'Return attempt lease claim status', INDEX_WORKFLOW_REF, reply=True),
             msg('worker', 'checkpoint', 'Initialize or resume attempt state record', INDEX_WORKFLOW_REF),
             msg('worker', 'r2', 'Fetch audio manifest to verify audio stream properties', INDEX_WORKFLOW_REF),
             msg('r2', 'worker', 'Return audio manifest metadata', INDEX_WORKFLOW_REF, reply=True),
             msg('worker', 'worker', 'Classify processing route: NO_AUDIO, SHORT, or LONG', INDEX_WORKFLOW_REF),
             msg('worker', 'checkpoint', 'Save classified route and mark intake checkpoint ready', INDEX_WORKFLOW_REF)
         ]),

    # 29b
    dict(id='29b-index-multimodal-extraction', title='29b · Keyframe vision analysis and speech transcription',
         participants=[('worker', 'Reel Indexing Worker'), ('r2', 'Cloudflare R2 Evidence'), ('ai', 'AI Vision & Speech Service'), ('checkpoint', 'Index Checkpoint Store')],
         steps=[
             note('Phase 1: Keyframe Visual Analysis', INDEX_WORKFLOW_REF),
             frame('loop', ('for each selected representative keyframe', [
                 msg('worker', 'r2', 'Download keyframe image bytes and verify SHA256 checksum', INDEX_WORKFLOW_REF),
                 msg('worker', 'ai', 'Analyze visual frame content (Scene captions, OCR, objects)', INDEX_WORKFLOW_REF),
                 msg('ai', 'worker', 'Return structured frame description, objects, and OCR', INDEX_WORKFLOW_REF, reply=True),
             ])),
             msg('worker', 'checkpoint', 'Mark visual analysis checkpoint complete', INDEX_WORKFLOW_REF),
             note('Phase 2: Speech Transcription & Metadata Rollup', INDEX_WORKFLOW_REF),
             frame('alt',
                   ('audio stream available', [
                       msg('worker', 'ai', 'Transcribe segmented audio via Whisper speech model', INDEX_WORKFLOW_REF),
                       msg('ai', 'worker', 'Return timestamped transcript sentences', INDEX_WORKFLOW_REF, reply=True),
                   ]),
                   ('no audio stream', [
                       note('Bypass speech ASR; synthesize transcript from visual OCR and author metadata', INDEX_WORKFLOW_REF),
                   ])
             ),
             msg('worker', 'ai', 'Extract unified Reel summary, keywords, and topics via LLM', INDEX_WORKFLOW_REF),
             msg('ai', 'worker', 'Return extracted metadata; creator fields remain primary', INDEX_WORKFLOW_REF, reply=True),
             msg('worker', 'checkpoint', 'Checkpoint extracted metadata and transcript sections', INDEX_WORKFLOW_REF)
         ]),

    # 29c
    dict(id='29c-index-vectorization-staging', title='29c · Document token gating, embedding generation and staging',
         participants=[('worker', 'Reel Indexing Worker'), ('ai', 'AI Embedding Service (TEI)'), ('r2', 'Cloudflare R2 Staging'), ('sql', 'Reel Index PostgreSQL'), ('checkpoint', 'Index Checkpoint Store')],
         steps=[
             msg('worker', 'worker', 'Segment evidence into coherent semantic chunks', INDEX_WORKFLOW_REF),
             msg('worker', 'ai', 'Validate chunk token counts against embedding context limit', INDEX_WORKFLOW_REF),
             msg('ai', 'worker', 'Return verified document chunk token counts', INDEX_WORKFLOW_REF, reply=True),
             msg('worker', 'checkpoint', 'Query cache for reusable embeddings by chunk hash and model', INDEX_WORKFLOW_REF),
             msg('checkpoint', 'worker', 'Return cached vector embeddings for identical text', INDEX_WORKFLOW_REF, reply=True),
             msg('worker', 'ai', 'Generate 768-dim vector embeddings for uncached chunks via TEI', RAG_TEI_REF),
             msg('ai', 'worker', 'Return normalized vector embeddings and model metadata', RAG_TEI_REF, reply=True),
             msg('worker', 'r2', 'Stage complete vector bundle and manifest to Cloudflare R2', INDEX_WORKFLOW_REF),
             msg('r2', 'worker', 'Staging checksum and storage URL confirmed', INDEX_WORKFLOW_REF, reply=True),
             msg('worker', 'sql', 'Record candidate index journal and vector bundle in PostgreSQL', INDEX_WORKFLOW_REF),
             msg('sql', 'worker', 'Candidate index record committed', INDEX_WORKFLOW_REF, reply=True),
             note('Candidate index is staged; ready for atomic collection activation in Qdrant', INDEX_WORKFLOW_REF)
         ]),

    # 32a
    dict(id='32a-feed-cache-paging', title='32a · Fast-path cached reel feed paging',
         participants=[('mobile', 'Mobile Feed Viewer'), ('gateway', 'API Gateway'), ('content', 'Content Service'), ('redis', 'Redis Session Store')],
         steps=[
             msg('mobile', 'gateway', 'Request recommended reels feed page\n(Cursor & session ID)', REELS_HOOK_REF),
             msg('gateway', 'content', 'Forward feed recommendation query to Content Service', FEED_REC_REF),
             msg('content', 'redis', 'Read active feed session cache from Redis', FEED_REPO_REF),
             msg('redis', 'content', 'Return cached candidate list and current cursor', FEED_REPO_REF, reply=True),
             msg('content', 'content', 'Slice next page of reels and compute next pagination cursor', FEED_REC_REF),
             msg('content', 'redis', 'Update last-seen position in session cache', FEED_REPO_REF),
             msg('content', 'gateway', 'Return paged feed items, next cursor, and session ID', FEED_REC_REF, reply=True),
             msg('gateway', 'mobile', 'Deliver recommended feed page to mobile viewer', REELS_HOOK_REF, reply=True),
             note('Fast-path response served directly from Redis cache without database queries or ranking bottlenecks', FEED_REC_REF)
         ]),

    # 32b
    dict(id='32b-feed-background-refill', title='32b · Asynchronous feed session refill and candidate ranking',
         participants=[('content', 'Content Service'), ('redis', 'Redis Distributed Lock'), ('friend', 'Friend Service'), ('db', 'Content DB'), ('semantic', 'Semantic Discovery Engine')],
         steps=[
             note('Remaining items in session drop below low-watermark threshold', FEED_REC_REF),
             msg('content', 'redis', 'Acquire distributed Redis refill lock (60-second TTL)', FEED_REPO_REF),
             msg('redis', 'content', 'Lock acquired', FEED_REPO_REF, reply=True),
             msg('content', 'friend', 'Query viewer friend network and audience exclusions', FEED_REC_REF),
             msg('friend', 'content', 'Return blocked author IDs and audience filters', FEED_REC_REF, reply=True),
             msg('content', 'db', 'Query viewer interest profile and recently viewed reel IDs', FEED_REPO_REF),
             msg('db', 'content', 'Return viewer affinity tags and seen history', FEED_REPO_REF, reply=True),
             msg('content', 'semantic', 'Retrieve candidate reels matching interest tags', FEED_REC_REF),
             msg('semantic', 'content', 'Return candidate pool with engagement scores', FEED_REC_REF, reply=True),
             msg('content', 'content', 'Score and rank candidates, filtering previously seen reels', FEED_REC_REF),
             msg('content', 'redis', 'Append ranked reels to session cache and mark refill complete', FEED_REPO_REF),
             msg('content', 'redis', 'Release distributed Redis refill lock', FEED_REPO_REF),
             note('Session refilled in background; upcoming page requests continue uninterrupted', FEED_REC_REF)
         ]),

    # 39a
    dict(id='39a-rag-scope-routing', title='39a · Grounded context authorization and query routing',
         participants=[('mobile', 'Mobile Chat User'), ('conv', 'Conversation Gateway'), ('ai', 'AI Orchestration Service'), ('content', 'Content Service'), ('router', 'Query Router LLM')],
         steps=[
             msg('mobile', 'conv', 'Send chat question with shared Reel in conversation', RAG_CONV_REF),
             msg('conv', 'ai', 'Stream question with conversation history to AI Service', RAG_AI_CTRL_REF),
             msg('ai', 'content', 'Verify user authorization for shared Reels in conversation', RAG_SCOPE_REF),
             msg('content', 'ai', 'Return list of authorized, media-ready and indexed Reel IDs', RAG_SCOPE_REF, reply=True),
             msg('ai', 'router', 'Route query intent: REEL_GROUNDED, GENERAL_CHAT, or NO_CONTEXT', RAG_SCOPE_REF),
             msg('router', 'ai', 'Return routing decision and search parameters', RAG_SCOPE_REF, reply=True),
             note('If no Reel is shared or query is general chat, router cleanly bypasses vector pipeline', RAG_SCOPE_REF)
         ]),

    # 39b
    dict(id='39b-rag-search-rerank', title='39b · Vector retrieval, cross-encoder rerank and context expansion',
         participants=[('ai', 'AI Orchestration Service'), ('tei', 'TEI Server (Embed & Rerank)'), ('qdrant', 'Qdrant Vector DB'), ('index', 'Reel Indexing Service')],
         steps=[
             msg('ai', 'tei', 'Generate 768-dim query embedding vector via TEI', RAG_TEI_REF),
             msg('tei', 'ai', 'Return normalized query embedding vector', RAG_TEI_REF, reply=True),
             msg('ai', 'qdrant', 'Search top-K vector chunks in Qdrant scoped to authorized Reel IDs', RAG_SCOPE_REF),
             msg('qdrant', 'ai', 'Return candidate evidence chunks with similarity scores', RAG_SCOPE_REF, reply=True),
             msg('ai', 'tei', 'Rerank retrieved chunks with cross-encoder reranking model', RAG_TEI_REF),
             msg('tei', 'ai', 'Return cross-encoder relevance scores', RAG_TEI_REF, reply=True),
             msg('ai', 'ai', 'Filter and retain top reranked candidate chunks', RAG_SCOPE_REF),
             msg('ai', 'index', 'Fetch adjacent chunks for temporal and narrative context expansion', RAG_SCOPE_REF),
             msg('index', 'ai', 'Return expanded context chunks and Reel document metadata', RAG_SCOPE_REF, reply=True),
             note('Grounded evidence context assembled and ready for draft answer synthesis', RAG_SCOPE_REF)
         ]),

    # 41a
    dict(id='41a-rag-streamed-generation', title='41a · Grounded draft answer generation and token streaming',
         participants=[('ai', 'AI Generation Service'), ('llm', 'Structured LLM (Groq)'), ('broker', 'RabbitMQ Stream Exchange'), ('conv', 'Conversation Gateway'), ('mobile', 'Mobile Chat User')],
         steps=[
             msg('ai', 'llm', 'Stream grounded answer generation from LLM with assembled context', RAG_AI_CTRL_REF),
             frame('loop', ('for each generated token delta chunk', [
                 msg('llm', 'ai', 'Emit token delta string', RAG_AI_CTRL_REF),
                 msg('ai', 'broker', 'Publish stream_token event via RabbitMQ', RAG_AI_CTRL_REF),
                 msg('broker', 'conv', 'Relay stream token to conversation channel', RAG_CONV_REF),
                 msg('conv', 'mobile', 'Push real-time token to client over WebSocket', RAG_CONV_REF),
             ])),
             msg('llm', 'ai', 'Generation complete: Return full answer text', RAG_AI_CTRL_REF, reply=True),
             note('Real-time token streaming provides instant perceived responsiveness to mobile user', RAG_CONV_REF)
         ]),

    # 41b
    dict(id='41b-rag-verification-attribution', title='41b · Answer verifier, citation attribution and final persistence',
         participants=[('ai', 'AI Generation Service'), ('verifier', 'Verifier Agent'), ('conv', 'Conversation Service'), ('mongo', 'MongoDB Chat Store'), ('mobile', 'Mobile Chat User')],
         steps=[
             msg('ai', 'verifier', 'Verify draft answer factual fidelity against retrieved evidence', RAG_VERIFY_REF),
             frame('alt',
                   ('all factual claims grounded', [
                       msg('verifier', 'ai', 'Verification passed: Grounded claims approved', RAG_VERIFY_REF, reply=True),
                   ]),
                   ('unsupported or hallucinated claim detected', [
                       msg('verifier', 'ai', 'Request targeted factual rewrite with claim bounds', RAG_VERIFY_REF, reply=True),
                       msg('ai', 'ai', 'Apply corrected revision and strip ungrounded assertions', RAG_VERIFY_REF),
                   ])
             ),
             msg('ai', 'ai', 'Attribute grounded citations to source evidence chunks (max 3)', RAG_SCOPE_REF),
             msg('ai', 'conv', 'Return completed answer, verified citations, and trace metadata', RAG_AI_CTRL_REF, reply=True),
             msg('conv', 'mongo', 'Persist assistant response and verified citations in MongoDB', RAG_CONV_REF),
             msg('mongo', 'conv', 'Assistant message persisted in conversation store', RAG_CONV_REF, reply=True),
             msg('conv', 'mobile', 'Deliver completed message event with citation metadata', RAG_CONV_REF),
             note('Turn completed; evidence citations are permanently bound to assistant message', RAG_CONV_REF)
         ]),

    # 17a
    dict(id='17a-auth-registration-request', title='17a · New user registration, credential hashing and email dispatch',
         participants=[('mobile', 'Mobile Client'), ('gateway', 'API Gateway'), ('auth', 'Auth Service'), ('db', 'Auth Database'), ('email', 'Email Notification Queue')],
         steps=[
             msg('mobile', 'gateway', 'Submit user registration credentials\n(Email, username, password)', AUTH_REG_REF),
             msg('gateway', 'auth', 'Route registration request via RPC', AUTH_REG_REF),
             msg('auth', 'auth', 'Validate payload and hash user password (Argon2id)', AUTH_REG_REF),
             msg('auth', 'db', 'Check for existing user email or username', AUTH_REG_REF),
             frame('alt',
                   ('email or username already registered', [
                       msg('db', 'auth', 'Account collision detected', AUTH_REG_REF, reply=True),
                       msg('auth', 'gateway', 'Reject registration (Conflict: Email taken)', AUTH_REG_REF, reply=True),
                       msg('gateway', 'mobile', 'Display registration conflict error', AUTH_REG_REF, reply=True),
                   ]),
                   ('new user account credentials unique', [
                       msg('db', 'auth', 'Account unique; user record not found', AUTH_REG_REF, reply=True),
                       msg('auth', 'db', 'Persist pending unconfirmed user account record', AUTH_REG_REF),
                       msg('db', 'auth', 'Pending user record committed', AUTH_REG_REF, reply=True),
                       msg('auth', 'auth', 'Generate secure 6-digit confirmation token', AUTH_REG_REF),
                       msg('auth', 'email', 'Publish send_verification_email event to RabbitMQ', AUTH_REG_REF),
                       msg('auth', 'gateway', 'Return registration accepted response (Pending verification)', AUTH_REG_REF, reply=True),
                       msg('gateway', 'mobile', 'Prompt user to check inbox for verification code', AUTH_REG_REF, reply=True),
                   ])
             )
         ]),

    # 17b
    dict(id='17b-auth-email-verification', title='17b · Account confirmation and initial session issuance',
         participants=[('mobile', 'Mobile Client'), ('gateway', 'API Gateway'), ('auth', 'Auth Service'), ('db', 'Auth Database')],
         steps=[
             msg('mobile', 'gateway', 'Submit account verification code\n(Email, 6-digit confirmation token)', AUTH_CONFIRM_REF),
             msg('gateway', 'auth', 'Forward verification token payload', AUTH_CONFIRM_REF),
             msg('auth', 'db', 'Query pending account record and verification token hash', AUTH_CONFIRM_REF),
             frame('alt',
                   ('verification token expired or invalid', [
                       msg('db', 'auth', 'Token mismatch or expired verification record', AUTH_CONFIRM_REF, reply=True),
                       msg('auth', 'gateway', 'Return verification failed error', AUTH_CONFIRM_REF, reply=True),
                       msg('gateway', 'mobile', 'Display invalid or expired code alert', AUTH_CONFIRM_REF, reply=True),
                   ]),
                   ('valid confirmation token', [
                       msg('db', 'auth', 'Token match confirmed', AUTH_CONFIRM_REF, reply=True),
                       msg('auth', 'db', 'Atomically update user status to ACTIVE and clear token', AUTH_CONFIRM_REF),
                       msg('db', 'auth', 'Account status confirmed active', AUTH_CONFIRM_REF, reply=True),
                       msg('auth', 'auth', 'Generate initial access and refresh token session pair', AUTH_CONFIRM_REF),
                       msg('auth', 'db', 'Persist new active refresh token session', AUTH_CONFIRM_REF),
                       msg('auth', 'gateway', 'Return confirmed tokens and user profile', AUTH_CONFIRM_REF, reply=True),
                       msg('gateway', 'mobile', 'Deliver authenticated session; redirect user to home feed', AUTH_CONFIRM_REF, reply=True),
                   ])
             )
         ]),

    # 23a
    dict(id='23a-friend-send-request', title='23a · Outgoing friend request and status validation',
         participants=[('sender', 'Sender Client'), ('gateway', 'API Gateway'), ('friend', 'Friend Service'), ('db', 'Friend Database'), ('notify', 'Notification Broker')],
         steps=[
             msg('sender', 'gateway', 'Send friend request to target user ID', FRIEND_SEND_REF),
             msg('gateway', 'friend', 'Route friend request payload to Friend Service', FRIEND_SEND_REF),
             msg('friend', 'friend', 'Validate sender is not targeting themselves', FRIEND_SEND_REF),
             msg('friend', 'db', 'Query existing friendship relationship between users', FRIEND_SEND_REF),
             frame('alt',
                   ('already friends or duplicate request pending', [
                       msg('db', 'friend', 'Existing relationship record found', FRIEND_SEND_REF, reply=True),
                       msg('friend', 'gateway', 'Return error: Friendship or request already active', FRIEND_SEND_REF, reply=True),
                       msg('gateway', 'sender', 'Display already connected status', FRIEND_SEND_REF, reply=True),
                   ]),
                   ('no active relationship exists', [
                       msg('db', 'friend', 'No previous relationship found', FRIEND_SEND_REF, reply=True),
                       msg('friend', 'db', 'Insert new friend request record with status PENDING', FRIEND_SEND_REF),
                       msg('db', 'friend', 'Friend request record committed', FRIEND_SEND_REF, reply=True),
                       msg('friend', 'notify', 'Publish friend_request_received event for recipient', FRIEND_SEND_REF),
                       msg('friend', 'gateway', 'Return friend request sent confirmation', FRIEND_SEND_REF, reply=True),
                       msg('gateway', 'sender', 'Show pending friend request status badge', FRIEND_SEND_REF, reply=True),
                   ])
             )
         ]),

    # 23b
    dict(id='23b-friend-accept-request', title='23b · Friend request acceptance and reciprocal link creation',
         participants=[('recipient', 'Recipient Client'), ('gateway', 'API Gateway'), ('friend', 'Friend Service'), ('db', 'Friend Database'), ('notify', 'Notification Broker')],
         steps=[
             msg('recipient', 'gateway', 'Accept pending friend request ID', FRIEND_ACCEPT_REF),
             msg('gateway', 'friend', 'Forward request acceptance via RPC', FRIEND_ACCEPT_REF),
             msg('friend', 'db', 'Query pending friend request and verify recipient identity', FRIEND_ACCEPT_REF),
             frame('alt',
                   ('request not found or caller is not intended recipient', [
                       msg('db', 'friend', 'Request not found or unauthorized recipient', FRIEND_ACCEPT_REF, reply=True),
                       msg('friend', 'gateway', 'Return 404 or 403 Forbidden', FRIEND_ACCEPT_REF, reply=True),
                       msg('gateway', 'recipient', 'Display invalid request notification', FRIEND_ACCEPT_REF, reply=True),
                   ]),
                   ('valid recipient accepting pending request', [
                       msg('db', 'friend', 'Valid pending request confirmed', FRIEND_ACCEPT_REF, reply=True),
                       msg('friend', 'db', 'Atomically update status to ACCEPTED and establish bidirectional friendship', FRIEND_ACCEPT_REF),
                       msg('db', 'friend', 'Mutual friendship committed to database', FRIEND_ACCEPT_REF, reply=True),
                       msg('friend', 'notify', 'Publish friend_request_accepted notification to sender', FRIEND_ACCEPT_REF),
                       msg('friend', 'gateway', 'Return mutual friendship confirmed status', FRIEND_ACCEPT_REF, reply=True),
                       msg('gateway', 'recipient', 'Update UI: users are now connected friends', FRIEND_ACCEPT_REF, reply=True),
                   ])
             )
         ]),

    # 24a
    dict(id='24a-friend-reject-request', title='24a · Friend request rejection',
         participants=[('recipient', 'Recipient Client'), ('gateway', 'API Gateway'), ('friend', 'Friend Service'), ('db', 'Friend Database')],
         steps=[
             msg('recipient', 'gateway', 'Reject incoming friend request ID', FRIEND_REJECT_REF),
             msg('gateway', 'friend', 'Route rejection command to Friend Service', FRIEND_REJECT_REF),
             msg('friend', 'db', 'Query pending request and verify recipient ownership', FRIEND_REJECT_REF),
             msg('db', 'friend', 'Pending request found', FRIEND_REJECT_REF, reply=True),
             msg('friend', 'db', 'Update request status to REJECTED (or remove record)', FRIEND_REJECT_REF),
             msg('db', 'friend', 'Request updated', FRIEND_REJECT_REF, reply=True),
             msg('friend', 'gateway', 'Confirm friend request declined', FRIEND_REJECT_REF, reply=True),
             msg('gateway', 'recipient', 'Remove request from incoming pending list', FRIEND_REJECT_REF, reply=True),
             note('Rejection is silent; sender receives no notification to prevent harassment', FRIEND_REJECT_REF)
         ]),

    # 24b
    dict(id='24b-friend-cancel-request', title='24b · Friend request cancellation by sender',
         participants=[('sender', 'Sender Client'), ('gateway', 'API Gateway'), ('friend', 'Friend Service'), ('db', 'Friend Database')],
         steps=[
             msg('sender', 'gateway', 'Cancel outgoing friend request ID', FRIEND_CANCEL_REF),
             msg('gateway', 'friend', 'Route cancel command to Friend Service', FRIEND_CANCEL_REF),
             msg('friend', 'db', 'Query pending request and verify caller is original sender', FRIEND_CANCEL_REF),
             msg('db', 'friend', 'Pending request found with matching sender ID', FRIEND_CANCEL_REF, reply=True),
             msg('friend', 'db', 'Delete pending friend request record', FRIEND_CANCEL_REF),
             msg('db', 'friend', 'Record deleted', FRIEND_CANCEL_REF, reply=True),
             msg('friend', 'gateway', 'Confirm friend request cancelled', FRIEND_CANCEL_REF, reply=True),
             msg('gateway', 'sender', 'Reset user profile button to "Add Friend"', FRIEND_CANCEL_REF, reply=True)
         ]),

    # 24c
    dict(id='24c-friend-unfriend', title='24c · Friendship removal and reciprocal link teardown',
         participants=[('user', 'User Client'), ('gateway', 'API Gateway'), ('friend', 'Friend Service'), ('db', 'Friend Database'), ('cache', 'Relationship Cache')],
         steps=[
             msg('user', 'gateway', 'Request unfriend for target user ID', FRIEND_REMOVE_REF),
             msg('gateway', 'friend', 'Route unfriend command to Friend Service', FRIEND_REMOVE_REF),
             msg('friend', 'db', 'Verify existing mutual friendship record between users', FRIEND_REMOVE_REF),
             msg('db', 'friend', 'Active friendship relation verified', FRIEND_REMOVE_REF, reply=True),
             msg('friend', 'db', 'Atomically delete bidirectional friendship records', FRIEND_REMOVE_REF),
             msg('db', 'friend', 'Friendship relation removed', FRIEND_REMOVE_REF, reply=True),
             msg('friend', 'cache', 'Evict cached friendship relation keys for both users', FRIEND_REMOVE_REF),
             msg('friend', 'gateway', 'Confirm friendship terminated', FRIEND_REMOVE_REF, reply=True),
             msg('gateway', 'user', 'Update friend profile UI to non-friend state', FRIEND_REMOVE_REF, reply=True)
         ]),

    # 30a
    dict(id='30a-index-checkpoint-resume', title='30a · Indexing stage checkpointing and crash recovery resume',
         participants=[('broker', 'RabbitMQ Consumer'), ('worker', 'Reel Index Worker'), ('mongo', 'MongoDB Checkpoint Store'), ('workflow', 'LangGraph Pipeline')],
         steps=[
             msg('broker', 'worker', 'Deliver reel_index_job message with Reel ID & run attempt', INDEX_JOB_REF),
             msg('worker', 'mongo', 'Query latest saved checkpoint state for Reel job', INDEX_JOB_REF),
             frame('alt',
                   ('no previous checkpoint found (fresh start)', [
                       msg('mongo', 'worker', 'No saved checkpoint; start from INITIAL stage', INDEX_JOB_REF, reply=True),
                       msg('worker', 'workflow', 'Execute pipeline from first stage: Video frame extraction', INDEX_WORKFLOW_REF),
                   ]),
                   ('checkpoint exists from interrupted run', [
                       msg('mongo', 'worker', 'Return saved stage state (e.g., Audio transcribed)', INDEX_JOB_REF, reply=True),
                       msg('worker', 'worker', 'Inspect completed stage artifacts and skip redundant computation', INDEX_JOB_REF),
                       msg('worker', 'workflow', 'Resume pipeline directly from next stage: Text embedding generation', INDEX_WORKFLOW_REF),
                   ])
             ),
             msg('workflow', 'mongo', 'Persist updated intermediate stage checkpoint', INDEX_WORKFLOW_REF),
             note('Granular stage checkpoints ensure long-running multimodal pipelines do not re-run from scratch after crash', INDEX_JOB_REF)
         ]),

    # 30b
    dict(id='30b-index-stale-fencing', title='30b · Stale indexing attempt detection and version fencing',
         participants=[('broker', 'RabbitMQ Consumer'), ('worker', 'Reel Index Worker'), ('content', 'Content Service'), ('db', 'Content DB')],
         steps=[
             msg('broker', 'worker', 'Receive delayed indexing job message (attempt N)', INDEX_JOB_REF),
             msg('worker', 'content', 'Fetch canonical Reel version and active indexing run token', INDEX_JOB_REF),
             msg('content', 'db', 'Query current Reel state and indexing token', INDEX_JOB_REF),
             msg('db', 'content', 'Return current Reel version & active run ID', INDEX_JOB_REF, reply=True),
             msg('content', 'worker', 'Return authoritative Reel state', INDEX_JOB_REF, reply=True),
             frame('alt',
                   ('job token matches current active run token', [
                       msg('worker', 'worker', 'Token match confirmed: Attempt is authoritative', INDEX_JOB_REF),
                       msg('worker', 'worker', 'Proceed with indexing pipeline execution', INDEX_JOB_REF),
                   ]),
                   ('job token is stale (superseded by newer edit or re-index)', [
                       msg('worker', 'worker', 'Fencing violation: Superseded run detected', INDEX_JOB_REF),
                       msg('worker', 'broker', 'Acknowledge and discard obsolete job message', INDEX_JOB_REF),
                       note('Fencing prevents zombie background workers from overwriting fresher index data', INDEX_JOB_REF)
                   ])
             )
         ]),

    # 31a
    dict(id='31a-index-atomic-activation', title='31a · Atomic vector staging commit and production activation',
         participants=[('workflow', 'LangGraph Pipeline'), ('qdrant', 'Qdrant Vector Store'), ('content', 'Content Service'), ('db', 'Content DB'), ('cache', 'Search Cache')],
         steps=[
             msg('workflow', 'qdrant', 'Batch upsert semantic embeddings to staging collection', INDEX_WORKFLOW_REF),
             msg('qdrant', 'workflow', 'Staging vectors acknowledged and indexed', INDEX_WORKFLOW_REF, reply=True),
             msg('workflow', 'content', 'Notify indexing pipeline completed with vector IDs', INDEX_WORKFLOW_REF),
             msg('content', 'db', 'Atomically update Reel index status to ACTIVE & store vector IDs', INDEX_WORKFLOW_REF),
             msg('db', 'content', 'Reel index status committed to database', INDEX_WORKFLOW_REF, reply=True),
             msg('content', 'cache', 'Invalidate stale semantic search & recommendation cache entries', RAG_SCOPE_REF),
             msg('content', 'workflow', 'Confirm Reel is now fully discoverable in production', INDEX_WORKFLOW_REF, reply=True),
             note('Two-phase staging ensures search queries never encounter partially indexed Reel vectors', INDEX_WORKFLOW_REF)
         ]),

    # 31b
    dict(id='31b-index-rollback-recovery', title='31b · Pipeline failure handling, partial vector cleanup and DLQ routing',
         participants=[('workflow', 'LangGraph Pipeline'), ('qdrant', 'Qdrant Vector Store'), ('worker', 'Reel Index Worker'), ('broker', 'RabbitMQ DLQ'), ('content', 'Content DB')],
         steps=[
             msg('workflow', 'worker', 'Multimodal processing error (e.g. model timeout or corrupt audio)', INDEX_WORKFLOW_REF),
             msg('worker', 'qdrant', 'Execute rollback: Delete any partially written staging vectors', INDEX_WORKFLOW_REF),
             msg('qdrant', 'worker', 'Staging cleanup confirmed', INDEX_WORKFLOW_REF, reply=True),
             msg('worker', 'content', 'Update Reel index status to FAILED with error diagnostic code', INDEX_JOB_REF),
             frame('alt',
                   ('retry budget remaining (retries < max_limit)', [
                       msg('worker', 'broker', 'Requeue message with exponential backoff delay', INDEX_JOB_REF),
                   ]),
                   ('retry budget exhausted', [
                       msg('worker', 'broker', 'Publish message to Dead Letter Queue (DLQ) for operator inspection', INDEX_JOB_REF),
                       note('Operator alerted; DLQ retains full payload and failure stack trace for debugging', INDEX_JOB_REF)
                   ])
             )
         ]),

    # 34a
    dict(id='34a-hls-owner-preview', title='34a · Creator instant local video playback preview',
         participants=[('creator', 'Mobile Creator'), ('player', 'Local Video Player'), ('cache', 'Local Video Cache'), ('gateway', 'API Gateway')],
         steps=[
             note('Creator taps Publish; cloud transcode is still in progress in background', REEL_CREATOR_REF),
             msg('creator', 'player', 'Navigate to Reel detail screen immediately', REEL_CREATOR_REF),
             msg('player', 'cache', 'Query local device cache for original recorded video file', REEL_CREATOR_REF),
             frame('alt',
                   ('local source video present in cache', [
                       msg('cache', 'player', 'Return local file URI from device storage', REEL_CREATOR_REF, reply=True),
                       msg('player', 'creator', 'Play high-resolution local video instantly with zero latency', REEL_CREATOR_REF),
                       note('Creator perceives instant upload completion while cloud pipeline runs asynchronously', REEL_CREATOR_REF)
                   ]),
                   ('local source video cleared or evicted', [
                       msg('cache', 'player', 'Cache miss: local file not found', REEL_CREATOR_REF, reply=True),
                       msg('player', 'gateway', 'Request current cloud processing and preview stream URL', VAL_STREAM_REF),
                       msg('gateway', 'player', 'Return provisional playback stream or thumbnail poster', VAL_STREAM_REF, reply=True),
                       msg('player', 'creator', 'Render placeholder poster with "Transcoding..." indicator', VAL_STREAM_REF)
                   ])
             )
         ]),

    # 34b
    dict(id='34b-hls-validated-stream', title='34b · Public validated HLS adaptive stream delivery via CDN',
         participants=[('viewer', 'Viewer Client'), ('cdn', 'Cloudflare CDN'), ('media', 'Media Processing Service'), ('r2', 'Cloudflare R2 Storage')],
         steps=[
             msg('viewer', 'cdn', 'Request master playlist: GET /hls/reel_123/master.m3u8', VAL_STREAM_REF),
             frame('alt',
                   ('CDN cache hit', [
                       msg('cdn', 'viewer', 'Return cached master playlist (200 OK)', VAL_STREAM_REF, reply=True),
                   ]),
                   ('CDN cache miss', [
                       msg('cdn', 'media', 'Forward master playlist request to origin', VAL_STREAM_REF),
                       msg('media', 'r2', 'Fetch validated HLS master playlist from storage', PREP_EVID_REF),
                       msg('r2', 'media', 'Deliver master playlist file', PREP_EVID_REF, reply=True),
                       msg('media', 'cdn', 'Return playlist with Cache-Control headers', VAL_STREAM_REF, reply=True),
                       msg('cdn', 'viewer', 'Deliver master playlist (1080p, 720p, 480p variants)', VAL_STREAM_REF, reply=True),
                   ])
             ),
             msg('viewer', 'cdn', 'Request video segments: GET /hls/reel_123/720p/seg_001.ts', VAL_STREAM_REF),
             msg('cdn', 'viewer', 'Stream high-speed cached media segment chunks', VAL_STREAM_REF, reply=True),
             note('Adaptive bitrate streaming dynamically selects optimal resolution based on viewer network conditions', VAL_STREAM_REF)
         ]),

    # 35a
    dict(id='35a-series-creation-flow', title='35a · Reel series collection creation and metadata binding',
         participants=[('creator', 'Creator Client'), ('gateway', 'API Gateway'), ('content', 'Content Service'), ('db', 'Content DB')],
         steps=[
             msg('creator', 'gateway', 'Submit series creation request\n(Title, description, cover photo)', SERIES_CREATE_REF),
             msg('gateway', 'content', 'Route series creation command to Content Service', SERIES_CREATE_REF),
             msg('content', 'content', 'Validate title length, description and creator quota', SERIES_CREATE_REF),
             msg('content', 'db', 'Insert new Reel Series record linked to creator user ID', SERIES_CREATE_REF),
             msg('db', 'content', 'Series record committed to database', SERIES_CREATE_REF, reply=True),
             msg('content', 'gateway', 'Return created series ID and details', SERIES_CREATE_REF, reply=True),
             msg('gateway', 'creator', 'Display created series in creator studio dashboard', SERIES_CREATE_REF, reply=True)
         ]),

    # 35b
    dict(id='35b-series-reels-ordering', title='35b · Adding and reordering Reel episodes within a series',
         participants=[('creator', 'Creator Client'), ('gateway', 'API Gateway'), ('content', 'Content Service'), ('db', 'Content DB')],
         steps=[
             msg('creator', 'gateway', 'Submit episode order update\n(Series ID, ordered array of Reel IDs)', SERIES_REORDER_REF),
             msg('gateway', 'content', 'Route reorder command to Content Service', SERIES_REORDER_REF),
             msg('content', 'db', 'Verify creator ownership of series and all assigned Reels', SERIES_REORDER_REF),
             msg('db', 'content', 'Ownership verified for all items', SERIES_REORDER_REF, reply=True),
             msg('content', 'db', 'Execute bulk update: assign episodeSequence 1..N to Reels', SERIES_REORDER_REF),
             msg('db', 'content', 'New episode ordering committed', SERIES_REORDER_REF, reply=True),
             msg('content', 'gateway', 'Return updated series episode list', SERIES_REORDER_REF, reply=True),
             msg('gateway', 'creator', 'Display updated sequential episode playlist', SERIES_REORDER_REF, reply=True)
         ]),

    # 36a
    dict(id='36a-series-playback-entry', title='36a · Series episode list discovery and initial playback start',
         participants=[('viewer', 'Viewer Client'), ('gateway', 'API Gateway'), ('content', 'Content Service'), ('db', 'Content DB'), ('cache', 'Series Cache Store')],
         steps=[
             msg('viewer', 'gateway', 'Request series detail & episode list: GET /series/:id/episodes', SERIES_EPISODES_REF),
             msg('gateway', 'content', 'Forward episode list request to Content Service', SERIES_EPISODES_REF),
             msg('content', 'cache', 'Query cached episode list for series ID', SERIES_EPISODES_REF),
             frame('alt',
                   ('cache hit', [
                       msg('cache', 'content', 'Return cached episode manifest', SERIES_EPISODES_REF, reply=True),
                   ]),
                   ('cache miss', [
                       msg('content', 'db', 'Query series metadata and ordered public Reels', SERIES_EPISODES_REF),
                       msg('db', 'content', 'Return series data with sorted episode records', SERIES_EPISODES_REF, reply=True),
                       msg('content', 'cache', 'Store episode manifest in cache (TTL 10 min)', SERIES_EPISODES_REF),
                   ])
             ),
             msg('content', 'gateway', 'Return series details with ordered episode list', SERIES_EPISODES_REF, reply=True),
             msg('gateway', 'viewer', 'Render series playlist and begin playing Episode 1', SERIES_EPISODES_REF, reply=True)
         ]),

    # 36b
    dict(id='36b-series-episode-switch', title='36b · Seamless automatic next-episode progression',
         participants=[('viewer', 'Viewer Client'), ('player', 'Video Player Controller'), ('content', 'Content Service'), ('cdn', 'Cloudflare CDN')],
         steps=[
             msg('viewer', 'player', 'Video playback reaches end of current episode (ended event)', SERIES_EPISODES_REF),
             msg('player', 'player', 'Inspect series playlist: Identify next episode ID in sequence', SERIES_EPISODES_REF),
             frame('alt',
                   ('next episode exists in series playlist', [
                       msg('player', 'cdn', 'Prefetch next episode master HLS playlist', VAL_STREAM_REF),
                       msg('cdn', 'player', 'Deliver next episode playlist segments', VAL_STREAM_REF, reply=True),
                       msg('player', 'viewer', 'Seamlessly transition video player to next episode without pause', SERIES_EPISODES_REF),
                       msg('player', 'content', 'Send async playback progress heartbeat to Content Service', FEED_REC_REF),
                   ]),
                   ('current episode was final episode in series', [
                       msg('player', 'viewer', 'Show series completion summary card & recommended series', SERIES_EPISODES_REF),
                   ])
             )
         ]),

    # 37a
    dict(id='37a-share-to-ai-assistant', title='37a · Sharing a Reel card to Velora AI assistant chat',
         participants=[('mobile', 'Mobile Client'), ('gateway', 'API Gateway'), ('content', 'Content Service'), ('conv', 'Conversation Service'), ('mongo', 'MongoDB Chat Store')],
         steps=[
             msg('mobile', 'gateway', 'Share Reel to AI assistant chat\n(Reel ID, optional user prompt)', SHARE_REEL_REF),
             msg('gateway', 'content', 'Fetch public Reel card summary & metadata', SHARE_REEL_REF),
             msg('content', 'gateway', 'Return validated Reel card data', SHARE_REEL_REF, reply=True),
             msg('gateway', 'conv', 'Post Reel attachment message into user-bot conversation turn', RAG_CONV_REF),
             msg('conv', 'mongo', 'Persist user message with rich Reel card attachment', RAG_CONV_REF),
             msg('mongo', 'conv', 'Attachment message persisted', RAG_CONV_REF, reply=True),
             msg('conv', 'gateway', 'Confirm Reel shared to AI chat session', RAG_CONV_REF, reply=True),
             msg('gateway', 'mobile', 'Open chat screen displaying shared Reel preview card', RAG_CONV_REF, reply=True),
             note('AI assistant receives Reel context in prompt to answer questions about the video content', RAG_CONV_REF)
         ]),

    # 37b
    dict(id='37b-share-to-user-chat', title='37b · Sharing a Reel via direct message to friends',
         participants=[('sender', 'Sender Client'), ('gateway', 'API Gateway'), ('content', 'Content Service'), ('conv', 'Conversation Service'), ('recipient', 'Recipient Client')],
         steps=[
             msg('sender', 'gateway', 'Share Reel to friend or group chat\n(Reel ID, recipient user/group ID)', SHARE_REEL_REF),
             msg('gateway', 'content', 'Verify Reel exists and is publicly shareable', SHARE_REEL_REF),
             msg('content', 'gateway', 'Confirm Reel validity & provide preview card snapshot', SHARE_REEL_REF, reply=True),
             msg('gateway', 'conv', 'Dispatch direct message with embedded Reel preview payload', RAG_CONV_REF),
             msg('conv', 'recipient', 'Push real-time message notification over WebSocket', RAG_CONV_REF),
             msg('conv', 'gateway', 'Acknowledge direct message delivered', RAG_CONV_REF, reply=True),
             msg('gateway', 'sender', 'Display "Reel sent" confirmation toast', SHARE_REEL_REF, reply=True)
         ]),

    # 38a
    dict(id='38a-share-link-generation', title='38a · Unique public share link generation and signature',
         participants=[('creator', 'Mobile Creator'), ('gateway', 'API Gateway'), ('content', 'Content Service'), ('db', 'Content DB')],
         steps=[
             msg('creator', 'gateway', 'Request shareable link for Reel ID', SHARE_LINK_CREATE_REF),
             msg('gateway', 'content', 'Forward link generation request via RPC', SHARE_LINK_CREATE_REF),
             msg('content', 'db', 'Query Reel visibility and existing active share links', SHARE_LINK_CREATE_REF),
             msg('db', 'content', 'Return Reel status', SHARE_LINK_CREATE_REF, reply=True),
             msg('content', 'content', 'Generate cryptographically random 10-char nano ID token', SHARE_LINK_CREATE_REF),
             msg('content', 'db', 'Persist share link token mapped to Reel ID and creator ID', SHARE_LINK_CREATE_REF),
             msg('db', 'content', 'Share link record committed', SHARE_LINK_CREATE_REF, reply=True),
             msg('content', 'gateway', 'Return canonical share URL: https://velora.app/r/{token}', SHARE_LINK_CREATE_REF, reply=True),
             msg('gateway', 'creator', 'Copy link to device clipboard and open system share sheet', SHARE_LINK_CREATE_REF, reply=True)
         ]),

    # 38b
    dict(id='38b-share-link-resolution', title='38b · Public share link resolution, analytics and app handoff',
         participants=[('viewer', 'Web / Deep Link Viewer'), ('gateway', 'API Gateway'), ('content', 'Content Service'), ('db', 'Content DB'), ('cdn', 'Cloudflare CDN')],
         steps=[
             msg('viewer', 'gateway', 'Open shared link: GET /r/{token} (with User-Agent & Referrer)', SHARE_LINK_RESOLVE_REF),
             msg('gateway', 'content', 'Resolve share token via Content Service', SHARE_LINK_RESOLVE_REF),
             msg('content', 'db', 'Query share link token and fetch associated Reel record', SHARE_LINK_RESOLVE_REF),
             frame('alt',
                   ('token not found or expired', [
                       msg('db', 'content', 'Token does not exist', SHARE_LINK_RESOLVE_REF, reply=True),
                       msg('content', 'gateway', 'Return 404 Not Found', SHARE_LINK_RESOLVE_REF, reply=True),
                       msg('gateway', 'viewer', 'Render "Reel unavailable or link expired" web page', SHARE_LINK_RESOLVE_REF, reply=True),
                   ]),
                   ('valid share token found', [
                       msg('db', 'content', 'Return active Reel and creator details', SHARE_LINK_RESOLVE_REF, reply=True),
                       msg('content', 'db', 'Increment share link visit count and record analytics event', SHARE_LINK_RESOLVE_REF),
                       msg('content', 'gateway', 'Return Reel OpenGraph metadata and deep link URI', SHARE_LINK_RESOLVE_REF, reply=True),
                       msg('gateway', 'viewer', 'Redirect mobile device to velora://reel/{id} (or render web player)', SHARE_LINK_RESOLVE_REF, reply=True),
                   ])
             )
         ]),

    # 40a
    dict(id='40a-rag-turn-memory-assembly', title='40a · Multi-turn conversation memory context assembly',
         participants=[('conv', 'Conversation Service'), ('mongo', 'MongoDB Chat Store'), ('builder', 'Turn Memory Builder'), ('ai', 'AI Generation Service')],
         steps=[
             msg('conv', 'mongo', 'Query recent message history for current conversation ID', RAG_MEMORY_TURN_REF),
             msg('mongo', 'conv', 'Return last 10 messages with role tags and timestamps', RAG_MEMORY_TURN_REF, reply=True),
             msg('conv', 'builder', 'Assemble memory context window from conversation history', RAG_MEMORY_TURN_REF),
             msg('builder', 'builder', 'Filter out obsolete tool calls and truncate messages exceeding token limits', RAG_MEMORY_TURN_REF),
             msg('builder', 'builder', 'Inject persistent user profile and preferences summary', RAG_MEMORY_TURN_REF),
             msg('builder', 'conv', 'Return sanitized multi-turn conversation memory block', RAG_MEMORY_TURN_REF, reply=True),
             msg('conv', 'ai', 'Forward prompt payload with assembled memory context to AI Service', RAG_AI_CTRL_REF),
             note('Structured memory assembly preserves context continuity while staying strictly within LLM context budget', RAG_MEMORY_TURN_REF)
         ]),

    # 40b
    dict(id='40b-rag-summary-maintenance', title='40b · Conversation background condensation and summarization',
         participants=[('agent', 'Background Memory Agent'), ('mongo', 'MongoDB Chat Store'), ('llm', 'LLM Summarizer'), ('ai', 'AI Service')],
         steps=[
             msg('agent', 'mongo', 'Scan conversation sessions exceeding 20 uncompressed turns', RAG_MEMORY_AGENT_REF),
             msg('mongo', 'agent', 'Return uncompacted message history batch', RAG_MEMORY_AGENT_REF, reply=True),
             msg('agent', 'llm', 'Prompt LLM to extract key user facts, preferences and discussion summary', RAG_MEMORY_AGENT_REF),
             msg('llm', 'agent', 'Return structured concise summary string', RAG_MEMORY_AGENT_REF, reply=True),
             msg('agent', 'mongo', 'Update conversation session with new condensed summary block', RAG_MEMORY_AGENT_REF),
             msg('agent', 'mongo', 'Archive older raw message turns to cold storage', RAG_MEMORY_AGENT_REF),
             msg('mongo', 'agent', 'Session compaction committed', RAG_MEMORY_AGENT_REF, reply=True),
             note('Compaction reduces LLM token costs by over 70% on long-running multi-day conversations', RAG_MEMORY_AGENT_REF)
         ]),

    # 42a
    dict(id='42a-observability-trace-capture', title='42a · Microservice distributed tracing and span instrumentation',
         participants=[('client', 'Client / API Gateway'), ('service', 'Backend Microservice'), ('collector', 'OpenTelemetry Collector'), ('langfuse', 'Langfuse Tracing Service')],
         steps=[
             msg('client', 'service', 'Dispatch HTTP/RPC request with W3C traceparent header', LANGFUSE_TRACING_REF),
             msg('service', 'service', 'Extract parent trace ID and initialize root execution span', LANGFUSE_TRACING_REF),
             msg('service', 'service', 'Execute business logic; create nested child spans for DB & RPC calls', LANGFUSE_TRACING_REF),
             msg('service', 'collector', 'Emit completed OpenTelemetry span records via gRPC', LANGFUSE_TRACING_REF),
             msg('service', 'langfuse', 'Record AI generation metadata (Prompt tokens, completion tokens, model latency)', LANGFUSE_TRACING_REF),
             msg('service', 'client', 'Return operation response with trace-id in response header', LANGFUSE_TRACING_REF, reply=True),
             note('Correlated distributed spans allow end-to-end latency and error attribution across all microservices', LANGFUSE_TRACING_REF)
         ]),

    # 42b
    dict(id='42b-observability-trace-analysis', title='42b · Trace query, latency analysis and token cost auditing',
         participants=[('operator', 'Observability Dashboard'), ('langfuse', 'Langfuse API'), ('metrics', 'Metrics Database'), ('alert', 'Alerting Engine')],
         steps=[
             msg('operator', 'langfuse', 'Query recent RAG traces filtered by latency > 2s or error status', LANGFUSE_TRACING_REF),
             msg('langfuse', 'operator', 'Return flame-graph trace tree with component breakdown', LANGFUSE_TRACING_REF, reply=True),
             msg('langfuse', 'metrics', 'Aggregate token consumption and cost metrics per model/endpoint', LANGFUSE_TRACING_REF),
             frame('alt',
                   ('p99 latency or cost spike detected', [
                       msg('metrics', 'alert', 'Trigger threshold alert to engineering team via Slack/PagerDuty', LANGFUSE_TRACING_REF),
                   ]),
                   ('metrics within normal bounds', [
                       msg('metrics', 'operator', 'Display operational health status (All SLOs green)', LANGFUSE_TRACING_REF, reply=True),
                   ])
             )
         ]),
]

def build_diagram_element(m):
    p = ET.Element('diagram', id=m['id'], name=m['title'])
    g = ET.SubElement(p, 'mxGraphModel', dx='0', dy='0', grid='1', gridSize='10', guides='1', tooltips='1',
                      connect='1', arrows='1', fold='1', page='1', pageScale='1', pageWidth='2800', pageHeight='3800',
                      background='#ffffff', adaptiveColors='auto',
                      conformance='Practical UML sequence subset; native draw.io figure styles', scopeDescription=m['title'])
    root = ET.SubElement(g, 'root')
    ET.SubElement(root, 'mxCell', id='0')
    ET.SubElement(root, 'mxCell', id='1', parent='0')
    count = 0
    order = 0
    lanes = {a: 300 + i * 320 for i, (a, _) in enumerate(m['participants'])}
    width = max(lanes.values()) + 250

    def cell(label, x, y, w, h, style=STYLE + 'text;whiteSpace=wrap;align=center;verticalAlign=middle;fillColor=none;strokeColor=none;', e=(), **attrs):
        nonlocal count
        count += 1
        c = ET.SubElement(root, 'mxCell', id=f'flow{count}', value=html.escape(label).replace('\n', '<br>'),
                          vertex='1', parent='1', style=style, sourceEvidence=json.dumps(e), **attrs)
        ET.SubElement(c, 'mxGeometry', x=str(x), y=str(y), width=str(w), height=str(h), **{'as': 'geometry'})
        return c

    def edge(a, b, label, y, sort, e=()):
        nonlocal count, order
        count += 1
        order += 1
        is_self = (a == b)
        base_style = STYLE + 'endArrow=' + ('open;dashed=1;' if sort == 'reply' else 'open;endFill=0;' if sort == 'asynchSignal' else 'block;endFill=1;')
        if is_self:
            loop_w = 40
            loop_h = 28
            style = base_style + 'edgeStyle=orthogonalEdgeStyle;curved=0;rounded=0;orthogonalLoop=1;jettySize=auto;labelBackgroundColor=#ffffff;labelWidth=240;whiteSpace=wrap;align=left;'
        else:
            style = base_style + 'labelBackgroundColor=#ffffff;labelWidth=550;whiteSpace=wrap;align=center;'
        c = ET.SubElement(root, 'mxCell', id=f'flow{count}', value=html.escape(label).replace('\n', '<br>'),
                          edge='1', parent='1',
                          style=style,
                          messageSort=sort, fromParticipant=a, toParticipant=b, order=str(order), sourceEvidence=json.dumps(e))
        geom = ET.SubElement(c, 'mxGeometry', relative='1', **{'as': 'geometry'})
        if is_self:
            ET.SubElement(geom, 'mxPoint', x=str(lanes[a]), y=str(y), **{'as': 'sourcePoint'})
            ET.SubElement(geom, 'mxPoint', x=str(lanes[a]), y=str(y + 28), **{'as': 'targetPoint'})
            pts = ET.SubElement(geom, 'Array', **{'as': 'points'})
            ET.SubElement(pts, 'mxPoint', x=str(lanes[a] + 40), y=str(y))
            ET.SubElement(pts, 'mxPoint', x=str(lanes[a] + 40), y=str(y + 28))
            ET.SubElement(geom, 'mxPoint', x='10', y='-10', **{'as': 'offset'})
        else:
            ET.SubElement(geom, 'mxPoint', x=str(lanes[a]), y=str(y), **{'as': 'sourcePoint'})
            ET.SubElement(geom, 'mxPoint', x=str(lanes[b]), y=str(y), **{'as': 'targetPoint'})
            ET.SubElement(geom, 'mxPoint', x='0', y='-25', **{'as': 'offset'})

    def render_steps(items, y, depth=0):
        for s in items:
            if s['type'] == 'message':
                edge(s['from'], s['to'], s['label'], y + 55, s['sort'], s['evidence'])
                y += 135 if s['from'] == s['to'] else 125
            elif s['type'] == 'ref':
                cell('ref', 180 + depth * 15, y + 10, width - 330 - depth * 30, 70,
                     STYLE + 'shape=umlFrame;fillColor=light-dark(#ffffff,#181818);align=left;verticalAlign=top;spacingLeft=8;spacingTop=4;',
                     s['evidence'])
                cell(s['label'], 188 + depth * 15, y + 32, width - 350 - depth * 30, 44,
                     STYLE + 'text;whiteSpace=wrap;align=left;verticalAlign=middle;strokeColor=none;fillColor=none;',
                     s['evidence'])
                y += 100
            else:
                top = y
                f = cell(s['operator'], 130 + depth * 15, y, width - 220 - depth * 30, 1,
                         STYLE + 'shape=umlFrame;fillColor=none;align=left;verticalAlign=top;spacingLeft=8;spacingTop=4;',
                         e=s.get('evidence', []), interactionOperator=s['operator'])
                y += 50
                for j, o in enumerate(s['operands']):
                    if j:
                        cell('', 145 + depth * 15, y, width - 250 - depth * 30, 1, STYLE + 'fillColor=none;dashed=1;')
                        y += 20
                    cell('[' + o['guard'] + ']', 155 + depth * 15, y, width - 280 - depth * 30, 45,
                         STYLE + 'text;whiteSpace=wrap;align=left;strokeColor=none;fillColor=none;', o.get('evidence', []))
                    y = render_steps(o['steps'], y + 60, depth + 1)
                f.find('mxGeometry').set('height', str(y - top + 15))
                y += 35
        return y

    cell(m['title'], 130, 20, width - 220, 50, STYLE + 'text;fontSize=24;align=left;strokeColor=none;fillColor=none;')
    headers = []
    for a, label in m['participants']:
        h = cell(label, lanes[a] - 130, 100, 260, 65,
                 STYLE + 'rounded=0;fillColor=#ffffff;whiteSpace=wrap;align=center;verticalAlign=middle;', participantId=a)
        headers.append((a, h))
    end = render_steps(m['steps'], 200)
    for a, h in headers:
        count += 1
        line = ET.Element('mxCell', id=f'life{count}', edge='1', parent='1', style=STYLE + 'dashed=1;endArrow=none;')
        geom = ET.SubElement(line, 'mxGeometry', relative='1', **{'as': 'geometry'})
        ET.SubElement(geom, 'mxPoint', x=str(lanes[a]), y='165', **{'as': 'sourcePoint'})
        ET.SubElement(geom, 'mxPoint', x=str(lanes[a]), y=str(end), **{'as': 'targetPoint'})
        root.insert(2, line)

    semantic_participants = [
        dict(id=a, label=b, kind='client' if a in ('mobile', 'creator', 'player', 'caller1', 'caller2', 'sender', 'recipient', 'user', 'external', 'operator', 'viewer', 'client') else 'store' if a in ('db', 'secure', 'checkpoint', 'mongo', 'redis', 'sql', 'cache', 'metrics') else 'external' if a in ('r2', 'assets', 'broker', 'llm', 'tei', 'qdrant', 'mail', 'cdn', 'langfuse', 'notify', 'email', 'alert') else 'service', evidence=[])
        for a, b in m['participants']
    ]
    m_copy = dict(m)
    m_copy['participants'] = semantic_participants
    g.set('semanticModel', json.dumps(m_copy, ensure_ascii=False, separators=(',', ':')))
    g.set('pageHeight', str(end + 100))
    g.set('pageWidth', str(width + 100))
    return p

def create_svg_figure(diagram_elem):
    page_id = diagram_elem.attrib['id']
    title = diagram_elem.attrib['name']
    mx = diagram_elem.find('mxGraphModel')
    page_width = int(mx.attrib.get('pageWidth', '2000'))
    page_height = int(mx.attrib.get('pageHeight', '2500'))

    payload = '<mxfile host="app.diagrams.net" type="device">' + ET.tostring(diagram_elem, encoding='unicode') + '</mxfile>'

    svg = ET.Element('svg', xmlns='http://www.w3.org/2000/svg', version='1.1',
                     width=f'{page_width}px', height=f'{page_height}px',
                     viewBox=f'0 0 {page_width} {page_height}',
                     style='background: #ffffff; background-color: #ffffff; color-scheme: light;',
                     content=payload)

    ET.SubElement(svg, 'rect', width='100%', height='100%', fill='#ffffff')
    g = ET.SubElement(svg, 'g')

    # Title
    t = ET.SubElement(g, 'text', x='130', y='50', fill='#202020', style='font-family: Arial; font-size: 24px; font-weight: bold;')
    t.text = title

    # Parse cells in diagram to render SVG shapes
    root = mx.find('root')
    for cell in root.findall('mxCell'):
        cid = cell.attrib.get('id')
        val = cell.attrib.get('value', '').replace('<br>', '\n')
        val = html.unescape(re.sub('<[^<]+?>', ' ', val)).strip()
        geom = cell.find('mxGeometry')
        style = cell.attrib.get('style', '')

        if cell.attrib.get('vertex') == '1' and geom is not None and geom.attrib.get('width'):
            x = int(geom.attrib.get('x', '0'))
            y = int(geom.attrib.get('y', '0'))
            w = int(geom.attrib.get('width', '100'))
            h = int(geom.attrib.get('height', '50'))

            # Avoid duplicate header emission
            if cid in ('flow1', 'title') or val == title or 'fontSize=24' in style:
                continue

            if 'shape=umlFrame' in style:
                cg = ET.SubElement(g, 'g', attrib={'data-cell-id': cid})
                ET.SubElement(cg, 'rect', x=str(x), y=str(y), width=str(w), height=str(h), fill='#ffffff' if 'light-dark' in style else 'none', stroke='#202020', attrib={'stroke-width': '1.4'})
                # Operator tab
                ET.SubElement(cg, 'path', d=f'M {x} {y} L {x+70} {y} L {x+70} {y+18} L {x+60} {y+28} L {x} {y+28} Z', fill='#ffffff', stroke='#202020', attrib={'stroke-width': '1'})
                tab_text = ET.SubElement(cg, 'text', x=str(x+10), y=str(y+18), fill='#202020', style='font-family: Arial; font-size: 13px; font-weight: bold;')
                tab_text.text = cell.attrib.get('interactionOperator', 'ref')
            elif 'rounded=0' in style and 'fillColor=#ffffff' in style:
                # Participant box
                cg = ET.SubElement(g, 'g', attrib={'data-cell-id': cid})
                ET.SubElement(cg, 'rect', x=str(x), y=str(y), width=str(w), height=str(h), fill='#ffffff', stroke='#202020', attrib={'stroke-width': '1.4'})
                pt = ET.SubElement(cg, 'text', x=str(x + w//2), y=str(y + h//2 + 5), fill='#202020', attrib={'text-anchor': 'middle'}, style='font-family: Arial; font-size: 15px; font-weight: bold;')
                pt.text = val
            elif val:
                # Text / guard
                cg = ET.SubElement(g, 'g', attrib={'data-cell-id': cid})
                txt = ET.SubElement(cg, 'text', x=str(x), y=str(y + 20), fill='#202020', style='font-family: Arial; font-size: 14px;')
                txt.text = val

        elif cell.attrib.get('edge') == '1' and geom is not None:
            sp = geom.find('mxPoint[@as="sourcePoint"]')
            tp = geom.find('mxPoint[@as="targetPoint"]')
            if sp is not None and tp is not None:
                x1 = int(float(sp.attrib.get('x', '0')))
                y1 = int(float(sp.attrib.get('y', '0')))
                x2 = int(float(tp.attrib.get('x', '0')))
                y2 = int(float(tp.attrib.get('y', '0')))
                cg = ET.SubElement(g, 'g', attrib={'data-cell-id': cid})

                if 'dashed=1;endArrow=none' in style:
                    # Lifeline stem
                    ET.SubElement(cg, 'path', d=f'M {x1} {y1} L {x2} {y2}', stroke='#202020', attrib={'stroke-width': '1.4', 'stroke-dasharray': '4 4', 'fill': 'none'})
                elif (cell.attrib.get('fromParticipant') == cell.attrib.get('toParticipant')) or 'orthogonalEdgeStyle' in style or (x1 == x2 and y1 != y2):
                    # Self-call orthogonal loop
                    loop_w = 40
                    loop_h = 28 if y1 == y2 else abs(y2 - y1)
                    y_target = y1 + loop_h
                    # Orthogonal loop: start at lifeline, step right, step down, step left back to lifeline
                    ET.SubElement(cg, 'path', d=f'M {x1} {y1} L {x1 + loop_w} {y1} L {x1 + loop_w} {y_target} L {x1} {y_target}',
                                  stroke='#202020', attrib={'stroke-width': '1.4', 'fill': 'none'})
                    # Left-pointing arrowhead at (x1, y_target) returning into the lifeline
                    ET.SubElement(cg, 'path', d=f'M {x1} {y_target} L {x1 + 8} {y_target - 4} L {x1 + 8} {y_target + 4} Z',
                                  fill='#202020', stroke='#202020')
                    # Self-call label placed snugly to the right of the loop (10px margin)
                    if val:
                        lines = [line.strip() for line in val.split('\n') if line.strip()]
                        wrapped_lines = []
                        for line in lines:
                            if len(line) > 34 and ' ' in line:
                                words = line.split(' ')
                                cur = ''
                                for w in words:
                                    if len(cur) + len(w) + 1 > 34:
                                        wrapped_lines.append(cur)
                                        cur = w
                                    else:
                                        cur = (cur + ' ' + w).strip()
                                if cur:
                                    wrapped_lines.append(cur)
                            else:
                                wrapped_lines.append(line)

                        text_x = x1 + loop_w + 10
                        start_y = y1 + 14 - (len(wrapped_lines) - 1) * 8
                        mt = ET.SubElement(cg, 'text', x=str(text_x), y=str(start_y), fill='#202020',
                                           attrib={'text-anchor': 'start'}, style='font-family: Arial; font-size: 13px;')
                        for idx, line in enumerate(wrapped_lines):
                            if idx == 0:
                                mt.text = line
                            else:
                                tspan = ET.SubElement(mt, 'tspan', x=str(text_x), dy='16')
                                tspan.text = line
                else:
                    # Message arrow
                    is_reply = 'dashed=1' in style
                    ET.SubElement(cg, 'path', d=f'M {x1} {y1} L {x2} {y2}', stroke='#202020',
                                  attrib={'stroke-width': '1.4', 'stroke-dasharray': '4 4' if is_reply else 'none', 'fill': 'none'})
                    # Arrow head
                    dx = 1 if x2 >= x1 else -1
                    ET.SubElement(cg, 'path', d=f'M {x2} {y2} L {x2 - dx*8} {y2 - 5} L {x2 - dx*8} {y2 + 5} Z', fill='#202020' if 'endFill=1' in style else '#ffffff', stroke='#202020')
                    # Message label with multiline tspan support
                    if val:
                        mid_x = (x1 + x2) // 2
                        lines = [line.strip() for line in val.split('\n') if line.strip()]
                        start_y = y1 - 8 - (len(lines) - 1) * 16
                        mt = ET.SubElement(cg, 'text', x=str(mid_x), y=str(start_y), fill='#202020', attrib={'text-anchor': 'middle'}, style='font-family: Arial; font-size: 13px;')
                        for idx, line in enumerate(lines):
                            if idx == 0:
                                mt.text = line
                            else:
                                tspan = ET.SubElement(mt, 'tspan', x=str(mid_x), dy='16')
                                tspan.text = line

    return ET.tostring(svg, encoding='unicode')

MONOLITHIC_TO_REMOVE = {
    '17-auth-register',
    '20-auth-refresh',
    '23-friend-send-accept',
    '24-friendship-removal',
    '27-upload-retry',
    '28-media-processing',
    '29-index-normal',
    '30-index-resume',
    '31-index-commit',
    '32-reel-feed-sequence',
    '34-hls-streaming',
    '35-series-management',
    '36-series-playback',
    '37-sharing-ai-direct',
    '38-sharing-public-link',
    '39-rag-retrieval',
    '40-rag-memory',
    '41-rag-answer',
    '42-observability-sequence',
}

DIAGRAM_ORDER = [
    # Subsystems & Architecture (2)
    '01-microservices-architecture',
    '02-application-architecture',

    # Data Flow Diagrams (15)
    '03-dfd-context',
    '04-dfd-overview',
    '05-dfd-auth',
    '06-dfd-social',
    '06a-dfd-user-recommendations',
    '07-dfd-content',
    '07a-dfd-sharing',
    '08-dfd-media',
    '08a-dfd-streaming',
    '09-dfd-index',
    '10-dfd-reels',
    '10a-dfd-feedback',
    '10b-dfd-semantic-candidates',
    '11-dfd-rag',
    '11a-dfd-memory',

    # Entity & State Models (5)
    '12-identity-social',
    '13-content',
    '14-semantic-hierarchy',
    '15-index-state',
    '16-ai-conversation',

    # Sequence Diagrams (48)
    '17a-auth-registration-request',
    '17b-auth-email-verification',
    '18-auth-login',
    '19-auth-google',
    '20a-auth-refresh-standard',
    '20b-auth-refresh-deduplication',
    '20c-auth-refresh-recovery-theft',
    '21-auth-authorization',
    '22-auth-logout',
    '23a-friend-send-request',
    '23b-friend-accept-request',
    '24a-friend-reject-request',
    '24b-friend-cancel-request',
    '24c-friend-unfriend',
    '25-friend-block',
    '26-user-recommendation',
    '27a-reel-upload-flow',
    '27b-reel-publish-idempotency',
    '28a-media-playback-readiness',
    '28b-media-evidence-pipeline',
    '29a-index-intake-routing',
    '29b-index-multimodal-extraction',
    '29c-index-vectorization-staging',
    '30a-index-checkpoint-resume',
    '30b-index-stale-fencing',
    '31a-index-atomic-activation',
    '31b-index-rollback-recovery',
    '32a-feed-cache-paging',
    '32b-feed-background-refill',
    '33-cache-invalidation',
    '34a-hls-owner-preview',
    '34b-hls-validated-stream',
    '35a-series-creation-flow',
    '35b-series-reels-ordering',
    '36a-series-playback-entry',
    '36b-series-episode-switch',
    '37a-share-to-ai-assistant',
    '37b-share-to-user-chat',
    '38a-share-link-generation',
    '38b-share-link-resolution',
    '39a-rag-scope-routing',
    '39b-rag-search-rerank',
    '40a-rag-turn-memory-assembly',
    '40b-rag-summary-maintenance',
    '41a-rag-streamed-generation',
    '41b-rag-verification-attribution',
    '42a-observability-trace-capture',
    '42b-observability-trace-analysis',
]

def main():
    print("Parsing velora-architecture.drawio...")
    tree = ET.parse(ARCH_DRAWIO)
    doc_root = tree.getroot()

    # 1. Collect all diagrams by id
    all_diagrams = {p.attrib['id']: p for p in doc_root.findall('diagram')}

    # 2. Build and update split diagrams
    for m in SPLIT_MODELS:
        diag_id = m['id']
        diag_elem = build_diagram_element(m)
        all_diagrams[diag_id] = diag_elem

        # Write standalone importable SVG
        svg_content = create_svg_figure(diag_elem)
        (IMPORTABLE_DIR / f'{diag_id}.drawio.svg').write_text(svg_content)
        print(f"Generated split diagram & SVG: {diag_id}")

    # 3. Remove obsolete monolithic diagrams
    for rem_id in MONOLITHIC_TO_REMOVE:
        if rem_id in all_diagrams:
            del all_diagrams[rem_id]
            print(f"Removed monolithic diagram: {rem_id}")
        rem_svg = IMPORTABLE_DIR / f'{rem_id}.drawio.svg'
        if rem_svg.exists():
            rem_svg.unlink()
            print(f"Deleted obsolete export SVG: {rem_svg.name}")

    # 4. Re-assemble document in clean sorted order
    for child in list(doc_root):
        doc_root.remove(child)

    for diag_id in DIAGRAM_ORDER:
        assert diag_id in all_diagrams, f"Missing diagram {diag_id}"
        doc_root.append(all_diagrams[diag_id])

    print(f"Document reordered: {len(doc_root.findall('diagram'))} diagrams in sequential order.")

    # 5. Write updated document
    doc_text = ET.tostring(doc_root, encoding='unicode')
    ARCH_DRAWIO.write_text(doc_text)

    # 6. Update combined SVG
    combined_svg = COMBINED_SVG.read_text()
    match = re.search(r'<svg\b[^>]*>', combined_svg, re.S)
    opening = re.sub(r'\scontent=\"[^\"]*\"', '', match.group(0))
    opening = opening[:-1] + f' content=\"{html.escape(doc_text, quote=True)}\">'
    COMBINED_SVG.write_text(combined_svg[:match.start()] + opening + combined_svg[match.end():])

    print("Master draw.io and combined SVG updated successfully in exact order!")

if __name__ == '__main__':
    main()
