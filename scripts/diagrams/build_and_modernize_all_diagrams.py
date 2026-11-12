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

def msg(a, b, label, *e, reply=False, sort=None):
    return dict(type='message', **{'from': a, 'to': b}, label=label,
                sort=sort or ('asynchSignal' if 'broker' in (a, b) or 'queue' in (a, b) else 'reply' if reply else 'synchCall'),
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
    dict(id='17a-auth-registration-request', title='17a · New user registration, saga compensation and confirmation email',
         participants=[('mobile', 'Velora-Mobile'), ('gateway', 'API Gateway'), ('auth', 'Auth Service'), ('user', 'User Service'), ('db', 'Auth Database'), ('redis', 'Auth Redis'), ('mail', 'Mail Service')],
         steps=[
             msg('mobile', 'gateway', 'Submit registration details\n(email, username, password)', 'mobile:src/api/auth.api.ts:57-59'),
             msg('gateway', 'auth', 'Forward registration via RabbitMQ RPC (auth.register)', 'backend:apps/api-gateway/src/auth/auth.controller.ts:70-80'),
             frame('alt',
                   ('registration steps succeed', [
                       msg('auth', 'user', 'Create unverified user profile', 'backend:apps/auth-service/src/infrastructure/adapters/user-service.adapter.ts:25-34'),
                       msg('user', 'auth', 'Return created user identity', 'backend:apps/auth-service/src/application/use-cases/register.use-case.ts:27-29', reply=True),
                       msg('auth', 'db', 'Assign default USER role', 'backend:apps/auth-service/src/application/use-cases/register.use-case.ts:27-29', 'backend:apps/auth-service/src/infrastructure/repositories/auth.repository.ts:35-48'),
                       msg('auth', 'redis', 'Store six-digit confirmation code (15-minute TTL)', 'backend:apps/auth-service/src/application/use-cases/register.use-case.ts:31-32', 'backend:apps/auth-service/src/infrastructure/repositories/redis-verification-code.repository.ts:9-10'),
                       msg('auth', 'mail', 'Emit confirmation email request (mail.send)', 'backend:apps/auth-service/src/infrastructure/adapters/mail-service.adapter.ts:13-30', sort='asynchSignal'),
                       msg('auth', 'gateway', 'Return identity and success message', 'backend:apps/auth-service/src/application/use-cases/register.use-case.ts:36-42', reply=True),
                       msg('gateway', 'mobile', 'Deliver registration result', 'backend:apps/api-gateway/src/auth/auth.controller.ts:73-80', reply=True),
                   ]),
                   ('user service rejects a duplicate email or username', [
                       msg('user', 'auth', 'Reject duplicate email or username', 'backend:apps/auth-service/src/application/use-cases/register.use-case.ts:27-30', reply=True),
                       msg('auth', 'gateway', 'Propagate the duplicate-user error', 'backend:apps/auth-service/src/application/use-cases/register.use-case.ts:59-67', reply=True),
                       msg('gateway', 'mobile', 'Return registration error', 'backend:apps/api-gateway/src/auth/auth.controller.ts:73-80', reply=True),
                   ]),
                   ('role, code or mail step fails after the profile exists', [
                       msg('auth', 'user', 'Roll back the created user profile', 'backend:apps/auth-service/src/application/use-cases/register.use-case.ts:49-51'),
                       msg('auth', 'db', 'Roll back assigned roles', 'backend:apps/auth-service/src/application/use-cases/register.use-case.ts:52-55'),
                       msg('auth', 'gateway', 'Reject with saga compensation error', 'backend:apps/auth-service/src/application/use-cases/register.use-case.ts:65-68', reply=True),
                   ]),
             ),
         ]),

    dict(id='17b-auth-email-verification', title='17b · Account confirmation with the emailed code',
         participants=[('mobile', 'Velora-Mobile'), ('gateway', 'API Gateway'), ('auth', 'Auth Service'), ('redis', 'Auth Redis'), ('user', 'User Service')],
         steps=[
             msg('mobile', 'gateway', 'Submit the confirmation code', 'mobile:src/api/auth.api.ts:115-117'),
             msg('gateway', 'auth', 'Forward confirmation via RabbitMQ RPC (auth.confirm_account)', 'backend:apps/api-gateway/src/auth/auth.controller.ts:232-242'),
             msg('auth', 'redis', 'Look up the confirmation code', 'backend:apps/auth-service/src/application/use-cases/confirm-account.use-case.ts:16-17'),
             msg('redis', 'auth', 'Return the user ID, or nothing for an unknown or expired code', 'backend:apps/auth-service/src/infrastructure/repositories/redis-verification-code.repository.ts:13-14', reply=True),
             frame('alt',
                   ('no user ID for the code', [
                       msg('auth', 'gateway', 'Reject: invalid or expired code', 'backend:apps/auth-service/src/infrastructure/controllers/auth.controller.ts:128-140', reply=True),
                       msg('gateway', 'mobile', 'Return invalid-confirmation error', 'backend:apps/api-gateway/src/auth/auth.controller.ts:235-243', reply=True),
                   ]),
                   ('code maps to a user ID', [
                       msg('auth', 'user', 'Mark the user as verified', 'backend:apps/auth-service/src/infrastructure/adapters/user-service.adapter.ts:75-83'),
                       msg('user', 'auth', 'Verification completed', 'backend:apps/auth-service/src/application/use-cases/confirm-account.use-case.ts:23-24', reply=True),
                       msg('auth', 'redis', 'Delete the used code', 'backend:apps/auth-service/src/application/use-cases/confirm-account.use-case.ts:23-24'),
                       msg('auth', 'gateway', 'Return "Account verified successfully"', 'backend:apps/auth-service/src/application/use-cases/confirm-account.use-case.ts:26-26', reply=True),
                       msg('gateway', 'mobile', 'Deliver verification result; the user signs in separately', 'backend:apps/api-gateway/src/auth/auth.controller.ts:235-243', reply=True),
                   ]),
             ),
         ]),

    dict(id='20a-auth-refresh-standard', title='20a · Standard refresh-token rotation',
         participants=[('mobile', 'Velora-Mobile'), ('gateway', 'API Gateway'), ('auth', 'Auth Service'), ('db', 'Auth Database'), ('user', 'User Service'), ('secure', 'Mobile SecureStore')],
         steps=[
             msg('mobile', 'gateway', 'Request token rotation\n(refresh token and stable refreshRequestId)', 'mobile:src/api/client.ts:59-65', 'mobile:src/api/client.ts:89-133'),
             msg('gateway', 'auth', 'Forward refresh via RabbitMQ RPC (auth.refresh)', 'backend:apps/api-gateway/src/auth/auth.controller.ts:141-153'),
             msg('auth', 'auth', 'Verify signature, expiry and token type = refresh', 'backend:apps/auth-service/src/application/use-cases/refresh-token.use-case.ts:43-58'),
             msg('auth', 'db', 'Find the stored token by its hash', 'backend:apps/auth-service/src/infrastructure/repositories/auth.repository.ts:85-106'),
             msg('db', 'auth', 'Return the active stored token', 'backend:apps/auth-service/src/infrastructure/repositories/auth.repository.ts:85-106', reply=True),
             msg('auth', 'user', 'Look up the token owner (user.find_by_id)', 'backend:apps/auth-service/src/application/use-cases/refresh-token.use-case.ts:88-88'),
             msg('user', 'auth', 'Return the user', 'backend:apps/auth-service/src/application/use-cases/refresh-token.use-case.ts:88-88', reply=True),
             msg('auth', 'db', 'Transactional compare-and-swap: revoke the old token, create the replacement\n(rolling 90-day expiry)', 'backend:apps/auth-service/src/infrastructure/repositories/auth.repository.ts:144-216'),
             msg('db', 'auth', 'Replacement token persisted', 'backend:apps/auth-service/src/infrastructure/repositories/auth.repository.ts:188-216', reply=True),
             msg('auth', 'auth', 'Sign a 15-minute access token and the replacement refresh token', 'backend:apps/auth-service/src/application/use-cases/refresh-token.use-case.ts:95-102'),
             msg('auth', 'gateway', 'Return the new token pair', 'backend:apps/auth-service/src/application/use-cases/refresh-token.use-case.ts:160-165', reply=True),
             msg('gateway', 'mobile', 'Deliver the new token pair over HTTP', 'backend:apps/api-gateway/src/auth/auth.controller.ts:150-153', reply=True),
             msg('mobile', 'secure', 'Persist the refresh token, then expose the access token', 'mobile:src/lib/auth/tokenSession.ts:37-46', 'mobile:src/api/client.ts:117-119'),
             note('Rotation complete; the original protected request is replayed once with the new access token', 'mobile:src/api/client.ts:182-184'),
         ]),

    dict(id='20b-auth-refresh-deduplication', title='20b · Concurrent 401s share one refresh request',
         participants=[('caller1', 'Concurrent API call 1'), ('caller2', 'Concurrent API call 2'), ('interceptor', 'Response interceptor'), ('mutex', 'Shared refresh promise'), ('gateway', 'API Gateway')],
         steps=[
             msg('caller1', 'interceptor', 'Protected request returns 401', 'mobile:src/api/client.ts:161-171'),
             msg('caller2', 'interceptor', 'Parallel protected request also returns 401', 'mobile:src/api/client.ts:161-171'),
             msg('interceptor', 'mutex', 'Call refreshAccessToken (first caller creates the promise)', 'mobile:src/api/client.ts:89-97'),
             msg('mutex', 'gateway', 'POST /auth/mobile/refresh with refresh token and refreshRequestId', 'mobile:src/api/client.ts:112-116'),
             note('The second caller finds the promise already set and awaits it instead of sending another refresh', 'mobile:src/api/client.ts:94-96'),
             msg('gateway', 'mutex', 'Return the rotated token pair', 'backend:apps/api-gateway/src/auth/auth.controller.ts:150-153', reply=True),
             msg('mutex', 'mutex', 'Install the pair, then clear the promise in finally', 'mobile:src/api/client.ts:133-135'),
             msg('mutex', 'interceptor', 'Resolve the shared promise with the new session', 'mobile:src/api/client.ts:137-138', reply=True),
             msg('interceptor', 'caller1', 'Replay the first request once (_retry set)', 'mobile:src/api/client.ts:168-171'),
             msg('interceptor', 'caller2', 'Replay the second request once (_retry set)', 'mobile:src/api/client.ts:182-184'),
         ]),

    dict(id='20c-auth-refresh-recovery-theft', title='20c · Lost-response recovery and refresh replay protection',
         participants=[('mobile', 'Velora-Mobile'), ('gateway', 'API Gateway'), ('auth', 'Auth Service'), ('db', 'Auth Database'), ('user', 'User Service')],
         steps=[
             frame('alt',
                   ('retry after a lost response (same refreshRequestId inside the retry window)', [
                       msg('mobile', 'gateway', 'Retry refresh with the previous token and the same refreshRequestId', 'mobile:src/api/client.ts:59-65'),
                       msg('gateway', 'auth', 'Forward refresh via RabbitMQ RPC', 'backend:apps/api-gateway/src/auth/auth.controller.ts:141-153'),
                       msg('auth', 'db', 'Look up the revoked token and recover the rotation by request ID', 'backend:apps/auth-service/src/application/use-cases/refresh-token.use-case.ts:76-80'),
                       msg('db', 'auth', 'Recover only when the ID matches, the window is open and the replacement is unrevoked, unexpired and encrypted', 'backend:apps/auth-service/src/infrastructure/repositories/auth.repository.ts:117-141', reply=True),
                       msg('auth', 'user', 'Look up the token owner', 'backend:apps/auth-service/src/application/use-cases/refresh-token.use-case.ts:88-88'),
                       msg('auth', 'auth', 'Issue a fresh access token and reuse the recovered refresh token', 'backend:apps/auth-service/src/application/use-cases/refresh-token.use-case.ts:95-102'),
                       msg('auth', 'gateway', 'Return the recovered replacement pair', 'backend:apps/auth-service/src/application/use-cases/refresh-token.use-case.ts:100-102', reply=True),
                       msg('gateway', 'mobile', 'Deliver the replacement pair', 'backend:apps/api-gateway/src/auth/auth.controller.ts:150-153', reply=True),
                   ]),
                   ('revoked or replayed token outside recovery', [
                       msg('mobile', 'gateway', 'Refresh with a revoked, expired or already-rotated token', 'mobile:src/api/client.ts:59-65'),
                       msg('gateway', 'auth', 'Forward refresh via RabbitMQ RPC', 'backend:apps/api-gateway/src/auth/auth.controller.ts:141-153'),
                       msg('auth', 'db', 'Find the stored token by hash', 'backend:apps/auth-service/src/infrastructure/repositories/auth.repository.ts:85-106'),
                       msg('db', 'auth', 'Token is revoked and no recovery matches', 'backend:apps/auth-service/src/infrastructure/repositories/auth.repository.ts:85-106', reply=True),
                       msg('auth', 'db', 'Revoke all tokens of the verified user', 'backend:apps/auth-service/src/application/use-cases/refresh-token.use-case.ts:63-66', 'backend:apps/auth-service/src/infrastructure/repositories/auth.repository.ts:231-235'),
                       msg('auth', 'gateway', 'Reject with InvalidTokenError', 'backend:apps/auth-service/src/application/use-cases/refresh-token.use-case.ts:63-66', reply=True),
                       msg('gateway', 'mobile', 'Map the RPC rejection to an HTTP auth error', 'backend:apps/api-gateway/src/auth/auth.controller.ts:150-153', reply=True),
                       msg('mobile', 'mobile', 'On 401 or 403 clear the local token session and sign out', 'mobile:src/api/client.ts:70-80', 'mobile:src/lib/auth/tokenSession.ts:49-52'),
                   ]),
             ),
         ]),

    dict(id='23a-friend-send-request', title='23a · Send a friend request',
         participants=[('sender', 'Velora-Mobile (A)'), ('gateway', 'API Gateway'), ('friend', 'Friend Service'), ('db', 'Friend Database')],
         steps=[
             msg('sender', 'gateway', 'POST /friends/requests {recipientId: B}', 'mobile:src/api/friend.api.ts:45-49'),
             msg('gateway', 'friend', 'Forward friend.send_request {userId: A, recipientId: B}', 'backend:apps/api-gateway/src/friends/friend.controller.ts:50-65'),
             msg('friend', 'friend', 'Reject a request to yourself', 'backend:apps/friend-service/src/application/use-cases/send-friend-request.use-case.ts:24-40'),
             msg('friend', 'db', 'Create or find the pending request on the canonical sorted pair\n(unique-conflict recovery)', 'backend:apps/friend-service/src/application/use-cases/send-friend-request.use-case.ts:45-59', 'backend:apps/friend-service/src/infrastructure/repositories/friend.repository.ts:304-344'),
             frame('alt',
                   ('new request created', [
                       msg('db', 'friend', 'Created request and friendship row', 'backend:apps/friend-service/src/infrastructure/repositories/friend.repository.ts:319-337', reply=True),
                       msg('friend', 'gateway', 'Return request_sent with the new request ID', 'backend:apps/friend-service/src/application/use-cases/send-friend-request.use-case.ts:61-66', reply=True),
                       msg('gateway', 'sender', 'Deliver request_sent over HTTP', 'backend:apps/api-gateway/src/friends/friend.controller.ts:58-65', reply=True),
                   ]),
                   ('a relationship already exists (for example ACCEPTED means friends)', [
                       msg('friend', 'gateway', 'Return the existing relationship result', 'backend:apps/friend-service/src/application/use-cases/send-friend-request.use-case.ts:69-89', reply=True),
                       msg('gateway', 'sender', 'Deliver the existing relationship status', 'backend:apps/api-gateway/src/friends/friend.controller.ts:58-65', reply=True),
                   ]),
             ),
             msg('sender', 'sender', "Reconcile A's status, exclude connected users from recommendations and invalidate lists", 'mobile:src/hooks/useFriendMutations.ts:136-159'),
         ]),

    dict(id='23b-friend-accept-request', title='23b · Accept a friend request',
         participants=[('recipient', 'Velora-Mobile (B)'), ('gateway', 'API Gateway'), ('friend', 'Friend Service'), ('db', 'Friend Database'), ('conv', 'Conversation Service')],
         steps=[
             msg('recipient', 'gateway', 'POST /friends/requests/:requestId/accept', 'mobile:src/api/friend.api.ts:51-55'),
             msg('gateway', 'friend', 'Forward friend.accept_request {userId: B, requestId}', 'backend:apps/api-gateway/src/friends/friend.controller.ts:69-84'),
             msg('friend', 'db', 'Load the request by ID', 'backend:apps/friend-service/src/application/use-cases/accept-friend-request.use-case.ts:26-26'),
             frame('alt',
                   ('request missing or B is not the recipient', [
                       msg('friend', 'gateway', 'Reject with 404 (missing) or 403 (wrong recipient)', 'backend:apps/friend-service/src/application/use-cases/accept-friend-request.use-case.ts:28-35', reply=True),
                       msg('gateway', 'recipient', 'Deliver the acceptance rejection', 'backend:apps/api-gateway/src/friends/friend.controller.ts:78-84', reply=True),
                   ]),
                   ('B is the recipient', [
                       msg('friend', 'db', 'Check blocks in both directions (403 when blocked)', 'backend:apps/friend-service/src/application/use-cases/accept-friend-request.use-case.ts:40-46'),
                       msg('friend', 'db', 'Accept the pending request in a guarded transaction', 'backend:apps/friend-service/src/application/use-cases/accept-friend-request.use-case.ts:51-55', 'backend:apps/friend-service/src/infrastructure/repositories/friend.repository.ts:51-116'),
                       msg('db', 'friend', 'accepted, already_accepted, forbidden, not_found or not_pending', 'backend:apps/friend-service/src/infrastructure/repositories/friend.repository.ts:69-115', reply=True),
                       msg('friend', 'conv', 'Create the direct conversation for the new friends', 'backend:apps/friend-service/src/application/use-cases/accept-friend-request.use-case.ts:72-77'),
                       msg('friend', 'gateway', 'Return friends status, request ID and optional conversation ID', 'backend:apps/friend-service/src/application/use-cases/accept-friend-request.use-case.ts:77-85', reply=True),
                       msg('gateway', 'recipient', 'Deliver the friends result to B', 'backend:apps/api-gateway/src/friends/friend.controller.ts:78-84', reply=True),
                       msg('recipient', 'recipient', 'Reconcile incoming, friends, status and discovery caches', 'mobile:src/hooks/useFriendMutations.ts:186-213'),
                   ]),
             ),
         ]),

    dict(id='24a-friend-reject-request', title='24a · Reject a friend request',
         participants=[('mobile', 'Velora-Mobile'), ('gateway', 'API Gateway'), ('friend', 'Friend Service'), ('db', 'Friend Database')],
         steps=[
             note('Mobile applies an optimistic cache change and snapshots state before the HTTP call', 'mobile:src/hooks/useFriendMutations.ts:240-252'),
             msg('mobile', 'gateway', 'POST /friends/requests/:requestId/reject', 'backend:apps/api-gateway/src/friends/friend.controller.ts:89-105'),
             msg('gateway', 'friend', 'Forward friend.reject_request {userId, requestId}', 'backend:apps/api-gateway/src/friends/friend.controller.ts:89-105'),
             msg('friend', 'db', 'Transaction: delete the PENDING request where recipientId = actor', 'backend:apps/friend-service/src/infrastructure/repositories/friend.repository.ts:119-159'),
             msg('db', 'friend', 'deleted, not_found, forbidden or not_pending', 'backend:apps/friend-service/src/infrastructure/repositories/friend.repository.ts:119-159', reply=True),
             frame('alt',
                   ('deleted or already gone', [
                       msg('friend', 'gateway', 'Return status none (removed or already removed)', 'backend:apps/friend-service/src/application/use-cases/reject-friend-request.use-case.ts:23-30', reply=True),
                       msg('gateway', 'mobile', 'Deliver status none', 'backend:apps/api-gateway/src/friends/friend.controller.ts:89-105', reply=True),
                   ]),
                   ('actor is not the recipient', [
                       msg('friend', 'gateway', 'FriendActionForbiddenError', 'backend:apps/friend-service/src/application/use-cases/reject-friend-request.use-case.ts:33-36', reply=True),
                       msg('gateway', 'mobile', 'Return HTTP 403', 'backend:apps/api-gateway/src/friends/friend.controller.ts:89-105', reply=True),
                   ]),
                   ('request is no longer pending', [
                       msg('friend', 'gateway', 'FriendRequestNotFoundError', 'backend:apps/friend-service/src/application/use-cases/reject-friend-request.use-case.ts:39-39', reply=True),
                       msg('gateway', 'mobile', 'Return HTTP 404', 'backend:apps/api-gateway/src/friends/friend.controller.ts:89-105', reply=True),
                   ]),
             ),
         ]),

    dict(id='24b-friend-cancel-request', title='24b · Cancel a sent friend request',
         participants=[('mobile', 'Velora-Mobile'), ('gateway', 'API Gateway'), ('friend', 'Friend Service'), ('db', 'Friend Database')],
         steps=[
             note('Mobile applies an optimistic cache change and snapshots state before the HTTP call', 'mobile:src/hooks/useFriendMutations.ts:296-308'),
             msg('mobile', 'gateway', 'DELETE /friends/requests/:requestId', 'backend:apps/api-gateway/src/friends/friend.controller.ts:183-199'),
             msg('gateway', 'friend', 'Forward friend.cancel_request {userId, requestId}', 'backend:apps/api-gateway/src/friends/friend.controller.ts:183-199'),
             msg('friend', 'db', 'Transaction: delete the PENDING request where requesterId = actor', 'backend:apps/friend-service/src/infrastructure/repositories/friend.repository.ts:162-202'),
             msg('db', 'friend', 'deleted, not_found, forbidden or not_pending', 'backend:apps/friend-service/src/infrastructure/repositories/friend.repository.ts:162-202', reply=True),
             frame('alt',
                   ('deleted or already gone', [
                       msg('friend', 'gateway', 'Return status none (removed or already removed)', 'backend:apps/friend-service/src/application/use-cases/cancel-friend-request.use-case.ts:23-30', reply=True),
                       msg('gateway', 'mobile', 'Deliver status none', 'backend:apps/api-gateway/src/friends/friend.controller.ts:183-199', reply=True),
                   ]),
                   ('actor is not the sender', [
                       msg('friend', 'gateway', 'FriendActionForbiddenError', 'backend:apps/friend-service/src/application/use-cases/cancel-friend-request.use-case.ts:33-36', reply=True),
                       msg('gateway', 'mobile', 'Return HTTP 403', 'backend:apps/api-gateway/src/friends/friend.controller.ts:183-199', reply=True),
                   ]),
                   ('request is no longer pending', [
                       msg('friend', 'gateway', 'FriendRequestNotFoundError', 'backend:apps/friend-service/src/application/use-cases/cancel-friend-request.use-case.ts:39-39', reply=True),
                       msg('gateway', 'mobile', 'Return HTTP 404', 'backend:apps/api-gateway/src/friends/friend.controller.ts:183-199', reply=True),
                   ]),
             ),
         ]),

    dict(id='24c-friend-unfriend', title='24c · Remove a friend',
         participants=[('mobile', 'Velora-Mobile'), ('gateway', 'API Gateway'), ('friend', 'Friend Service'), ('db', 'Friend Database')],
         steps=[
             note('Mobile snapshots friends/status state before the HTTP call', 'mobile:src/hooks/useFriendMutations.ts:352-364'),
             msg('mobile', 'gateway', 'DELETE /friends/:userId', 'mobile:src/api/friend.api.ts:69-71'),
             msg('gateway', 'friend', 'Forward friend.remove {userId, friendUserId}', 'backend:apps/api-gateway/src/friends/friend.controller.ts:301-318'),
             frame('alt',
                   ('userId equals friendUserId', [
                       msg('friend', 'gateway', 'CannotFriendSelfError', 'backend:apps/friend-service/src/application/use-cases/remove-friend.use-case.ts:17-18', reply=True),
                       msg('gateway', 'mobile', 'Reject the self action over HTTP', 'backend:apps/api-gateway/src/friends/friend.controller.ts:301-318', reply=True),
                   ]),
                   ('different users', [
                       msg('friend', 'db', 'Delete the ACCEPTED row of the canonical pair', 'backend:apps/friend-service/src/infrastructure/repositories/friend.repository.ts:205-217'),
                       msg('db', 'friend', 'Removed flag', 'backend:apps/friend-service/src/infrastructure/repositories/friend.repository.ts:219-219', reply=True),
                       msg('friend', 'gateway', 'Return status none (removed, or already absent)', 'backend:apps/friend-service/src/application/use-cases/remove-friend.use-case.ts:26-31', reply=True),
                       msg('gateway', 'mobile', 'Deliver the idempotent removal result', 'backend:apps/api-gateway/src/friends/friend.controller.ts:301-318', reply=True),
                   ]),
             ),
         ]),

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

    dict(id='29a-index-intake-routing', title='29a · Indexing attempt claim and route classification',
         participants=[('broker', 'RabbitMQ index queue'), ('index', 'Reel Indexing worker'), ('ckpt', 'Index Postgres (checkpoints)'), ('content', 'Content Service'), ('r2', 'Cloudflare R2')],
         steps=[
             msg('broker', 'index', 'Deliver the versioned reel.index.process job', 'backend:apps/reel-indexing-service/src/infrastructure/controllers/reel-indexing.controller.ts:22-67', 'backend:libs/common/src/processing/interfaces/reel-index-job.interface.ts:31-31', sort='asynchSignal'),
             msg('index', 'ckpt', 'Read the checkpoint of this index attempt', 'backend:apps/reel-indexing-service/src/infrastructure/workflows/reel-index-langgraph.workflow.ts:492-505'),
             frame('alt',
                   ('the attempt is already COMPLETED', [
                       msg('index', 'index', 'Return DUPLICATE and skip the pipeline', 'backend:apps/reel-indexing-service/src/infrastructure/workflows/reel-index-langgraph.workflow.ts:495-495'),
                   ]),
                   ('not completed yet', [
                       msg('index', 'content', 'Claim the attempt (content.claim_reel_indexing_attempt)', 'backend:apps/reel-indexing-service/src/infrastructure/adapters/content-service.adapter.ts:14-24'),
                       msg('content', 'index', 'claimed: true or false', 'backend:apps/reel-indexing-service/src/infrastructure/workflows/reel-index-langgraph.workflow.ts:497-501', reply=True),
                       frame('alt',
                             ('claim refused (a newer attempt or media attempt owns the Reel)', [
                                 msg('index', 'index', 'Return STALE and skip the pipeline', 'backend:apps/reel-indexing-service/src/infrastructure/workflows/reel-index-langgraph.workflow.ts:492-505'),
                             ]),
                             ('claim granted', [
                                 msg('index', 'ckpt', 'Start or resume the attempt checkpoint', 'backend:apps/reel-indexing-service/src/infrastructure/workflows/reel-index-langgraph.workflow.ts:492-505'),
                                 frame('opt',
                                       ('the job does not say whether the source has audio', [
                                           msg('index', 'r2', 'Read the audio manifest only to infer the missing hasAudio flag', 'backend:apps/reel-indexing-service/src/infrastructure/workflows/reel-index-langgraph.workflow.ts:515-517'),
                                       ]),
                                 ),
                                 msg('index', 'index', 'Classify the route: NO_AUDIO, SHORT or LONG', 'backend:apps/reel-indexing-service/src/infrastructure/workflows/reel-index-langgraph.workflow.ts:507-532'),
                             ]),
                       ),
                   ]),
             ),
         ]),

    dict(id='29b-index-multimodal-extraction', title='29b · Keyframe analysis, transcription and metadata extraction',
         participants=[('worker', 'Reel Indexing worker'), ('r2', 'Cloudflare R2'), ('ai', 'AI Service'), ('ckpt', 'Index Postgres (checkpoints)')],
         steps=[
             frame('opt',
                   ('visual analysis enabled and a matching visual frame manifest exists', [
                       frame('loop',
                             ('each sampled keyframe (bounded concurrency, default 2)', [
                                 msg('worker', 'r2', 'Download the frame and verify its SHA-256', 'backend:apps/reel-indexing-service/src/application/use-cases/analyze-visual-frame-manifest.use-case.ts:19-107', 'backend:apps/reel-indexing-service/src/infrastructure/adapters/r2-artifact-storage.adapter.ts:68-78'),
                                 msg('worker', 'ai', 'Analyze the frame (ai.analyze_visual_frame)', 'backend:apps/reel-indexing-service/src/infrastructure/adapters/ai-service.adapter.ts:47-61'),
                                 msg('ai', 'worker', 'Return caption, OCR text, objects and provenance', 'backend:apps/reel-indexing-service/src/application/use-cases/analyze-visual-frame-manifest.use-case.ts:65-69', reply=True),
                             ]),
                       ),
                       note('If the visual provider reports its daily allocation exhausted, an optional analysis is skipped and the Reel is indexed without visual scenes (retried by 29d); a required analysis fails and retries later', 'backend:apps/reel-indexing-service/src/application/use-cases/analyze-visual-frame-manifest.use-case.ts:109-115'),
                   ]),
             ),
             msg('worker', 'worker', 'Mark the visual branch ready (success or optional skip)', 'backend:apps/reel-indexing-service/src/infrastructure/workflows/reel-index-langgraph.workflow.ts:534-541'),
             frame('alt',
                   ('route is NO_AUDIO', [
                       msg('worker', 'ckpt', 'Metadata-only index: no sections, transcript marked ready, no ASR', 'backend:apps/reel-indexing-service/src/infrastructure/workflows/reel-index-langgraph.workflow.ts:543-555'),
                   ]),
                   ('route is SHORT or LONG', [
                       frame('loop',
                             ('each audio segment that is not yet COMPLETED (concurrency default 2)', [
                                 msg('worker', 'ai', 'Transcribe the audio segment (transcribeAudioKey)', 'backend:apps/reel-indexing-service/src/application/use-cases/transcribe-audio-manifest.use-case.ts:76-126'),
                                 msg('ai', 'worker', 'Return transcript with provider, model and version', 'backend:apps/reel-indexing-service/src/application/use-cases/transcribe-audio-manifest.use-case.ts:98-101', reply=True),
                                 msg('worker', 'ckpt', 'Persist the segment as COMPLETED', 'backend:apps/reel-indexing-service/src/application/use-cases/transcribe-audio-manifest.use-case.ts:76-126'),
                             ]),
                       ),
                       msg('worker', 'ckpt', 'Merge segments into one transcript with hash and merge version', 'backend:apps/reel-indexing-service/src/infrastructure/workflows/reel-index-langgraph.workflow.ts:560-560'),
                   ]),
             ),
             msg('worker', 'ckpt', 'Keep strong creator metadata locally', 'backend:apps/reel-indexing-service/src/infrastructure/workflows/reel-index-langgraph.workflow.ts:648-664'),
             msg('worker', 'ai', 'Extract summary, keywords and topics (ai.extract_reel_metadata)', 'backend:apps/reel-indexing-service/src/application/use-cases/extract-hierarchical-metadata.use-case.ts:13-82', 'backend:apps/reel-indexing-service/src/infrastructure/adapters/ai-service.adapter.ts:63-78'),
             msg('ai', 'worker', 'Return metadata; creator-authored fields stay authoritative', 'backend:apps/reel-indexing-service/src/application/use-cases/extract-hierarchical-metadata.use-case.ts:100-118', reply=True),
             msg('worker', 'ckpt', 'Save extracted metadata and sections', 'backend:apps/reel-indexing-service/src/infrastructure/workflows/reel-index-langgraph.workflow.ts:666-690'),
         ]),

    dict(id='29c-index-vectorization-staging', title='29c · Token gating, embedding generation and candidate staging',
         participants=[('worker', 'Reel Indexing worker'), ('ai', 'AI Service (TEI embeddings)'), ('ckpt', 'Index Postgres (checkpoints)'), ('r2', 'Cloudflare R2 staging'), ('sql', 'Index Postgres (candidate)')],
         steps=[
             msg('worker', 'worker', 'Segment the evidence into hierarchical document, section, chunk and scene drafts', 'backend:apps/reel-indexing-service/src/application/use-cases/build-hierarchical-index.use-case.ts:40-60'),
             frame('loop',
                   ('up to 3 token-gate attempts while oversized drafts remain (batches of 100)', [
                       msg('worker', 'ai', 'Count document tokens (ai.count_document_tokens)', 'backend:apps/reel-indexing-service/src/application/use-cases/build-hierarchical-index.use-case.ts:256-256', 'backend:apps/reel-indexing-service/src/infrastructure/adapters/ai-service.adapter.ts:123-131'),
                       msg('ai', 'worker', 'Return exact token counts', 'backend:apps/reel-indexing-service/src/infrastructure/adapters/ai-service.adapter.ts:123-131', reply=True),
                       msg('worker', 'ckpt', 'Persist token-validated or re-versioned drafts', 'backend:apps/reel-indexing-service/src/infrastructure/workflows/reel-index-langgraph.workflow.ts:807-818'),
                   ]),
             ),
             msg('worker', 'ckpt', 'Find reusable embeddings by full content and model identity', 'backend:apps/reel-indexing-service/src/application/use-cases/build-hierarchical-index.use-case.ts:310-378'),
             msg('worker', 'ai', 'Embed the missing drafts in configured batches (ai.generate_embedding_batch, 1024-dim bge-m3)', 'backend:apps/reel-indexing-service/src/application/use-cases/build-hierarchical-index.use-case.ts:256-256', 'backend:apps/reel-indexing-service/src/infrastructure/adapters/ai-service.adapter.ts:110-121'),
             msg('ai', 'worker', 'Return vectors, model identity and per-item errors', 'backend:apps/reel-indexing-service/src/application/use-cases/build-hierarchical-index.use-case.ts:334-334', reply=True),
             msg('worker', 'r2', 'Save valid reusable embeddings in R2 staging', 'backend:apps/reel-indexing-service/src/application/use-cases/build-hierarchical-index.use-case.ts:310-378'),
             msg('worker', 'sql', 'Stage the vector bundle to R2 and persist the SQL candidate and journal', 'backend:apps/reel-indexing-service/src/infrastructure/repositories/prisma-semantic-index.repository.ts:115-185'),
             note('The candidate is staged but not active; 31a activates it and projects its vectors to Qdrant', 'backend:apps/reel-indexing-service/src/infrastructure/repositories/prisma-semantic-index.repository.ts:115-185'),
         ]),

    dict(id='29d-index-deferred-visual-retry', title='29d · Daily retry for Reels indexed without visual scenes',
         participants=[('sched', 'Deferred visual retry worker'), ('db', 'Index Postgres'), ('content', 'Content Service'), ('pipe', 'Reel indexing pipeline')],
         steps=[
             note('Runs once a day shortly after 00:00 UTC (default start minute 15), when the visual provider allocation resets', 'backend:apps/reel-indexing-service/src/infrastructure/services/deferred-visual-retry-worker.service.ts:53-77'),
             frame('loop',
                   ('until a stop condition: limit (4 Reels), none left, quota spent, two consecutive failures or timeout', [
                       msg('sched', 'db', 'Find the next active Reel without visual scenes (skip Reels with 3 attempts in 7 days)', 'backend:apps/reel-indexing-service/src/infrastructure/repositories/prisma-deferred-visual-analysis.repository.ts:12-57'),
                       msg('db', 'sched', 'Return one Reel ID, or none', 'backend:apps/reel-indexing-service/src/infrastructure/repositories/prisma-deferred-visual-analysis.repository.ts:51-57', reply=True),
                       msg('sched', 'content', 'Queue a re-index with visual analysis required (content.reindex_reel)', 'backend:apps/reel-indexing-service/src/infrastructure/adapters/content-service.adapter.ts:73-95'),
                       msg('content', 'sched', 'queued flag and new indexAttemptId', 'backend:apps/reel-indexing-service/src/infrastructure/adapters/content-service.adapter.ts:73-95', reply=True),
                       msg('content', 'pipe', 'Publish the indexing job (same pipeline as 29a to 31a)', 'backend:apps/reel-indexing-service/src/infrastructure/controllers/reel-indexing.controller.ts:22-67', 'backend:libs/common/src/processing/interfaces/reel-index-job.interface.ts:31-31', sort='asynchSignal'),
                       msg('sched', 'db', 'Poll the attempt status every 15 seconds until it is terminal', 'backend:apps/reel-indexing-service/src/application/use-cases/retry-deferred-visual-analysis.use-case.ts:111-125'),
                       frame('alt',
                             ('attempt did not FAIL', [
                                 msg('sched', 'sched', 'Count the Reel as completed and continue', 'backend:apps/reel-indexing-service/src/application/use-cases/retry-deferred-visual-analysis.use-case.ts:92-96'),
                             ]),
                             ('attempt FAILED because the provider quota is spent', [
                                 msg('sched', 'sched', 'Stop for the day; the next run continues from the same list', 'backend:apps/reel-indexing-service/src/application/use-cases/retry-deferred-visual-analysis.use-case.ts:97-103'),
                             ]),
                       ),
                   ]),
             ),
             note('A required visual analysis that fails leaves the current index untouched, so a failed retry never removes existing evidence', 'backend:apps/reel-indexing-service/src/application/use-cases/retry-deferred-visual-analysis.use-case.ts:33-38'),
         ]),

    dict(id='30a-index-checkpoint-resume', title='30a · Same-attempt resume without repeating finished work',
         participants=[('rmq', 'RabbitMQ index queue'), ('index', 'Reel Indexing worker'), ('db', 'Index Postgres (checkpoints)'), ('storage', 'Cloudflare R2'), ('ai', 'AI Service')],
         steps=[
             msg('rmq', 'index', 'Deliver the job with its redelivered flag and retry header', 'backend:apps/reel-indexing-service/src/infrastructure/controllers/reel-indexing.controller.ts:22-67', sort='asynchSignal'),
             frame('alt',
                   ('malformed job', [
                       msg('index', 'rmq', 'nack(requeue=false) sends it to the dead-letter queue; nothing runs', 'backend:apps/reel-indexing-service/src/infrastructure/controllers/reel-indexing.controller.ts:22-67', sort='asynchSignal'),
                   ]),
                   ('valid job', [
                       msg('index', 'db', 'Load the domain checkpoint by indexAttemptId', 'backend:apps/reel-indexing-service/src/infrastructure/workflows/reel-index-langgraph.workflow.ts:492-505'),
                       msg('index', 'db', 'Claim again with allowReclaim = redelivered or existing checkpoint; start or resume the same attempt', 'backend:apps/reel-indexing-service/src/infrastructure/workflows/reel-index-langgraph.workflow.ts:497-501', 'backend:apps/reel-indexing-service/src/infrastructure/adapters/content-service.adapter.ts:14-24', 'backend:apps/reel-indexing-service/src/infrastructure/workflows/reel-index-langgraph.workflow.ts:492-505'),
                       frame('alt',
                             ('route is NO_AUDIO', [
                                 msg('index', 'db', 'Metadata-only stage: transcript marked ready, no ASR segments', 'backend:apps/reel-indexing-service/src/infrastructure/workflows/reel-index-langgraph.workflow.ts:543-555'),
                             ]),
                             ('route is SHORT and a merged transcript already exists', [
                                 msg('index', 'db', 'Load mergedTranscript and mergedSegments', 'backend:apps/reel-indexing-service/src/infrastructure/workflows/reel-index-langgraph.workflow.ts:557-579'),
                                 msg('index', 'index', 'Reuse the merged transcript and skip ASR entirely', 'backend:apps/reel-indexing-service/src/infrastructure/workflows/reel-index-langgraph.workflow.ts:560-560'),
                             ]),
                             ('route is LONG', [
                                 msg('index', 'storage', 'Read the audio manifest and validate Reel and media-attempt identity', 'backend:apps/reel-indexing-service/src/application/use-cases/transcribe-audio-manifest.use-case.ts:22-60'),
                                 msg('index', 'db', 'Create missing segment rows; compare the stored transcription identity', 'backend:apps/reel-indexing-service/src/infrastructure/repositories/prisma-index-checkpoint.repository.ts:119-160'),
                                 msg('index', 'db', 'Reset affected segments to PENDING when the identity changed', 'backend:apps/reel-indexing-service/src/infrastructure/repositories/prisma-index-checkpoint.repository.ts:119-160'),
                                 msg('index', 'db', 'Read segments and select those not COMPLETED', 'backend:apps/reel-indexing-service/src/application/use-cases/transcribe-audio-manifest.use-case.ts:22-60'),
                                 frame('loop',
                                       ('each pending segment (concurrency default 2) while attempts remain', [
                                           msg('index', 'ai', 'Transcribe the segment (transcribeAudioKey)', 'backend:apps/reel-indexing-service/src/application/use-cases/transcribe-audio-manifest.use-case.ts:76-126'),
                                           msg('ai', 'index', 'Return transcript and provider, model, version', 'backend:apps/reel-indexing-service/src/application/use-cases/transcribe-audio-manifest.use-case.ts:98-101', reply=True),
                                           msg('index', 'db', 'Persist the segment as COMPLETED', 'backend:apps/reel-indexing-service/src/application/use-cases/transcribe-audio-manifest.use-case.ts:76-126'),
                                       ]),
                                 ),
                                 msg('index', 'db', 'Merge the segments and persist the transcript hash and merge version', 'backend:apps/reel-indexing-service/src/infrastructure/workflows/reel-index-langgraph.workflow.ts:560-560'),
                             ]),
                       ),
                   ]),
             ),
             note('Completed segments and merged transcripts are reused, so a redelivered job continues instead of restarting', 'backend:apps/reel-indexing-service/src/infrastructure/workflows/reel-index-langgraph.workflow.ts:560-560'),
         ]),

    dict(id='30b-index-failure-retry-dlq', title='30b · Job outcome handling: acknowledge, retry or dead-letter',
         participants=[('rmq', 'RabbitMQ index queue'), ('index', 'Reel Indexing worker')],
         steps=[
             frame('alt',
                   ('COMPLETED, DUPLICATE or STALE', [
                       msg('index', 'rmq', 'ACK the original message', 'backend:apps/reel-indexing-service/src/infrastructure/controllers/reel-indexing.controller.ts:22-67', sort='asynchSignal'),
                   ]),
                   ('RETRY with a next retry number', [
                       msg('index', 'rmq', 'Publish a persistent retry packet and await the publisher confirmation', 'backend:apps/reel-indexing-service/src/infrastructure/adapters/reel-index-retry-publisher.adapter.ts:54-73', sort='asynchSignal'),
                       frame('alt',
                             ('the publisher promise resolves', [
                                 msg('index', 'rmq', 'ACK the original message', 'backend:apps/reel-indexing-service/src/infrastructure/controllers/reel-indexing.controller.ts:22-67', sort='asynchSignal'),
                             ]),
                             ('the publisher throws', [
                                 msg('index', 'rmq', 'nack(requeue=true) so the message is redelivered', 'backend:apps/reel-indexing-service/src/infrastructure/controllers/reel-indexing.controller.ts:60-60', sort='asynchSignal'),
                             ]),
                       ),
                   ]),
                   ('PERMANENT_FAILURE or retries exhausted', [
                       msg('index', 'rmq', 'nack(requeue=false) sends the message to the dead-letter queue', 'backend:apps/reel-indexing-service/src/infrastructure/controllers/reel-indexing.controller.ts:22-67', sort='asynchSignal'),
                   ]),
                   ('processing throws before durable handling', [
                       msg('index', 'rmq', 'nack(requeue=true) so the message is redelivered', 'backend:apps/reel-indexing-service/src/infrastructure/controllers/reel-indexing.controller.ts:60-60', sort='asynchSignal'),
                   ]),
             ),
             note('A visual-provider quota failure is not retried inside the attempt; it is left for the daily deferred retry in 29d', 'backend:apps/reel-indexing-service/src/application/use-cases/process-reel-index-job.use-case.ts:22-28'),
         ]),

    dict(id='31a-index-atomic-activation', title='31a · Candidate activation, Qdrant projection and completion',
         participants=[('worker', 'Reel Indexing worker'), ('db', 'Index Postgres'), ('proj', 'Vector projection worker'), ('qdrant', 'Qdrant'), ('content', 'Content Service'), ('r2', 'Cloudflare R2 staging')],
         steps=[
             msg('worker', 'db', 'Look up the candidate projection under a per-Reel lock (publication defer)', 'backend:apps/reel-indexing-service/src/infrastructure/repositories/prisma-vector-projection.repository.ts:558-608'),
             frame('alt',
                   ('Qdrant publication is required and the projection is not ready yet', [
                       msg('worker', 'worker', 'Raise ProjectionPendingError; the job waits on a durable continuation', 'backend:apps/reel-indexing-service/src/application/use-cases/commit-semantic-candidate.use-case.ts:52-54'),
                       msg('proj', 'db', 'Claim a projection task (worker ticks every second)', 'backend:apps/reel-indexing-service/src/infrastructure/repositories/prisma-vector-projection.repository.ts:809-839'),
                       msg('proj', 'qdrant', 'Upsert candidate points in batches of 128, then verify them', 'backend:apps/reel-indexing-service/src/infrastructure/repositories/prisma-vector-projection.repository.ts:899-902'),
                       msg('proj', 'db', 'Certify readiness under the per-Reel lock; failed tasks retry with capped exponential backoff', 'backend:apps/reel-indexing-service/src/infrastructure/repositories/prisma-vector-projection.repository.ts:954-960'),
                       msg('proj', 'proj', 'Claim the continuation and re-run the semantic commit with its publication token', 'backend:apps/reel-indexing-service/src/infrastructure/services/vector-projection-worker.service.ts:48-58'),
                   ]),
                   ('the projection is ready or projection is not required', [
                       note('Continue directly to activation', 'backend:apps/reel-indexing-service/src/application/use-cases/commit-semantic-candidate.use-case.ts:53-57'),
                   ]),
             ),
             msg('worker', 'content', 'Ask whether this attempt is still the current one (content.is_reel_indexing_attempt_current)', 'backend:apps/reel-indexing-service/src/application/use-cases/commit-semantic-candidate.use-case.ts:29-29', 'backend:apps/reel-indexing-service/src/infrastructure/adapters/content-service.adapter.ts:26-35'),
             msg('content', 'worker', 'current: true or false', 'backend:apps/reel-indexing-service/src/application/use-cases/commit-semantic-candidate.use-case.ts:29-29', reply=True),
             frame('alt',
                   ('the attempt is no longer current', [
                       msg('worker', 'db', 'Discard the inactive candidate', 'backend:apps/reel-indexing-service/src/application/use-cases/commit-semantic-candidate.use-case.ts:20-73'),
                       msg('worker', 'worker', 'Return STALE', 'backend:apps/reel-indexing-service/src/application/use-cases/commit-semantic-candidate.use-case.ts:20-73'),
                   ]),
                   ('the attempt is current', [
                       msg('worker', 'db', 'Activate the candidate under the per-Reel lock: deactivate the previous rows, activate its own', 'backend:apps/reel-indexing-service/src/infrastructure/repositories/prisma-semantic-candidate-lifecycle.ts:13-69'),
                       msg('db', 'worker', 'Return the previous index attempt ID', 'backend:apps/reel-indexing-service/src/infrastructure/repositories/prisma-semantic-candidate-lifecycle.ts:13-69', reply=True),
                       msg('worker', 'content', 'Await content.persist_reel_index_completed; acceptance closes the media-attempt lease', 'backend:apps/reel-indexing-service/src/application/use-cases/commit-semantic-candidate.use-case.ts:20-73', 'backend:apps/reel-indexing-service/src/infrastructure/adapters/content-service.adapter.ts:50-59'),
                       msg('content', 'worker', 'applied: true when Content accepted the attempt', 'backend:apps/reel-indexing-service/src/application/use-cases/commit-semantic-candidate.use-case.ts:38-38', reply=True),
                       msg('worker', 'db', 'Finalize under the lock: delete obsolete rows and verify Qdrant points', 'backend:apps/reel-indexing-service/src/application/use-cases/commit-semantic-candidate.use-case.ts:120-150', 'backend:infra/qdrant/README.md:1-75'),
                       msg('worker', 'r2', 'Purge the staged vector bundle, then mark the publication complete', 'backend:apps/reel-indexing-service/src/application/use-cases/commit-semantic-candidate.use-case.ts:120-150', 'backend:infra/qdrant/README.md:1-75'),
                       msg('worker', 'worker', 'Return COMPLETED (cleanup failures only log a warning)', 'backend:apps/reel-indexing-service/src/application/use-cases/commit-semantic-candidate.use-case.ts:20-73'),
                   ]),
             ),
         ]),

    dict(id='31b-index-rollback-recovery', title='31b · Rejected or failed activation: rollback and stale outcome',
         participants=[('worker', 'Reel Indexing worker'), ('content', 'Content Service'), ('db', 'Index Postgres')],
         steps=[
             frame('alt',
                   ('Content rejects the completion (applied: false)', [
                       msg('content', 'worker', 'applied: false', 'backend:apps/reel-indexing-service/src/application/use-cases/commit-semantic-candidate.use-case.ts:38-38', reply=True),
                       msg('worker', 'db', 'Roll back the candidate: transaction with the per-Reel lock; count own active rows', 'backend:apps/reel-indexing-service/src/infrastructure/repositories/prisma-semantic-candidate-lifecycle.ts:71-131'),
                       frame('alt',
                             ('this candidate still owns the active rows and a previous attempt exists', [
                                 msg('worker', 'db', 'Deactivate the candidate', 'backend:apps/reel-indexing-service/src/infrastructure/repositories/prisma-semantic-candidate-lifecycle.ts:71-131'),
                                 msg('worker', 'db', 'Restore the previous document, sections, chunks and scenes (document count must be 1)', 'backend:apps/reel-indexing-service/src/infrastructure/repositories/prisma-semantic-candidate-lifecycle.ts:71-131'),
                             ]),
                             ('a newer attempt already replaced it', [
                                 msg('worker', 'worker', 'No-op: preserve the newer active winner', 'backend:apps/reel-indexing-service/src/infrastructure/repositories/prisma-semantic-candidate-lifecycle.ts:71-131'),
                             ]),
                       ),
                       msg('worker', 'db', 'Discard the inactive candidate', 'backend:apps/reel-indexing-service/src/application/use-cases/commit-semantic-candidate.use-case.ts:20-73'),
                       msg('worker', 'worker', 'Return STALE', 'backend:apps/reel-indexing-service/src/application/use-cases/commit-semantic-candidate.use-case.ts:20-73'),
                   ]),
                   ('activation or completion throws', [
                       msg('worker', 'db', 'Best-effort rollback of the candidate (same lock and restore rules)', 'backend:apps/reel-indexing-service/src/infrastructure/repositories/prisma-semantic-candidate-lifecycle.ts:71-131'),
                       msg('worker', 'worker', 'Log a rollback error if the rollback itself fails', 'backend:apps/reel-indexing-service/src/application/use-cases/commit-semantic-candidate.use-case.ts:20-73'),
                       msg('worker', 'worker', 'Re-throw the original error to the workflow, which then retries or dead-letters (30b)', 'backend:apps/reel-indexing-service/src/application/use-cases/commit-semantic-candidate.use-case.ts:20-73'),
                   ]),
             ),
             note('When a Qdrant publication token exists, a failed commit leaves the journal in charge of recovery and raises ProjectionPendingError instead of discarding it', 'backend:apps/reel-indexing-service/src/application/use-cases/commit-semantic-candidate.use-case.ts:102-105'),
         ]),

    dict(id='32a-feed-cache-paging', title='32a · Feed paging from the cached session and first-page slate',
         participants=[('mobile', 'Velora-Mobile'), ('gateway', 'API Gateway'), ('content', 'Content Service'), ('redis', 'Redis (sessions, entities, slate)'), ('db', 'Content Database')],
         steps=[
             msg('mobile', 'gateway', 'GET /content/reels/recommended (cursor, session ID, limit)', 'mobile:src/api/reels.api.ts:50-56'),
             msg('gateway', 'content', 'Forward content.get_recommended_reels (viewer ID and query)', 'backend:apps/api-gateway/src/content/content.controller.ts:479-491'),
             msg('content', 'redis', 'Read the feed session by ID', 'backend:apps/content-service/src/application/use-cases/get-recommended-reels.use-case.ts:106-108'),
             frame('alt',
                   ('a session exists for this viewer and algorithm version', [
                       msg('content', 'redis', 'Load page Reel entities from the entity cache', 'backend:apps/content-service/src/application/use-cases/get-recommended-reels.use-case.ts:489-499'),
                       msg('content', 'db', 'Fetch only the cache-missing Reels that are still eligible', 'backend:apps/content-service/src/application/use-cases/get-recommended-reels.use-case.ts:390-393'),
                       msg('content', 'content', 'Slice the next page from the cursor and count the remaining items', 'backend:apps/content-service/src/application/use-cases/get-recommended-reels.use-case.ts:408-440'),
                       frame('opt',
                             ('authenticated viewer and (audience not loaded, or a next page exists with 10 or fewer items left)', [
                                 note('Start the background refill described in 32b; the response does not wait for it', 'backend:apps/content-service/src/application/use-cases/get-recommended-reels.use-case.ts:151-159'),
                             ]),
                       ),
                   ]),
                   ('no usable session (first page or expired)', [
                       msg('content', 'redis', 'Read the shared global recommendation slate', 'backend:apps/content-service/src/application/use-cases/get-recommended-reels.use-case.ts:166-168'),
                       frame('alt',
                             ('the slate is cached', [
                                 note('Use the slate items; authenticated viewers get the first page size plus 10 items', 'backend:apps/content-service/src/application/use-cases/get-recommended-reels.use-case.ts:179-187'),
                             ]),
                             ('no slate yet', [
                                 msg('content', 'db', 'Build a recent-quality fallback and load its eligible Reels', 'backend:apps/content-service/src/application/use-cases/get-recommended-reels.use-case.ts:369-389'),
                             ]),
                       ),
                       msg('content', 'redis', 'Save the new feed session with its TTL', 'backend:apps/content-service/src/application/use-cases/get-recommended-reels.use-case.ts:145-149'),
                       msg('content', 'content', 'Build the first page; authenticated viewers also start the background refill', 'backend:apps/content-service/src/application/use-cases/get-recommended-reels.use-case.ts:231-237'),
                   ]),
             ),
             frame('opt',
                   ('authenticated viewer, no next cursor yet and the refill is still running', [
                       msg('content', 'redis', 'Poll the session every 100 ms for up to 10 seconds until the refill completes', 'backend:apps/content-service/src/application/use-cases/get-recommended-reels.use-case.ts:566-600'),
                   ]),
             ),
             msg('content', 'gateway', 'Return items with recommendation metadata, next cursor, feed session ID and algorithm version', 'backend:apps/content-service/src/application/use-cases/get-recommended-reels.use-case.ts:315-321', reply=True),
             msg('gateway', 'mobile', 'Deliver the feed page over HTTP', 'backend:apps/api-gateway/src/content/content.controller.ts:462-496', reply=True),
             note('The global slate (100 Reels from recent-quality and trending pools, 10-minute TTL) is built separately by RefreshGlobalRecommendationSlate', 'backend:apps/content-service/src/application/use-cases/refresh-global-recommendation-slate.use-case.ts:15-16'),
         ]),

    dict(id='32b-feed-background-refill', title='32b · Background refill: candidate pools, ranking and optional neural rerank',
         participants=[('content', 'Content Service'), ('redis', 'Redis'), ('friend', 'Friend Service'), ('db', 'Content Database'), ('ai', 'AI Service'), ('index', 'Reel Indexing Service')],
         steps=[
             msg('content', 'redis', 'Acquire the refill lock for the session (60-second TTL)', 'backend:apps/content-service/src/application/use-cases/get-recommended-reels.use-case.ts:549-552'),
             frame('alt',
                   ('another request already holds the lock', [
                       msg('content', 'content', 'Return without refilling', 'backend:apps/content-service/src/application/use-cases/get-recommended-reels.use-case.ts:549-552'),
                   ]),
                   ('lock acquired', [
                       msg('content', 'friend', 'Get the feed audience (excluded and friend user IDs)', 'backend:apps/content-service/src/application/use-cases/get-recommended-reels.use-case.ts:98-98'),
                       msg('friend', 'content', 'Return excluded user IDs and friend IDs', 'backend:apps/content-service/src/application/use-cases/get-recommended-reels.use-case.ts:98-98', reply=True),
                       msg('content', 'redis', 'Read the latest session, then save audience exclusions with refill marked incomplete', 'backend:apps/content-service/src/application/use-cases/get-recommended-reels.use-case.ts:622-622', 'backend:apps/content-service/src/application/use-cases/get-recommended-reels.use-case.ts:122-125'),
                       msg('content', 'db', 'Collect candidates from the enabled pools: recent quality, trending, tag affinity, creator affinity, content similarity, social and exploration', 'backend:apps/content-service/src/application/use-cases/get-recommended-reels.use-case.ts:745-757'),
                       frame('opt',
                             ('the semantic pool is enabled', [
                                 msg('content', 'ai', 'Embed the viewer interest tags (ai.generate_embedding)', 'backend:apps/content-service/src/infrastructure/adapters/semantic-recommendation-service.adapter.ts:37-41'),
                                 msg('content', 'index', 'Hybrid search for related Reels (index.search_reels, 4-second timeout)', 'backend:apps/content-service/src/infrastructure/adapters/semantic-recommendation-service.adapter.ts:69-71'),
                                 msg('index', 'content', 'Return scored matches; any failure yields an empty pool and the feed continues', 'backend:apps/content-service/src/infrastructure/adapters/semantic-recommendation-service.adapter.ts:98-101', reply=True),
                             ]),
                       ),
                       msg('content', 'content', 'Merge and de-duplicate candidates; Reels found by several pools get a capped boost', 'backend:apps/content-service/src/application/use-cases/get-recommended-reels.use-case.ts:1049-1099'),
                       msg('content', 'db', 'Load the 24-hour seen history, eligible Reels and the ranking snapshot', 'backend:apps/content-service/src/application/use-cases/get-recommended-reels.use-case.ts:646-654', 'backend:apps/content-service/src/application/use-cases/get-recommended-reels.use-case.ts:889-895'),
                       msg('content', 'content', 'Rank the unseen Reels with the feature ranker (personalized-ranker-v2)', 'backend:apps/content-service/src/application/use-cases/get-recommended-reels.use-case.ts:646-654'),
                       frame('opt',
                             ('neural rerank flag on, at least 2 unseen Reels and the viewer has interest tags', [
                                 msg('content', 'ai', 'Score the top K (default 20) Reel texts against the interest tags (ai.rerank_texts, 3-second timeout)', 'backend:apps/content-service/src/infrastructure/adapters/ai-recommendation-reranker.adapter.ts:68-72'),
                                 msg('ai', 'content', 'Return cross-encoder relevance scores (TEI reranker)', 'backend:apps/content-service/src/infrastructure/adapters/ai-recommendation-reranker.adapter.ts:71-81', reply=True),
                                 msg('content', 'content', 'Blend rank-normalized scores centred on zero; on any failure keep the feature-ranked order', 'backend:apps/content-service/src/application/use-cases/get-recommended-reels.use-case.ts:958-1008'),
                             ]),
                       ),
                       msg('content', 'content', 'Diversify the unseen Reels, then append seen ones only if capacity remains', 'backend:apps/content-service/src/application/use-cases/get-recommended-reels.use-case.ts:909-919'),
                       msg('content', 'redis', 'Cache the Reel entities and save the session with refill marked complete', 'backend:apps/content-service/src/application/use-cases/get-recommended-reels.use-case.ts:609-694'),
                       msg('content', 'redis', 'Release the refill lock', 'backend:apps/content-service/src/application/use-cases/get-recommended-reels.use-case.ts:542-564'),
                   ]),
             ),
             note('Only unseen Reel IDs are appended to the session, so pages already shown keep their order', 'backend:apps/content-service/src/application/use-cases/get-recommended-reels.use-case.ts:646-654'),
         ]),

    dict(id='34a-hls-owner-preview', title='34a · Owner-local preview before the validated stream is ready',
         participants=[('creator', 'Creator / detail view'), ('registry', 'Owner and device local registry'), ('resolver', 'Playback source hook'), ('player', 'ReelVideo trim and crop player'), ('gateway', 'API Gateway status endpoint'), ('r2', 'Cloudflare R2 public domain')],
         steps=[
             msg('creator', 'registry', 'After upload and create ACK, record the Reel ID with the retained original, trim/crop and owner device', 'mobile:src/lib/localReelPlayback.ts:347-419'),
             msg('creator', 'resolver', 'Resolve the playback source for the authenticated owner', 'mobile:src/lib/localReelPlayback.ts:436-473', 'mobile:src/hooks/useOfflineReelVideoSource.ts:77-79'),
             frame('alt',
                   ('an authorized local preview exists and the remote stream is not ready or the device is offline', [
                       msg('resolver', 'player', 'Play the retained original with the existing trim and crop renderer', 'mobile:src/hooks/useOfflineReelVideoSource.ts:182-239'),
                       note('Only the uploading owner and device see this; the backend Reel stays PENDING or PROCESSING and other viewers see a processing placeholder', 'mobile:src/hooks/useOfflineReelVideoSource.ts:182-239'),
                   ]),
                   ('validated remote HLS exists and the offline-cache policy chooses the cached stream', [
                       msg('resolver', 'player', 'Use the cached HLS manifest source', 'mobile:src/hooks/useOfflineReelVideoSource.ts:182-239'),
                   ]),
                   ('validated remote HLS exists and the device is online', [
                       msg('resolver', 'player', 'Use the validated hlsMaster stream URL', 'mobile:src/hooks/useOfflineReelVideoSource.ts:182-239'),
                       msg('player', 'r2', 'Play HLS natively straight from the public R2 domain; no gateway byte proxy', 'mobile:src/hooks/useOfflineReelVideoSource.ts:182-239'),
                   ]),
                   ('no usable authorized source', [
                       note('Show a queued, processing, failed or offline-unavailable state', 'mobile:src/hooks/useOfflineReelVideoSource.ts:182-239'),
                   ]),
             ),
             note('The local source stays pinned for the owner; 14-day expiry and safe cleanup apply', 'mobile:src/hooks/useOfflineReelVideoSource.ts:182-239', 'mobile:src/components/reels/ReelFeedItem.tsx:1225-1251'),
         ]),

    dict(id='34b-hls-validated-stream', title='34b · Status polling and the switch to the validated HLS stream',
         participants=[('creator', 'Creator / detail view'), ('gateway', 'API Gateway status endpoint'), ('resolver', 'Playback source hook'), ('player', 'ReelVideo trim and crop player'), ('r2', 'Cloudflare R2 public domain')],
         steps=[
             frame('loop',
                   ('media, evidence or index work is still pending', [
                       msg('creator', 'gateway', 'Poll the Reel status (existing TanStack query)', 'mobile:src/hooks/useReels.ts:1237-1257'),
                       msg('gateway', 'creator', 'Return media and index statuses (separate fields); streamUrl only when media is COMPLETED with an HLS master key', 'mobile:src/lib/reelProcessing.ts:265-294', 'backend:apps/api-gateway/src/content/content.controller.ts:669-672', reply=True),
                   ]),
             ),
             frame('opt',
                   ('media COMPLETED and a valid HLS URL arrives', [
                       note('HLS warm-up and the temporary offline cache run independently for validated remote assets', 'mobile:src/hooks/useOfflineReelVideoSource.ts:182-239', 'mobile:src/components/reels/ReelFeedItem.tsx:1225-1251'),
                       msg('resolver', 'player', 'Prefer the validated HLS and safely replace the coordinated player source', 'mobile:src/hooks/useOfflineReelVideoSource.ts:182-239', 'mobile:src/components/reels/ReelFeedItem.tsx:1225-1251'),
                       note('Queue the output-relative position on detach; the trim wrapper adds the source offset once; mute and pause state are preserved', 'mobile:src/hooks/useOfflineReelVideoSource.ts:182-239', 'mobile:src/components/reels/ReelFeedItem.tsx:1225-1251'),
                       msg('player', 'r2', 'Fetch master playlist, variants and segments directly from the public R2 domain', 'mobile:src/hooks/useOfflineReelVideoSource.ts:182-239'),
                       frame('opt',
                             ('remote playback errors', [
                                 note('Bounded fallback: try each available remote or local candidate once; no backend media failure is written', 'mobile:src/hooks/useOfflineReelVideoSource.ts:182-239', 'mobile:src/components/reels/ReelFeedItem.tsx:1225-1251'),
                             ]),
                       ),
                   ]),
             ),
         ]),

    dict(id='35a-series-create-update', title='35a · Create and update a Series',
         participants=[('mobile', 'Velora-Mobile'), ('gateway', 'API Gateway'), ('content', 'Content Service'), ('db', 'Content Database')],
         steps=[
             frame('alt',
                   ('create', [
                       msg('mobile', 'gateway', 'POST /content/series', 'backend:apps/api-gateway/src/content/content.controller.ts:157-168'),
                       msg('gateway', 'content', 'Forward content.create_reel_series (owner ID and payload)', 'backend:apps/api-gateway/src/content/content.controller.ts:163-169'),
                       msg('content', 'db', 'Create the Series with owner, title, description and visibility', 'backend:apps/content-service/src/application/use-cases/create-reel-series.use-case.ts:13-21'),
                   ]),
                   ('update', [
                       msg('mobile', 'gateway', 'PATCH /content/series/:id', 'backend:apps/api-gateway/src/content/content.controller.ts:286-300'),
                       msg('gateway', 'content', 'Forward content.update_reel_series (owner ID and payload)', 'backend:apps/api-gateway/src/content/content.controller.ts:294-301'),
                       note('Load the Series and require the owner; otherwise Forbidden or NotFound', 'backend:apps/content-service/src/application/use-cases/update-reel-series.use-case.ts:15-29'),
                       msg('content', 'db', 'Transaction: re-check the owner and update the Series metadata', 'backend:apps/content-service/src/infrastructure/repositories/reel-series.repository.ts:345-375'),
                       frame('opt',
                             ('visibility changed', [
                                 msg('content', 'db', 'Propagate the new visibility to member Reels in the same transaction', 'backend:apps/content-service/src/infrastructure/repositories/reel-series.repository.ts:357-361'),
                             ]),
                       ),
                   ]),
             ),
             msg('content', 'gateway', 'Return the persisted Series (RPC result)', 'backend:apps/content-service/src/application/use-cases/create-reel-series.use-case.ts:13-21', reply=True),
             msg('gateway', 'mobile', 'Enrich the Series and return the HTTP response', 'backend:apps/api-gateway/src/content/content.controller.ts:171-174', reply=True),
             note('Mobile reconciles the viewer Series cache and the command-specific list and episode queries', 'mobile:src/hooks/useReels.ts:1125-1145'),
         ]),

    dict(id='35b-series-membership-order', title='35b · Add, remove and reorder Series episodes',
         participants=[('mobile', 'Velora-Mobile'), ('gateway', 'API Gateway'), ('content', 'Content Service'), ('db', 'Content Database')],
         steps=[
             frame('alt',
                   ('add Reels', [
                       msg('mobile', 'gateway', 'POST /content/series/:id/reels', 'backend:apps/api-gateway/src/content/content.controller.ts:326-341'),
                       msg('gateway', 'content', 'Forward content.add_reel_to_series (owner ID and Reel IDs)', 'backend:apps/api-gateway/src/content/content.controller.ts:334-341'),
                       note('Load the owned Series; Forbidden or NotFound exits before any change', 'backend:apps/content-service/src/application/use-cases/add-reels-to-series.use-case.ts:18-32'),
                       msg('content', 'db', 'Serializable transaction: validate every requested Reel', 'backend:apps/content-service/src/infrastructure/repositories/reel-series.repository.ts:400-435', 'backend:apps/content-service/src/infrastructure/repositories/reel-series.repository.ts:400-440'),
                       frame('alt',
                             ('all Reels are owned, COMPLETED, standalone and match the Series visibility', [
                                 msg('content', 'db', 'Append episodeNumber = current maximum + 1 + index; each update must change exactly one row', 'backend:apps/content-service/src/infrastructure/repositories/reel-series.repository.ts:439-467'),
                                 msg('content', 'gateway', 'Return the persisted Series', 'backend:apps/api-gateway/src/content/content.controller.ts:326-344', reply=True),
                                 msg('gateway', 'mobile', 'Return the HTTP Series response', 'backend:apps/api-gateway/src/content/content.controller.ts:326-344', reply=True),
                             ]),
                             ('eligibility fails, membership conflicts or the transaction aborts (P2002 or P2034)', [
                                 msg('content', 'gateway', 'SeriesConflict; the transaction rolls back', 'backend:apps/content-service/src/infrastructure/repositories/reel-series.repository.ts:470-484', 'backend:apps/content-service/src/application/use-cases/get-reel-series-episodes.use-case.ts:1-49', reply=True),
                                 msg('gateway', 'mobile', 'Return the HTTP conflict', 'backend:apps/api-gateway/src/content/content.controller.ts:341-341', reply=True),
                             ]),
                       ),
                   ]),
                   ('remove a Reel', [
                       msg('mobile', 'gateway', 'DELETE /content/series/:id/reels/:reelId', 'backend:apps/api-gateway/src/content/content.controller.ts:347-362'),
                       msg('gateway', 'content', 'Forward content.remove_reel_from_series (owner ID and Reel ID)', 'backend:apps/api-gateway/src/content/content.controller.ts:355-362'),
                       note('Require an owned Series and an existing member Reel', 'backend:apps/content-service/src/application/use-cases/remove-reel-from-series.use-case.ts:17-29'),
                       msg('content', 'db', 'Serializable detach: clear seriesId and episodeNumber, then renumber the remaining episodes', 'backend:apps/content-service/src/infrastructure/repositories/reel-series.repository.ts:488-517'),
                   ]),
                   ('reorder', [
                       msg('mobile', 'gateway', 'PATCH /content/series/:id/reels/order', 'backend:apps/api-gateway/src/content/content.controller.ts:368-383'),
                       msg('gateway', 'content', 'Forward content.reorder_reel_series (owner ID and the full Reel ID list)', 'backend:apps/api-gateway/src/content/content.controller.ts:376-383'),
                       msg('content', 'db', 'Serializable transaction: re-check the owner and the exact member set', 'backend:apps/content-service/src/infrastructure/repositories/reel-series.repository.ts:556-580'),
                       msg('content', 'db', 'Clear episode numbers, then write index + 1 in the requested order', 'backend:apps/content-service/src/infrastructure/repositories/reel-series.repository.ts:582-598'),
                       frame('alt',
                             ('the transaction commits', [
                                 msg('content', 'gateway', 'Return the persisted Series', 'backend:apps/api-gateway/src/content/content.controller.ts:368-386', reply=True),
                                 msg('gateway', 'mobile', 'Return the HTTP Series response', 'backend:apps/api-gateway/src/content/content.controller.ts:368-386', reply=True),
                             ]),
                             ('membership changed or the transaction aborts', [
                                 msg('content', 'gateway', 'SeriesConflict; no mutation result', 'backend:apps/content-service/src/application/use-cases/get-reel-series-episodes.use-case.ts:1-49', reply=True),
                                 msg('gateway', 'mobile', 'Return the HTTP conflict', 'backend:apps/api-gateway/src/content/content.controller.ts:383-383', reply=True),
                             ]),
                       ),
                   ]),
             ),
         ]),

    dict(id='36a-series-playback-entry', title='36a · Series episode page access and loading',
         participants=[('mobile', 'Velora-Mobile (Series screen)'), ('cache', 'TanStack Query cache'), ('gateway', 'API Gateway'), ('content', 'Content Service'), ('db', 'Content Database'), ('friend', 'Friend Service')],
         steps=[
             msg('mobile', 'cache', 'Load the viewer-bound Series query (Series ID and aroundReelId)', 'mobile:src/hooks/useReels.ts:1022-1061'),
             frame('alt',
                   ('the query is enabled and the cache is missing or stale', [
                       msg('mobile', 'gateway', 'GET /content/series/:id/episodes (aroundReelId or a directional cursor)', 'backend:apps/api-gateway/src/content/content.controller.ts:238-257'),
                       msg('gateway', 'content', 'Forward content.get_reel_series_episodes (viewer ID, isAdmin, query)', 'backend:apps/api-gateway/src/content/content.controller.ts:245-258'),
                       msg('content', 'db', 'Read the Series by ID; a missing Series is NotFound', 'backend:apps/content-service/src/application/use-cases/get-reel-series-episodes.use-case.ts:1-49'),
                       frame('opt',
                             ('the viewer is neither admin nor owner', [
                                 msg('content', 'friend', 'Check access (friend.can_view_reel_content)', 'backend:apps/content-service/src/infrastructure/adapters/friend-content-access.adapter.ts:40-62'),
                                 msg('friend', 'content', 'allowed; a failed check counts as false', 'backend:apps/content-service/src/infrastructure/adapters/friend-content-access.adapter.ts:45-62', reply=True),
                             ]),
                       ),
                       frame('alt',
                             ('admin, owner or allowed', [
                                 msg('content', 'db', 'Read the episode page; only COMPLETED Reels unless admin or owner', 'backend:apps/content-service/src/application/use-cases/get-reel-series-episodes.use-case.ts:1-49'),
                                 msg('db', 'content', 'Ordered episode window with cursors and count', 'backend:apps/content-service/src/application/use-cases/get-reel-series-episodes.use-case.ts:1-49', reply=True),
                                 msg('content', 'gateway', 'Return the Series and the episode page', 'backend:apps/content-service/src/application/use-cases/get-reel-series-episodes.use-case.ts:1-49', reply=True),
                                 msg('gateway', 'mobile', 'Enrich the page and return it over HTTP', 'backend:apps/api-gateway/src/content/content.controller.ts:261-263', reply=True),
                                 msg('mobile', 'cache', 'Store the infinite query in 15-item windows', 'mobile:src/hooks/useReels.ts:1022-1061'),
                             ]),
                             ('not allowed', [
                                 msg('content', 'gateway', 'RPC NotFound', 'backend:apps/content-service/src/application/use-cases/get-reel-series-episodes.use-case.ts:1-49', reply=True),
                                 msg('gateway', 'mobile', 'Return the HTTP access failure; playback is not initialized', 'backend:apps/api-gateway/src/content/content.controller.ts:258-258', reply=True),
                             ]),
                       ),
                   ]),
                   ('the query cache is fresh', [
                       msg('cache', 'mobile', 'Return the cached episode pages', 'mobile:src/hooks/useReels.ts:1072-1094', reply=True),
                   ]),
             ),
         ]),

    dict(id='36b-series-episode-switch', title='36b · Choosing an episode and loading further pages',
         participants=[('mobile', 'Velora-Mobile (Series screen)'), ('sheet', 'Episode bottom sheet'), ('gateway', 'API Gateway')],
         steps=[
             frame('opt',
                   ('episode data loaded and the Series has episodes', [
                       msg('mobile', 'mobile', 'Resolve the selected and stable playing Reel from requestedReelId', 'mobile:app/series/[id]/index.tsx:106-139'),
                       note('The viewer source is initialised separately from episode-data pagination', 'mobile:app/series/[id]/index.tsx:106-139'),
                       frame('opt',
                             ('the user opens the episode sheet', [
                                 msg('mobile', 'sheet', 'Increment the sheet session and present it', 'mobile:app/series/[id]/index.tsx:268-271'),
                                 msg('mobile', 'sheet', 'Mount near the playing episode (initialIndex = playing index minus leading rows)', 'mobile:app/series/[id]/index.tsx:141-148', 'mobile:app/series/[id]/index.tsx:577-588'),
                                 frame('opt',
                                       ('the user selects an episode', [
                                           msg('sheet', 'mobile', 'handleEpisodeSelect(reelId)', 'mobile:app/series/[id]/index.tsx:273-276', sort='asynchSignal'),
                                           msg('mobile', 'mobile', 'Remember the pending selected Reel ID', 'mobile:app/series/[id]/index.tsx:273-274'),
                                           msg('mobile', 'sheet', 'Dismiss the sheet', 'mobile:app/series/[id]/index.tsx:275-275'),
                                           msg('sheet', 'mobile', 'onDismiss triggers handleEpisodeSheetDismiss()', 'mobile:app/series/[id]/index.tsx:525-537', sort='asynchSignal'),
                                           frame('opt',
                                                 ('a pending selection exists', [
                                                     msg('mobile', 'mobile', 'Clear the pending ID; set the active, playing and selected Reel', 'mobile:app/series/[id]/index.tsx:249-255'),
                                                     note('The selected identity chooses the player source (see 34a)', 'mobile:app/series/[id]/index.tsx:249-255'),
                                                 ]),
                                           ),
                                       ]),
                                 ),
                             ]),
                       ),
                       frame('opt',
                             ('the user reaches the previous or next episode-data boundary and a cursor exists', [
                                 msg('mobile', 'gateway', 'Fetch the directional cursor page through the same cached, access-checked operation (36a)', 'mobile:src/hooks/useReels.ts:90-110'),
                                 note('The active Reel identity and previous pages are preserved', 'mobile:src/hooks/useReels.ts:90-110'),
                             ]),
                       ),
                   ]),
             ),
         ]),

    dict(id='37a-share-to-ai-assistant', title='37a · Share a Reel with the Velora AI assistant',
         participants=[('creator', 'Sharing user / Mobile'), ('recipient', 'Recipient Mobile / conversation room'), ('gateway', 'API Gateway'), ('content', 'Content Service'), ('db', 'Content share records'), ('conversation', 'Conversation Service (AI/share scope)'), ('user', 'User profile service')],
         steps=[
             msg('creator', 'gateway', 'POST /content/reels/:id/share (target defaults to the AI bot)', 'backend:apps/api-gateway/src/content/content.controller.ts:676-702'),
             msg('gateway', 'content', 'Forward content.share_reel (sharer, conversation, target)', 'backend:apps/api-gateway/src/content/content.controller.ts:690-699'),
             msg('content', 'db', 'Find Reel; require mediaStatus=COMPLETED + validated hlsMasterKey', 'backend:apps/content-service/src/application/use-cases/share-reel.use-case.ts:34-34'),
             frame('alt',
                   ('sharer owns the Reel or it is public', [
                       frame('alt',
                             ('target is the AI bot (default when no recipient is given)', [
                                 msg('content', 'conversation', 'get_conversation_detail(conversationId, sharer)', 'backend:apps/content-service/src/infrastructure/adapters/conversation-message.adapter.ts:42-68'),
                                 msg('conversation', 'content', 'Participant IDs; unavailable -> false', 'backend:apps/content-service/src/infrastructure/adapters/conversation-message.adapter.ts:57-57', reply=True),
                                 note('Require bot participant; failed check -> Forbidden exit', 'backend:apps/content-service/src/application/use-cases/share-reel.use-case.ts:126-141'),
                             ]),
                       ),
                       msg('content', 'db', 'shareReel upsert with messageId=null; may return existing linked share', 'backend:apps/content-service/src/application/use-cases/share-reel.use-case.ts:62-69'),
                       frame('alt',
                             ('share.messageId exists', [
                                 msg('content', 'content', 'Reuse linked share; response omits message payload', 'backend:apps/content-service/src/application/use-cases/share-reel.use-case.ts:26-106'),
                             ]),
                             ('else', [
                                 msg('content', 'user', 'Await user.find_public_by_ids(Reel owner)', 'backend:apps/content-service/src/infrastructure/adapters/user-service.adapter.ts:15-34'),
                                 msg('user', 'content', 'Owner profile or [] on timeout/error', 'backend:apps/content-service/src/infrastructure/adapters/user-service.adapter.ts:15-34', reply=True),
                                 frame('opt',
                                       ('owner profile unavailable', [
                                           msg('content', 'content', 'Omit optional owner username/picture; continue', 'backend:apps/content-service/src/infrastructure/adapters/conversation-message.adapter.ts:79-119'),
                                       ]),
                                 ),
                                 msg('content', 'conversation', 'create_message(type=reel; HLS key/stream URL + owner metadata)', 'backend:apps/content-service/src/infrastructure/adapters/conversation-message.adapter.ts:77-77'),
                                 note('SendMessage: persist idempotently; return saved message and created Boolean', 'backend:apps/conversation-service/src/application/use-cases/send-message.use-case.ts:21-32'),
                                 frame('alt',
                                       ('result.created', [
                                           msg('conversation', 'creator', 'new_message(saved Reel DTO); socket send', 'backend:apps/conversation-service/src/infrastructure/controllers/conversation.controller.ts:365-462', sort='asynchSignal'),
                                           msg('conversation', 'recipient', 'new_message(saved Reel DTO); socket send', 'backend:apps/conversation-service/src/infrastructure/controllers/conversation.controller.ts:365-462', sort='asynchSignal'),
                                           note('Await conversation read; if present emit conversation_updated and message activity before RPC return', 'backend:apps/conversation-service/src/infrastructure/controllers/conversation.controller.ts:247-248'),
                                           note('Detached trigger sees type=reel and returns triggered=false; no immediate AI question', 'backend:apps/conversation-service/src/infrastructure/controllers/conversation.controller.ts:365-462', 'backend:apps/conversation-service/src/application/use-cases/trigger-bot-reply.use-case.ts:26-75'),
                                       ]),
                                       ('!result.created', [
                                           msg('conversation', 'conversation', 'Return original message; skip repeated fan-out', 'backend:apps/conversation-service/src/infrastructure/controllers/conversation.controller.ts:365-462'),
                                       ]),
                                 ),
                                 msg('conversation', 'content', 'CreatedConversationMessage DTO', 'backend:apps/conversation-service/src/infrastructure/controllers/conversation.controller.ts:365-462', reply=True),
                                 msg('content', 'db', 'updateReelShareMessageId(share.id, message.id)', 'backend:apps/content-service/src/application/use-cases/share-reel.use-case.ts:90-93'),
                             ]),
                       ),
                       msg('content', 'gateway', 'ReelShareResponse incl messageId and optional message', 'backend:apps/content-service/src/application/use-cases/share-reel.use-case.ts:26-106', reply=True),
                       note('Await Gateway owner-media enrichment when share.message.media exists', 'backend:apps/api-gateway/src/content/content.controller.ts:98-134'),
                       msg('gateway', 'creator', 'HTTP share response', 'backend:apps/api-gateway/src/content/content.controller.ts:690-699', reply=True),
                       frame('opt',
                             ('!share.message && share.messageId exists', [
                                 msg('creator', 'gateway', 'GET /conversations/:id/messages/around/:messageId (before=1, after=1)', 'backend:apps/api-gateway/src/conversation/conversation.controller.ts:347-378'),
                                 msg('gateway', 'conversation', 'get_messages_around(userId, conversationId, messageId)', 'backend:apps/api-gateway/src/conversation/conversation.controller.ts:359-370'),
                                 msg('conversation', 'gateway', 'Message anchor window', 'backend:apps/api-gateway/src/conversation/conversation.controller.ts:359-370', reply=True),
                                 msg('gateway', 'creator', 'Enriched messages window; find target or throw', 'backend:apps/api-gateway/src/conversation/conversation.controller.ts:347-378', 'mobile:src/hooks/useReels.ts:1589-1591', reply=True),
                             ]),
                       ),
                       note('Share mutation success: upsert message/summary and local remote record; invalidate conversation queries', 'mobile:src/hooks/useReels.ts:1565-1626'),
                   ]),
                   ('else (friends/private nonowner)', [
                       msg('content', 'gateway', 'RPC Forbidden; no share/message writes', 'backend:apps/content-service/src/application/use-cases/share-reel.use-case.ts:108-124', reply=True),
                       msg('gateway', 'creator', 'HTTP rejected', 'backend:apps/api-gateway/src/content/content.controller.ts:690-699', reply=True),
                   ]),
             ),
         ]),

    dict(id='37b-share-to-user-chat', title='37b · Share a Reel with another user or group',
         participants=[('creator', 'Sharing user / Mobile'), ('recipient', 'Recipient Mobile / conversation room'), ('gateway', 'API Gateway'), ('content', 'Content Service'), ('db', 'Content share records'), ('conversation', 'Conversation Service (AI/share scope)'), ('friend', 'Friend Service'), ('user', 'User profile service')],
         steps=[
             msg('creator', 'gateway', 'POST /content/reels/:id/share', 'backend:apps/api-gateway/src/content/content.controller.ts:676-702'),
             msg('gateway', 'content', 'Forward content.share_reel (sharer, conversation, target)', 'backend:apps/api-gateway/src/content/content.controller.ts:690-699'),
             msg('content', 'db', 'Find Reel; require mediaStatus=COMPLETED + validated hlsMasterKey', 'backend:apps/content-service/src/application/use-cases/share-reel.use-case.ts:34-34'),
             frame('alt',
                   ('sharer owns the Reel or it is public', [
                       frame('alt',
                             ('target is another user', [
                                 frame('alt',
                                       ('recipient != sharer', [
                                           msg('content', 'friend', 'friend.can_share_with_user(requester, target)', 'backend:apps/content-service/src/infrastructure/adapters/friend-share-policy.adapter.ts:18-42'),
                                           msg('friend', 'content', 'allowed/reason; errors -> denied', 'backend:apps/content-service/src/infrastructure/adapters/friend-share-policy.adapter.ts:23-28', reply=True),
                                           note('Require allowed; false -> Forbidden exit', 'backend:apps/content-service/src/application/use-cases/share-reel.use-case.ts:151-154'),
                                       ]),
                                       ('recipient == sharer', [
                                           msg('content', 'content', 'Self-share: bypass friend RPC', 'backend:apps/content-service/src/application/use-cases/share-reel.use-case.ts:143-161'),
                                       ]),
                                 ),
                             ]),
                       ),
                       msg('content', 'db', 'shareReel upsert with messageId=null; may return existing linked share', 'backend:apps/content-service/src/application/use-cases/share-reel.use-case.ts:62-69'),
                       frame('alt',
                             ('share.messageId exists', [
                                 msg('content', 'content', 'Reuse linked share; response omits message payload', 'backend:apps/content-service/src/application/use-cases/share-reel.use-case.ts:26-106'),
                             ]),
                             ('else', [
                                 msg('content', 'user', 'Await user.find_public_by_ids(Reel owner)', 'backend:apps/content-service/src/infrastructure/adapters/user-service.adapter.ts:15-34'),
                                 msg('user', 'content', 'Owner profile or [] on timeout/error', 'backend:apps/content-service/src/infrastructure/adapters/user-service.adapter.ts:15-34', reply=True),
                                 frame('opt',
                                       ('owner profile unavailable', [
                                           msg('content', 'content', 'Omit optional owner username/picture; continue', 'backend:apps/content-service/src/infrastructure/adapters/conversation-message.adapter.ts:79-119'),
                                       ]),
                                 ),
                                 msg('content', 'conversation', 'create_message(type=reel; HLS key/stream URL + owner metadata)', 'backend:apps/content-service/src/infrastructure/adapters/conversation-message.adapter.ts:77-77'),
                                 note('SendMessage: persist idempotently; return saved message and created Boolean', 'backend:apps/conversation-service/src/application/use-cases/send-message.use-case.ts:21-32'),
                                 frame('alt',
                                       ('result.created', [
                                           msg('conversation', 'creator', 'new_message(saved Reel DTO); socket send', 'backend:apps/conversation-service/src/infrastructure/controllers/conversation.controller.ts:365-462', sort='asynchSignal'),
                                           msg('conversation', 'recipient', 'new_message(saved Reel DTO); socket send', 'backend:apps/conversation-service/src/infrastructure/controllers/conversation.controller.ts:365-462', sort='asynchSignal'),
                                           note('Await conversation read; if present emit conversation_updated and message activity before RPC return', 'backend:apps/conversation-service/src/infrastructure/controllers/conversation.controller.ts:247-248'),
                                           note('Detached trigger sees type=reel and returns triggered=false; no immediate AI question', 'backend:apps/conversation-service/src/infrastructure/controllers/conversation.controller.ts:365-462', 'backend:apps/conversation-service/src/application/use-cases/trigger-bot-reply.use-case.ts:26-75'),
                                       ]),
                                       ('!result.created', [
                                           msg('conversation', 'conversation', 'Return original message; skip repeated fan-out', 'backend:apps/conversation-service/src/infrastructure/controllers/conversation.controller.ts:365-462'),
                                       ]),
                                 ),
                                 msg('conversation', 'content', 'CreatedConversationMessage DTO', 'backend:apps/conversation-service/src/infrastructure/controllers/conversation.controller.ts:365-462', reply=True),
                                 msg('content', 'db', 'updateReelShareMessageId(share.id, message.id)', 'backend:apps/content-service/src/application/use-cases/share-reel.use-case.ts:90-93'),
                             ]),
                       ),
                       msg('content', 'gateway', 'ReelShareResponse incl messageId and optional message', 'backend:apps/content-service/src/application/use-cases/share-reel.use-case.ts:26-106', reply=True),
                       note('Await Gateway owner-media enrichment when share.message.media exists', 'backend:apps/api-gateway/src/content/content.controller.ts:98-134'),
                       msg('gateway', 'creator', 'HTTP share response', 'backend:apps/api-gateway/src/content/content.controller.ts:690-699', reply=True),
                       frame('opt',
                             ('!share.message && share.messageId exists', [
                                 msg('creator', 'gateway', 'GET /conversations/:id/messages/around/:messageId (before=1, after=1)', 'backend:apps/api-gateway/src/conversation/conversation.controller.ts:347-378'),
                                 msg('gateway', 'conversation', 'get_messages_around(userId, conversationId, messageId)', 'backend:apps/api-gateway/src/conversation/conversation.controller.ts:359-370'),
                                 msg('conversation', 'gateway', 'Message anchor window', 'backend:apps/api-gateway/src/conversation/conversation.controller.ts:359-370', reply=True),
                                 msg('gateway', 'creator', 'Enriched messages window; find target or throw', 'backend:apps/api-gateway/src/conversation/conversation.controller.ts:347-378', 'mobile:src/hooks/useReels.ts:1589-1591', reply=True),
                             ]),
                       ),
                       note('Share mutation success: upsert message/summary and local remote record; invalidate conversation queries', 'mobile:src/hooks/useReels.ts:1565-1626'),
                   ]),
                   ('else (friends/private nonowner)', [
                       msg('content', 'gateway', 'RPC Forbidden; no share/message writes', 'backend:apps/content-service/src/application/use-cases/share-reel.use-case.ts:108-124', reply=True),
                       msg('gateway', 'creator', 'HTTP rejected', 'backend:apps/api-gateway/src/content/content.controller.ts:690-699', reply=True),
                   ]),
             ),
             frame('opt',
                   ('new_message socket event received (independently of HTTP)', [
                       note('Independent socket receive: reconcile shared Reel message and conversation caches; delivery may race HTTP response', 'mobile:src/providers/SocketProvider.tsx:292-314'),
                   ]),
             ),
         ]),

    dict(id='38a-share-link-create-revoke', title='38a · Create and revoke a public share link',
         participants=[('creator', 'Link creator / owner caller'), ('gateway', 'API Gateway / public resolver'), ('content', 'Content Service'), ('db', 'Content Reel/link DB')],
         steps=[
             frame('alt',
                   ('requested operation == create', [
                       msg('creator', 'gateway', 'POST /content/reels/:id/share-link', 'backend:apps/api-gateway/src/content/content.controller.ts:705-727'),
                       msg('gateway', 'content', 'content.create_reel_share_link(createdBy, reuseExisting, expiresInDays)', 'backend:apps/api-gateway/src/content/content.controller.ts:712-721'),
                       msg('content', 'db', 'Find Reel', 'backend:apps/content-service/src/application/use-cases/create-reel-share-link.use-case.ts:24-24'),
                       frame('alt',
                             ('Reel exists && mediaStatus == COMPLETED && hlsMasterKey exists && visibility == public', [
                                 frame('opt',
                                       ('reuseExisting != false', [
                                           msg('content', 'db', 'Find active Reel+creator link at now', 'backend:apps/content-service/src/application/use-cases/create-reel-share-link.use-case.ts:18-77'),
                                       ]),
                                 ),
                                 frame('alt',
                                       ('reuseExisting != false && active link found', [
                                           msg('content', 'content', 'Reuse existing link', 'backend:apps/content-service/src/application/use-cases/create-reel-share-link.use-case.ts:18-77'),
                                       ]),
                                       ('else', [
                                           msg('content', 'content', 'Resolve expiry: integer >=1 capped 365d; otherwise none', 'backend:apps/content-service/src/application/use-cases/create-reel-share-link.use-case.ts:79-93'),
                                           frame('loop',
                                                 ('attempt < 5 && link not created', [
                                                     msg('content', 'content', 'Generate base64url token from 12 random bytes', 'backend:apps/content-service/src/application/use-cases/create-reel-share-link.use-case.ts:95-101'),
                                                     msg('content', 'db', 'findReelShareLinkByToken(token)', 'backend:apps/content-service/src/application/use-cases/create-reel-share-link.use-case.ts:58-58'),
                                                     frame('alt',
                                                           ('token exists', [
                                                               msg('content', 'content', 'Continue next token attempt', 'backend:apps/content-service/src/application/use-cases/create-reel-share-link.use-case.ts:18-77'),
                                                           ]),
                                                           ('else', [
                                                               msg('content', 'db', 'createReelShareLink; return link (leave loop)', 'backend:apps/content-service/src/application/use-cases/create-reel-share-link.use-case.ts:18-77'),
                                                           ]),
                                                     ),
                                                 ]),
                                           ),
                                           frame('opt',
                                                 ('no unique token after 5 attempts', [
                                                     msg('content', 'content', 'Throw unique-token generation error', 'backend:apps/content-service/src/application/use-cases/create-reel-share-link.use-case.ts:18-77'),
                                                 ]),
                                           ),
                                       ]),
                                 ),
                                 frame('opt',
                                       ('link successfully returned', [
                                           msg('content', 'gateway', 'Link record only', 'backend:apps/content-service/src/application/use-cases/create-reel-share-link.use-case.ts:18-77', reply=True),
                                           msg('gateway', 'creator', 'Link record + publicUrl; no appDeepLink', 'backend:apps/api-gateway/src/content/content.controller.ts:705-727', reply=True),
                                       ]),
                                 ),
                             ]),
                             ('else', [
                                 note('NotFound / NotReady / Forbidden; Content RPC error -> Gateway mapped HTTP error -> caller; no successful write/playback', 'backend:apps/content-service/src/application/use-cases/create-reel-share-link.use-case.ts:18-77', 'backend:apps/api-gateway/src/content/content.controller.ts:712-721'),
                             ]),
                       ),
                   ]),
                   ('requested operation == revoke', [
                       msg('creator', 'gateway', 'DELETE /content/reels/share-links/:token', 'backend:apps/api-gateway/src/content/content.controller.ts:730-749'),
                       msg('gateway', 'content', 'content.revoke_reel_share_link(revokedByUserId)', 'backend:apps/api-gateway/src/content/content.controller.ts:730-749'),
                       msg('content', 'db', 'Find token', 'backend:apps/content-service/src/application/use-cases/revoke-reel-share-link.use-case.ts:20-22'),
                       frame('alt',
                             ('existing && (caller == link.creator || caller == Reel.owner)', [
                                 msg('content', 'db', 'Persist revoke; missing mutation result -> NotFound', 'backend:apps/content-service/src/application/use-cases/revoke-reel-share-link.use-case.ts:37-37'),
                                 msg('content', 'gateway', 'Revoked record', 'backend:apps/content-service/src/application/use-cases/revoke-reel-share-link.use-case.ts:16-44', reply=True),
                                 msg('gateway', 'creator', 'Revoked record + publicUrl', 'backend:apps/api-gateway/src/content/content.controller.ts:730-749', reply=True),
                             ]),
                             ('else', [
                                 note('NotFound / Forbidden; Content RPC error -> Gateway mapped HTTP error -> caller; no successful write/playback', 'backend:apps/content-service/src/application/use-cases/revoke-reel-share-link.use-case.ts:16-44', 'backend:apps/api-gateway/src/content/content.controller.ts:712-721'),
                             ]),
                       ),
                   ]),
             ),
         ]),

    dict(id='38b-share-link-resolution', title='38b · Resolve a public share link',
         participants=[('recipient', 'Public link recipient'), ('gateway', 'API Gateway / public resolver'), ('content', 'Content Service'), ('db', 'Content Reel/link DB')],
         steps=[
             frame('alt',
                   ('requested operation == public resolve', [
                       msg('recipient', 'gateway', 'GET /r/:token', 'backend:apps/api-gateway/src/content/public-reel-share.controller.ts:52-94'),
                       msg('gateway', 'content', 'content.resolve_reel_share_link(trimmed token)', 'backend:apps/api-gateway/src/content/public-reel-share.controller.ts:62-71'),
                       msg('content', 'db', 'Find token with linked Reel; require mediaStatus=COMPLETED + hlsMasterKey', 'backend:apps/content-service/src/application/use-cases/resolve-reel-share-link.use-case.ts:21-60'),
                       frame('alt',
                             ('found && !revokedAt && (!expiresAt || expiresAt > now) && mediaStatus == COMPLETED && hlsMasterKey exists && visibility == public', [
                                 msg('content', 'db', 'Persist clickCount increment', 'backend:apps/content-service/src/application/use-cases/resolve-reel-share-link.use-case.ts:51-54'),
                                 msg('content', 'gateway', 'Updated link + current Reel', 'backend:apps/content-service/src/application/use-cases/resolve-reel-share-link.use-case.ts:21-60', reply=True),
                                 msg('gateway', 'recipient', 'Minimal Reel metadata + validated HLS streamUrl + publicUrl + appDeepLink', 'backend:apps/api-gateway/src/content/public-reel-share.controller.ts:52-94', reply=True),
                                 frame('opt',
                                       ('recipient plays returned streamUrl', [
                                           note('34 · Recipient native player fetches HLS directly from CDN', 'backend:apps/api-gateway/src/content/public-reel-share.controller.ts:104-118'),
                                       ]),
                                 ),
                             ]),
                             ('missing || revoked || expired || not ready || nonpublic', [
                                 note('Resolution error; no click increment; Content RPC error -> Gateway mapped HTTP error -> caller; no successful write/playback', 'backend:apps/content-service/src/application/use-cases/resolve-reel-share-link.use-case.ts:21-60', 'backend:apps/api-gateway/src/content/public-reel-share.controller.ts:62-71'),
                             ]),
                       ),
                   ]),
             ),
         ]),

    dict(id='39a-rag-scope-routing', title='39a · AI question entry, Reel scope and query routing',
         participants=[('mobile', 'Velora-Mobile'), ('conv', 'Conversation Service'), ('ai', 'AI Service'), ('content', 'Content Service'), ('db', 'Content Database'), ('prov', 'Router LLM provider')],
         steps=[
             msg('mobile', 'conv', 'send_message (text, conversationId, clientMessageId)', 'backend:apps/conversation-service/src/infrastructure/gateways/chat.gateway.ts:233-255', sort='asynchSignal'),
             note('Conversation resolves the sender, requires a clientMessageId and a participant, and persists the message idempotently', 'backend:apps/conversation-service/src/infrastructure/gateways/chat.gateway.ts:233-255'),
             frame('opt',
                   ('created text message from a non-bot sender in a conversation with the bot', [
                       frame('alt',
                             ('the sender is inside the AI turn rate limit', [
                                 note('Build bounded answer memory (see 40a)', 'backend:apps/conversation-service/src/application/use-cases/build-bot-memory-context.use-case.ts:12-49', 'backend:apps/conversation-service/src/application/use-cases/build-bot-memory-context.use-case.ts:29-53'),
                                 msg('conv', 'ai', 'ai.stream_question (message, userId, conversationId, answerMemory)', 'backend:apps/conversation-service/src/infrastructure/adapters/ai-service.adapter.ts:22-45'),
                                 note('AI Service admission: 2 turns run at once, 6 may wait up to 20 seconds, more are refused with AI_BUSY', 'backend:apps/ai-service/src/infrastructure/adapters/in-process-chat-admission.adapter.ts:54-78'),
                                 note('Shadow guardrails screen the input and the final answer; they only log findings and never change routing or the answer', 'backend:apps/ai-service/src/infrastructure/adapters/langgraph-rag-chat-workflow.adapter.ts:241-249'),
                                 msg('ai', 'content', 'Resolve shared-Reel access (content.resolve_reel_context_access)', 'backend:apps/ai-service/src/infrastructure/adapters/content-service.adapter.ts:67-85'),
                                 msg('content', 'db', 'Conversation-scoped shares whose media and index are COMPLETED; distinct Reel IDs', 'backend:apps/content-service/src/infrastructure/repositories/content.repository.ts:1172-1188'),
                                 msg('content', 'ai', 'Return ready, indexed shared Reel IDs (a failed lookup returns none)', 'backend:apps/ai-service/src/infrastructure/adapters/content-service.adapter.ts:78-84', reply=True),
                                 msg('ai', 'prov', 'Route the question semantically (bounded primary and fallback policy)', 'backend:apps/ai-service/src/application/use-cases/query-router-agent.use-case.ts:391-417'),
                                 msg('prov', 'ai', 'Return the route decision, or report the router unavailable', 'backend:apps/ai-service/src/infrastructure/adapters/langgraph-rag-chat-workflow.adapter.ts:552-569', reply=True),
                                 frame('alt',
                                       ('the router returns a valid route', [
                                           note('Retrieval and answering continue in 39b and 41a', 'backend:apps/ai-service/src/infrastructure/adapters/deterministic-retrieval-engine.adapter.ts:792-793'),
                                       ]),
                                       ('the router is unavailable or throws', [
                                           note('The error propagates to the stream RPC and the user gets bot_reply_failed; no planning or retrieval runs', 'backend:apps/ai-service/src/infrastructure/controller/ai.controller.ts:295-325'),
                                       ]),
                                 ),
                             ]),
                             ('the sender exceeded the AI turn rate limit', [
                                 msg('conv', 'mobile', 'bot_reply_failed with RATE_LIMITED and retryAfterSeconds; the user message stays stored and no AI call is made', 'backend:apps/conversation-service/src/application/use-cases/trigger-bot-reply.use-case.ts:47-59', sort='asynchSignal'),
                             ]),
                       ),
                   ]),
             ),
         ]),

    dict(id='39b-rag-search-rerank', title='39b · Retrieval planning, hybrid search, cross-encoder rerank and sufficiency',
         participants=[('ai', 'AI RAG workflow'), ('index', 'Reel Indexing semantic RPC'), ('tei', 'TEI embeddings / reranker'), ('provider', 'Structured / tool LLM provider')],
         steps=[
             frame('alt',
                   ('the context tool agent is enabled', [
                       note('Bounded tool-agent provider loop; allowlisted/required tools; capped calls execute serially; memory/evidence tools use the same scoped engine; tool-provider failure + no evidence -> guarded scoped retrieval fallback; rerank has retrieved-chunk fallback', 'backend:apps/ai-service/src/application/use-cases/context-tool-agent.use-case.ts:114-170', 'backend:apps/ai-service/src/application/use-cases/context-tool-agent.use-case.ts:199-252'),
                       note('Tool-agent returns memoryReady=true; retrievalReady=!needsRetrieval; sufficiency gates follow', 'backend:apps/ai-service/src/infrastructure/adapters/langgraph-rag-chat-workflow.adapter.ts:712-722'),
                   ]),
                   ('the context tool agent is disabled', [
                       note('Memory selection runs in parallel and is described in 40a', 'backend:apps/ai-service/src/application/use-cases/get-conversation-memory.use-case.ts:12-23'),
                       frame('opt',
                             ('the route needs retrieval', [
                                 frame('alt',
                                       ('a source-specific deterministic plan exists', [
                                           msg('ai', 'ai', 'Use source-specific deterministic retrieval plan', 'backend:apps/ai-service/src/infrastructure/adapters/deterministic-retrieval-engine.adapter.ts:792-793'),
                                       ]),
                                       ('else', [
                                           msg('ai', 'provider', 'Structured retrieval planner; failure -> NONE', 'backend:apps/ai-service/src/infrastructure/adapters/deterministic-retrieval-engine.adapter.ts:795-838'),
                                           msg('provider', 'ai', 'Normalized plan / fail-closed diagnostics', 'backend:apps/ai-service/src/infrastructure/adapters/deterministic-retrieval-engine.adapter.ts:816-838', reply=True),
                                       ]),
                                 ),
                                 frame('alt',
                                       ('the question asks for Reel metadata', [
                                           note('If scope has multiple IDs: Index searchReels(queryText, scoped IDs); require exactly one target; getReelDocument; validate Reel identity; return title/description/tags evidence', 'backend:apps/ai-service/src/infrastructure/adapters/deterministic-retrieval-engine.adapter.ts:127-179'),
                                       ]),
                                       ('the question asks for the opening of the Reel', [
                                           msg('ai', 'index', 'index.search_chunks(scoped IDs, sourceOrder=ASC, limit=1); hydrate scoped evidence', 'backend:apps/ai-service/src/infrastructure/adapters/deterministic-retrieval-engine.adapter.ts:181-197', 'backend:apps/ai-service/src/infrastructure/adapters/reel-semantic-index.adapter.ts:34-64', 'backend:libs/common/src/processing/interfaces/semantic-index.interface.ts:5-12'),
                                       ]),
                                       ('the plan needs no retrieval', [
                                           msg('ai', 'ai', 'Return []; planner NONE path (no embedding)', 'backend:apps/ai-service/src/infrastructure/adapters/deterministic-retrieval-engine.adapter.ts:199-205'),
                                       ]),
                                       ('no shared Reel is in scope', [
                                           msg('ai', 'ai', 'Return []; empty conversation scope (no embedding)', 'backend:apps/ai-service/src/infrastructure/adapters/deterministic-retrieval-engine.adapter.ts:206-209'),
                                       ]),
                                       ('else', [
                                           frame('loop',
                                                 ('each planned query', [
                                                     msg('ai', 'tei', 'POST /embed; RETRIEVAL_QUERY; validate vector model/version/dimensions', 'backend:apps/ai-service/src/infrastructure/adapters/tei-embedding.adapter.ts:13-35'),
                                                     msg('tei', 'ai', 'Normalized vector + identity', 'backend:apps/ai-service/src/infrastructure/adapters/tei-embedding.adapter.ts:19-35', reply=True),
                                                     note('Scoped direct hybrid chunk/visual search in parallel; optional hierarchical path / shadow; hydrate documents and dedupe', 'backend:apps/ai-service/src/infrastructure/adapters/deterministic-retrieval-engine.adapter.ts:230-249', 'backend:apps/ai-service/src/infrastructure/adapters/deterministic-retrieval-engine.adapter.ts:332-373', 'backend:apps/ai-service/src/infrastructure/adapters/deterministic-retrieval-engine.adapter.ts:454-519'),
                                                 ]),
                                           ),
                                       ]),
                                 ),
                                 frame('opt',
                                       ('evidence was retrieved', [
                                           frame('alt',
                                                 ('the plan asks for reranking', [
                                                     msg('ai', 'tei', 'POST /rerank; planned rerankLimit; bounded TEI retries', 'backend:apps/ai-service/src/infrastructure/adapters/tei-reranker.adapter.ts:99-188'),
                                                     msg('tei', 'ai', 'Rerank scores', 'backend:apps/ai-service/src/infrastructure/adapters/tei-reranker.adapter.ts:181-185', reply=True),
                                                 ]),
                                                 ('else', [
                                                     msg('ai', 'ai', 'Slice retrieved candidates to rerankLimit', 'backend:apps/ai-service/src/infrastructure/adapters/deterministic-retrieval-engine.adapter.ts:279-279'),
                                                 ]),
                                           ),
                                           note('Accept only original chunkId+reelId pairs before adjacency', 'backend:apps/ai-service/src/infrastructure/adapters/deterministic-retrieval-engine.adapter.ts:280-287'),
                                           frame('loop',
                                                 ('each transcript hit with a parent and index version', [
                                                     msg('ai', 'index', 'index.get_adjacent_chunks(chunkId, reelId, parentId, eligible IDs, requiredIndexVersion, limit=2)', 'backend:apps/ai-service/src/infrastructure/adapters/deterministic-retrieval-engine.adapter.ts:293-306', 'backend:apps/ai-service/src/infrastructure/adapters/reel-semantic-index.adapter.ts:34-64', 'backend:libs/common/src/processing/interfaces/semantic-index.interface.ts:5-12'),
                                                     msg('ai', 'index', 'index.get_reel_document(item.reelId)', 'backend:apps/ai-service/src/infrastructure/adapters/deterministic-retrieval-engine.adapter.ts:307-309', 'backend:apps/ai-service/src/infrastructure/adapters/reel-semantic-index.adapter.ts:34-64', 'backend:libs/common/src/processing/interfaces/semantic-index.interface.ts:5-12'),
                                                     note('Sort neighbors; reject mismatched Reel, parent, indexVersion or non-TRANSCRIPT; dedupe', 'backend:apps/ai-service/src/infrastructure/adapters/deterministic-retrieval-engine.adapter.ts:310-323', 'backend:apps/reel-indexing-service/src/infrastructure/repositories/prisma-semantic-index.repository.ts:264-308'),
                                                 ]),
                                           ),
                                           frame('opt',
                                                 ('rerank or adjacency fails or returns nothing', [
                                                     msg('ai', 'ai', 'Workflow fallback: slice original retrieved chunks', 'backend:apps/ai-service/src/infrastructure/adapters/langgraph-rag-chat-workflow.adapter.ts:748-762'),
                                                 ]),
                                           ),
                                       ]),
                                 ),
                             ]),
                       ),
                   ]),
             ),
             frame('alt',
                   ('retrieval or the tool agent was used', [
                       note('Assess sufficiency: deterministic no-context/modality/not-required exits; otherwise structured provider assessment (failure closed)', 'backend:apps/ai-service/src/application/use-cases/check-context-sufficiency.use-case.ts:39-158', 'backend:apps/ai-service/src/application/use-cases/check-context-sufficiency.use-case.ts:243-265'),
                       frame('alt',
                             ('the evidence is sufficient for a grounded answer', [
                                 msg('ai', 'ai', 'retrievalReady=true; answer-context join', 'backend:apps/ai-service/src/infrastructure/adapters/langgraph-rag-chat-workflow.adapter.ts:458-458'),
                                 frame('alt',
                                       ('memory and retrieval are both ready', [
                                           note('41 · Draft / verify / citations / final delivery', 'backend:apps/ai-service/src/infrastructure/adapters/langgraph-rag-chat-workflow.adapter.ts:1513-1519'),
                                       ]),
                                       ('else', [
                                           msg('ai', 'ai', 'Join returns END; do not draft yet', 'backend:apps/ai-service/src/infrastructure/adapters/langgraph-rag-chat-workflow.adapter.ts:1516-1519'),
                                       ]),
                                 ),
                             ]),
                             ('the evidence is insufficient and a rewrite retry remains', [
                                 note('Rewrite and increment retry (configured default 1, 0..2); reroute to tool agent or planner, reretrieve and reassess', 'backend:apps/ai-service/src/infrastructure/adapters/langgraph-rag-chat-workflow.adapter.ts:796-818', 'backend:apps/ai-service/src/infrastructure/adapters/langgraph-rag-chat-workflow.adapter.ts:1472-1508'),
                             ]),
                             ('else', [
                                 note('41 · No-context answer -> finalAnswerNode; skip draft and verification happy path', 'backend:apps/ai-service/src/infrastructure/adapters/langgraph-rag-chat-workflow.adapter.ts:541-543', 'backend:apps/ai-service/src/infrastructure/adapters/langgraph-rag-chat-workflow.adapter.ts:1510-1510'),
                             ]),
                       ),
                   ]),
                   ('no retrieval is needed', [
                       note('Join when memoryReady; 41 · Answer path without Reel retrieval', 'backend:apps/ai-service/src/infrastructure/adapters/langgraph-rag-chat-workflow.adapter.ts:1513-1519'),
                   ]),
             ),
         ]),

    dict(id='40a-rag-answer-memory', title='40a · Bounded answer memory and memory selection for a question',
         participants=[('conversation', 'Conversation Service'), ('cdb', 'Conversation message store'), ('ai', 'AI memory agents'), ('aidb', 'AI summary / user-memory DB'), ('tei', 'TEI embeddings')],
         steps=[
             msg('conversation', 'cdb', 'Read last 20 messages; exclude current question/recalled/signals; retain eligible text/Reel context', 'backend:apps/conversation-service/src/application/use-cases/build-bot-memory-context.use-case.ts:12-49'),
             msg('conversation', 'conversation', 'answerMemory = last 12 eligible recent messages', 'backend:apps/conversation-service/src/application/use-cases/build-bot-memory-context.use-case.ts:29-53'),
             note('39 · ai.stream_question sends bounded answerMemory; router selects memory sources', 'backend:apps/conversation-service/src/application/use-cases/process-bot-reply.use-case.ts:37-47'),
             frame('par',
                   ('conversation summary', [
                       frame('opt',
                             ('the router asks for the conversation summary', [
                                 msg('ai', 'aidb', 'Read conversation summary by conversationId', 'backend:apps/ai-service/src/application/use-cases/get-conversation-memory.use-case.ts:12-23'),
                             ]),
                       ),
                   ]),
                   ('user memory', [
                       frame('opt',
                             ('the router asks for user memory', [
                                 frame('opt',
                                       ('semantic memory retrieval is enabled and the query is not empty', [
                                           msg('ai', 'tei', 'Generate RETRIEVAL_QUERY embedding', 'backend:apps/ai-service/src/application/use-cases/get-relevant-user-memories.use-case.ts:97-101'),
                                           note('Read expected DB dimensions; exact dimensions -> identity-scoped vector search; mismatch/error -> []', 'backend:apps/ai-service/src/application/use-cases/get-relevant-user-memories.use-case.ts:103-140'),
                                       ]),
                                 ),
                                 frame('opt',
                                       ('no semantic memory matched', [
                                           msg('ai', 'aidb', 'Read bounded user pool; lexical rank; relevant slice or high-confidence fallback', 'backend:apps/ai-service/src/application/use-cases/get-relevant-user-memories.use-case.ts:144-176'),
                                       ]),
                                 ),
                                 msg('ai', 'aidb', 'markUsed(selected IDs); return up to 8 selected memories', 'backend:apps/ai-service/src/application/use-cases/get-relevant-user-memories.use-case.ts:62-78'),
                             ]),
                       ),
                   ]),
             ),
         ]),

    dict(id='40b-rag-turn-memory-update', title='40b · Completed-turn memory: summary and long-term user memory',
         participants=[('conversation', 'Conversation Service'), ('ai', 'AI memory agents'), ('aidb', 'AI summary / user-memory DB'), ('provider', 'Summary / extraction LLM provider'), ('tei', 'TEI embeddings'), ('rmq', 'RabbitMQ completed-turn event')],
         steps=[
             note('41 · AI result received; result.answer truthy -> await assistant createMessage with citations/metadata; error/null -> no completed turn', 'backend:apps/conversation-service/src/application/use-cases/process-bot-reply.use-case.ts:42-79'),
             frame('opt',
                   ('the assistant answer was saved', [
                       msg('conversation', 'conversation', 'completedTurnMemory = answerMemory + current user + saved assistant; trim last 12', 'backend:apps/conversation-service/src/application/use-cases/build-completed-turn-memory-context.use-case.ts:12-40'),
                       msg('conversation', 'rmq', 'ai.conversation_turn_completed(completed memory); detached event emission', 'backend:apps/conversation-service/src/infrastructure/adapters/ai-service.adapter.ts:72-81', sort='asynchSignal'),
                       msg('rmq', 'ai', 'Consume completed-turn event (outside answer RPC completion)', 'backend:apps/ai-service/src/infrastructure/controller/ai.controller.ts:315-324', sort='asynchSignal'),
                       frame('alt',
                             ('the completed turn has user, conversation and both messages', [
                                 frame('alt',
                                       ('conversation memory is enabled', [
                                           frame('alt',
                                                 ('the summary update succeeds', [
                                                     msg('ai', 'aidb', 'Find conversation memory', 'backend:apps/ai-service/src/application/use-cases/update-conversation-memory.use-case.ts:42-45'),
                                                     msg('ai', 'ai', 'nextMessageCount = (existing.messageCount ?? 0) + 2', 'backend:apps/ai-service/src/application/use-cases/update-conversation-memory.use-case.ts:47-55'),
                                                     frame('opt',
                                                           ('every 4th turn (AI_CONVERSATION_MEMORY_EVERY_N_TURNS)', [
                                                               msg('ai', 'provider', 'summarizeTurn(existingSummary, completed recentMessages, user + assistant)', 'backend:apps/ai-service/src/application/use-cases/update-conversation-memory.use-case.ts:60-68', 'backend:apps/ai-service/src/infrastructure/adapters/ollama-conversation-summarizer.adapter.ts:31-80'),
                                                               msg('provider', 'ai', 'Summary / shouldUpdate; provider failure keeps previous summary', 'backend:apps/ai-service/src/infrastructure/adapters/ollama-conversation-summarizer.adapter.ts:31-80', reply=True),
                                                               note('Sanitize; only shouldUpdate && nonempty summary replaces old value', 'backend:apps/ai-service/src/application/use-cases/update-conversation-memory.use-case.ts:70-84'),
                                                           ]),
                                                     ),
                                                     msg('ai', 'aidb', 'Upsert summary + messageCount + lastMessageAt', 'backend:apps/ai-service/src/application/use-cases/update-conversation-memory.use-case.ts:88-94'),
                                                 ]),
                                                 ('the summary update throws', [
                                                     note('Attempt summary update; log/skip failure; messageCount=max(completed recentMessages.length + 2, 2)', 'backend:apps/ai-service/src/application/use-cases/memory-writer-agent.use-case.ts:49-61', 'backend:apps/ai-service/src/application/use-cases/memory-writer-agent.use-case.ts:111-117'),
                                                 ]),
                                           ),
                                       ]),
                                       ('conversation memory is disabled', [
                                           msg('ai', 'ai', 'Estimate messageCount=max(completed recentMessages.length + 2, 2)', 'backend:apps/ai-service/src/application/use-cases/memory-writer-agent.use-case.ts:31-36'),
                                       ]),
                                 ),
                                 frame('opt',
                                       ('userMemoryExtractionEnabled && floor(messageCount / 2) > 0 && floor(messageCount / 2) % AI_USER_MEMORY_EVERY_N_TURNS == 0 (default 1)', [
                                           frame('alt',
                                                 ('extraction and upsert complete', [
                                                     msg('ai', 'provider', 'Extract long-term memories from deduped recent user-only source (last 8) + completed assistant', 'backend:apps/ai-service/src/application/use-cases/extract-user-memories-from-turn.use-case.ts:29-56', 'backend:apps/ai-service/src/infrastructure/adapters/ollama-memory-extractor.adapter.ts:24-48'),
                                                     msg('provider', 'ai', 'Parsed memory candidates; provider failure -> []', 'backend:apps/ai-service/src/infrastructure/adapters/ollama-memory-extractor.adapter.ts:24-48', reply=True),
                                                     msg('ai', 'ai', 'Sanitize/filter: allowed type, LONG_TERM, confidence/length, exact user evidence; dedupe type+normalizedContent', 'backend:apps/ai-service/src/application/use-cases/upsert-user-memories.use-case.ts:59-86', 'backend:apps/ai-service/src/application/use-cases/upsert-user-memories.use-case.ts:216-250'),
                                                     frame('loop',
                                                           ('each valid, unique memory', [
                                                               frame('opt',
                                                                     ('memory embeddings are enabled (default)', [
                                                                         msg('ai', 'tei', 'Generate RETRIEVAL_DOCUMENT embedding for memory', 'backend:apps/ai-service/src/application/use-cases/upsert-user-memories.use-case.ts:170-175'),
                                                                         note('Validate expected dimensions; mismatch/embedding error -> persist without vector', 'backend:apps/ai-service/src/application/use-cases/upsert-user-memories.use-case.ts:177-203'),
                                                                     ]),
                                                               ),
                                                               note('If embedded: semantic+lexical consolidation against same user; consolidate if similar else upsertMany(memory)', 'backend:apps/ai-service/src/application/use-cases/upsert-user-memories.use-case.ts:90-155'),
                                                           ]),
                                                     ),
                                                 ]),
                                                 ('extraction or upsert throws', [
                                                     note('Attempt configured extraction/upsert; throw enters safeExtractUserMemories catch', 'backend:apps/ai-service/src/application/use-cases/memory-writer-agent.use-case.ts:68-93'),
                                                     msg('ai', 'ai', 'Log user-memory skipped; do not affect saved assistant', 'backend:apps/ai-service/src/application/use-cases/memory-writer-agent.use-case.ts:87-93'),
                                                 ]),
                                           ),
                                       ]),
                                 ),
                             ]),
                             ('else', [
                                 msg('ai', 'ai', 'Ignore incomplete completed turn', 'backend:apps/ai-service/src/application/use-cases/handle-conversation-turn-completed.use-case.ts:12-18'),
                             ]),
                       ),
                   ]),
             ),
         ]),

    dict(id='41a-rag-draft-verify-cite', title='41a · Draft, verify and cite the grounded answer',
         participants=[('ai', 'AI Service (RAG workflow)'), ('prov', 'Answer and verifier LLM provider')],
         steps=[
             note('Evidence and memory are ready from 39b and 40a; if the evidence is insufficient the workflow skips drafting', 'backend:apps/ai-service/src/infrastructure/adapters/langgraph-rag-chat-workflow.adapter.ts:1317-1336'),
             frame('loop',
                   ('the verifier requires a revision and revisions remain (bounded by the maximum and confidence threshold)', [
                       msg('ai', 'prov', 'Draft the grounded answer, or revise it when asked (structured generation; a synthesis failure falls back to a local answer)', 'backend:apps/ai-service/src/infrastructure/adapters/langgraph-rag-chat-workflow.adapter.ts:871-891'),
                       msg('ai', 'prov', 'Verify the draft against the retrieved evidence (verifier agent)', 'backend:apps/ai-service/src/infrastructure/adapters/langgraph-rag-chat-workflow.adapter.ts:1014-1034'),
                       msg('prov', 'ai', 'Return the verdict: pass, requires revision, or fail', 'backend:apps/ai-service/src/infrastructure/adapters/langgraph-rag-chat-workflow.adapter.ts:1631-1651', reply=True),
                       msg('ai', 'ai', 'On a revision verdict: count the retry, clear citations and redraft', 'backend:apps/ai-service/src/infrastructure/adapters/langgraph-rag-chat-workflow.adapter.ts:1009-1017'),
                   ]),
             ),
             frame('alt',
                   ('the verifier passes the answer', [
                       frame('alt',
                             ('citations are needed', [
                                 msg('ai', 'prov', 'Attribute claims to evidence (structured; at most 3 citations)', 'backend:apps/ai-service/src/application/use-cases/build-rag-citations.use-case.ts:56-63', 'backend:apps/ai-service/src/infrastructure/adapters/structured-llm-citation-attribution.adapter.ts:84-105'),
                                 msg('prov', 'ai', 'Return claim and evidence selections; only exact IDs survive', 'backend:apps/ai-service/src/application/use-cases/build-rag-citations.use-case.ts:73-92', reply=True),
                                 note('With no selections or a provider failure the verifier mapping is used, otherwise coverage stays incomplete', 'backend:apps/ai-service/src/application/use-cases/build-rag-citations.use-case.ts:73-92'),
                             ]),
                             ('no citations are needed', [
                                 msg('ai', 'ai', 'Coverage is NOT_REQUIRED and the provider is not called', 'backend:apps/ai-service/src/application/use-cases/build-rag-citations.use-case.ts:173-189'),
                             ]),
                       ),
                       frame('opt',
                             ('coverage is below the threshold and citation retries remain', [
                                 msg('ai', 'ai', 'Count a citation retry, clear coverage and citations, and request a factual-claim rewrite; redraft and verify again', 'backend:apps/ai-service/src/infrastructure/adapters/langgraph-rag-chat-workflow.adapter.ts:1088-1107'),
                             ]),
                       ),
                       msg('ai', 'ai', 'Citation gate passes; go to the final answer', 'backend:apps/ai-service/src/infrastructure/adapters/langgraph-rag-chat-workflow.adapter.ts:1573-1587'),
                   ]),
                   ('the verifier fails the answer, or citation coverage stays below the threshold after the retries', [
                       note('VerificationFailureNode: a guarded grounded or extractive rescue, otherwise a reliable refusal text; then the final answer', 'backend:apps/ai-service/src/infrastructure/adapters/langgraph-rag-chat-workflow.adapter.ts:1155-1185'),
                   ]),
                   ('the evidence is insufficient (context sufficiency chose the no-context path)', [
                       msg('ai', 'ai', 'Local no-context answer with no citations; drafting and verification are skipped', 'backend:apps/ai-service/src/infrastructure/adapters/langgraph-rag-chat-workflow.adapter.ts:1317-1336'),
                   ]),
             ),
         ]),

    dict(id='41b-rag-stream-delivery', title='41b · Stream the final answer and persist it',
         participants=[('mobile', 'Mobile AI conversation'), ('conversation', 'Conversation Service'), ('cdb', 'Conversation message store'), ('ai', 'AI RAG workflow'), ('provider', 'Structured / streaming LLM provider'), ('rmq', 'RabbitMQ token / memory channels')],
         steps=[
             note('Final answer state reaches StreamFinalAnswer only after successful coverage or local failure/no-context outcome', 'backend:apps/ai-service/src/infrastructure/adapters/langgraph-rag-chat-workflow.adapter.ts:541-543'),
             frame('alt',
                   ('the workflow completes', [
                       frame('par',
                             ('AI Service side: stream the answer and return the result', [
                                 frame('alt',
                                       ('a verified answer already exists', [
                                           frame('loop',
                                                 ('each 80-character slice of the answer', [
                                                     msg('ai', 'rmq', 'ai.stream_token: at most 80 UTF-16 code units per existing-answer chunk', 'backend:apps/ai-service/src/infrastructure/adapters/conversation-token-publisher.adapter.ts:15-35', sort='asynchSignal'),
                                                 ]),
                                           ),
                                       ]),
                                       ('else', [
                                           msg('ai', 'provider', 'generateResponseStream(systemPrompt, userMessage, callback)', 'backend:apps/ai-service/src/application/use-cases/stream-final-answer.use-case.ts:34-52'),
                                           frame('loop',
                                                 ('each token from the provider', [
                                                     msg('ai', 'rmq', 'ai.stream_token: callback token (no universal 80-unit bound)', 'backend:apps/ai-service/src/application/use-cases/stream-final-answer.use-case.ts:40-49', sort='asynchSignal'),
                                                 ]),
                                           ),
                                           msg('provider', 'ai', 'Generated answer string', 'backend:apps/ai-service/src/application/use-cases/stream-final-answer.use-case.ts:54-56', reply=True),
                                       ]),
                                 ),
                                 msg('ai', 'conversation', 'ai.stream_question final RPC response: answer/citations/metadata (or error)', 'backend:apps/ai-service/src/infrastructure/controller/ai.controller.ts:279-311', reply=True),
                                 frame('alt',
                                       ('the AI returned an answer', [
                                           msg('conversation', 'cdb', 'Await createMessage(assistant text + citations/recommendation metadata)', 'backend:apps/conversation-service/src/application/use-cases/process-bot-reply.use-case.ts:49-79'),
                                           msg('cdb', 'conversation', 'Saved durable assistant', 'backend:apps/conversation-service/src/application/use-cases/process-bot-reply.use-case.ts:79-79', reply=True),
                                           note('40 · Build completedTurnMemory = answerMemory + current user + saved assistant; emit completed-turn event detached', 'backend:apps/conversation-service/src/application/use-cases/process-bot-reply.use-case.ts:81-94', 'backend:apps/conversation-service/src/infrastructure/adapters/ai-service.adapter.ts:72-81'),
                                           msg('conversation', 'mobile', 'Callback new_message(saved assistant DTO with final metadata)', 'backend:apps/conversation-service/src/infrastructure/gateways/chat.gateway.ts:316-323', sort='asynchSignal'),
                                           note('Mobile reconcileStreamingBotMessage and upsert durable message; final metadata replaces temporary stream record', 'mobile:src/providers/SocketProvider.tsx:1449-1493'),
                                       ]),
                                       ('the answer is empty, or the AI returned an error', [
                                           note('Empty AI answer -> NO_CONTENT; RPC/provider failure -> AI_UNAVAILABLE; omit save/completed turn', 'backend:apps/ai-service/src/infrastructure/controller/ai.controller.ts:279-311', 'backend:apps/conversation-service/src/infrastructure/adapters/ai-service.adapter.ts:36-68', 'backend:apps/conversation-service/src/application/use-cases/process-bot-reply.use-case.ts:101-115'),
                                           msg('conversation', 'mobile', 'bot_reply_failed(userMessageId, clientMessageId, error)', 'backend:apps/conversation-service/src/infrastructure/gateways/chat.gateway.ts:344-353', 'backend:apps/conversation-service/src/infrastructure/gateways/chat.gateway.ts:106-120', sort='asynchSignal'),
                                       ]),
                                 ),
                             ]),
                             ('Conversation side: relay each token to the client', [
                                 frame('loop',
                                       ('each ai.stream_token event', [
                                           msg('rmq', 'conversation', 'ai.stream_token(conversationId, userId, token)', 'backend:apps/conversation-service/src/infrastructure/controllers/conversation.controller.ts:668-681', sort='asynchSignal'),
                                           msg('conversation', 'mobile', 'bot_token(conversationId, token)', 'backend:apps/conversation-service/src/infrastructure/controllers/conversation.controller.ts:668-681', sort='asynchSignal'),
                                           note('Normalize token and upsert temporary streaming bot message', 'mobile:src/providers/SocketProvider.tsx:1440-1446'),
                                       ]),
                                 ),
                             ]),
                       ),
                   ]),
                   ('the workflow or final stream throws', [
                       msg('ai', 'conversation', 'RPC exception -> adapter answer=null / AI_UNAVAILABLE', 'backend:apps/conversation-service/src/infrastructure/adapters/ai-service.adapter.ts:46-68', reply=True),
                       msg('conversation', 'mobile', 'bot_reply_failed; no assistant save or completed-turn event', 'backend:apps/conversation-service/src/infrastructure/gateways/chat.gateway.ts:344-353', sort='asynchSignal'),
                   ]),
                   ('the AI Service turns the turn away because it is busy (admission)', [
                       msg('ai', 'conversation', 'Return the AI_BUSY error with retryAfterSeconds instead of a failure', 'backend:apps/ai-service/src/infrastructure/controller/ai.controller.ts:295-305', reply=True),
                       msg('conversation', 'mobile', 'bot_reply_failed with AI_BUSY, a friendly message and retryAfterSeconds', 'backend:apps/conversation-service/src/infrastructure/gateways/chat.gateway.ts:135-145', sort='asynchSignal'),
                   ]),
             ),
         ]),

    dict(id='42a-observability-trace-capture', title='42a · Langfuse trace capture around a RAG workflow run',
         participants=[('workflow', 'AI RAG workflow'), ('tracing', 'Langfuse tracing adapter'), ('sdk', 'OTEL SDK / Langfuse processor')],
         steps=[
             msg('workflow', 'workflow', 'Allocate productionExecutionId = randomUUID()', 'backend:apps/ai-service/src/infrastructure/adapters/langgraph-rag-chat-workflow.adapter.ts:162-165'),
             frame('alt',
                   ('Langfuse is enabled with public and secret keys', [
                       msg('workflow', 'tracing', 'withRoot(metadata, operation); root is created here', 'backend:apps/ai-service/src/infrastructure/adapters/langgraph-rag-chat-workflow.adapter.ts:173-185'),
                       msg('tracing', 'sdk', 'startActiveObservation(rag.workflow); propagate trace/session/release metadata', 'backend:apps/ai-service/src/infrastructure/services/langfuse-tracing.service.ts:75-93'),
                       msg('tracing', 'sdk', 'root.update: bounded input; capture query only if captureContent', 'backend:apps/ai-service/src/infrastructure/services/langfuse-tracing.service.ts:94-105'),
                       note('39–41 · Execute workflow; record node observations and provider token diagnostics', 'backend:apps/ai-service/src/infrastructure/adapters/langgraph-rag-chat-workflow.adapter.ts:189-280'),
                       note('finally: latency/token usage; delete execution context; snapshot error boundary is local', 'backend:apps/ai-service/src/infrastructure/adapters/langgraph-rag-chat-workflow.adapter.ts:280-284'),
                       frame('opt',
                             ('a root observation exists', [
                                 msg('workflow', 'tracing', 'Attempt snapshot build (when root exists) and setRootOutput inside local try', 'backend:apps/ai-service/src/infrastructure/adapters/langgraph-rag-chat-workflow.adapter.ts:284-312'),
                                 frame('alt',
                                       ('the snapshot is built and stored', [
                                           msg('tracing', 'sdk', 'root.update(redacted output; schema rag-monitoring-v1)', 'backend:apps/ai-service/src/infrastructure/services/langfuse-tracing.service.ts:111-131'),
                                       ]),
                                       ('snapshot capture throws', [
                                           msg('workflow', 'workflow', 'Log diagnostics capture failed; preserve workflow result/error', 'backend:apps/ai-service/src/infrastructure/adapters/langgraph-rag-chat-workflow.adapter.ts:314-316'),
                                       ]),
                                 ),
                             ]),
                       ),
                       note('finally: publish existing RAG telemetry regardless of snapshot capture error', 'backend:apps/ai-service/src/infrastructure/adapters/langgraph-rag-chat-workflow.adapter.ts:317-317'),
                       msg('tracing', 'workflow', 'Return operation result / propagate workflow error after finally', 'backend:apps/ai-service/src/infrastructure/services/langfuse-tracing.service.ts:94-108', reply=True),
                       note('SDK processor batches OTEL observations independently; configured flushAt=20 / interval=5; sampling default=1; no workflow export-drain wait', 'backend:apps/ai-service/src/infrastructure/services/langfuse-telemetry.ts:5-45'),
                   ]),
                   ('else', [
                       note('Execute same workflow without root; no snapshot builder when root absent; existing telemetry still publishes', 'backend:apps/ai-service/src/infrastructure/adapters/langgraph-rag-chat-workflow.adapter.ts:186-186', 'backend:apps/ai-service/src/infrastructure/adapters/langgraph-rag-chat-workflow.adapter.ts:284-317', 'backend:apps/ai-service/src/infrastructure/services/langfuse-tracing.service.ts:75-75'),
                   ]),
             ),
         ]),

    dict(id='42b-observability-trace-export', title='42b · Operator export and validation of RAG traces',
         participants=[('langfuse', 'Langfuse observations API'), ('operator', 'Ops diagnostic reader/export')],
         steps=[
             note('Operator client requires configured public/secret keys and explicit base URL', 'backend:scripts/ops/langfuse-rag-traces.cjs:3-17'),
             frame('loop',
                   ('first page or next cursor exists (reject repeated cursor)', [
                       msg('operator', 'langfuse', 'observations.getMany(name=rag.workflow, fields=basic,time,io, limit=100, filters, cursor)', 'backend:scripts/ops/langfuse-rag-traces.cjs:60-66'),
                       msg('langfuse', 'operator', 'Raw observation page + cursor metadata', 'backend:scripts/ops/langfuse-rag-traces.cjs:60-68', reply=True),
                       msg('operator', 'operator', 'Validate page array/meta and unique observation IDs', 'backend:scripts/ops/langfuse-rag-traces.cjs:67-75'),
                       frame('alt',
                             ('schema/session/trace/endTime/executionId/retrieved+reranked arrays valid && no duplicate ID/cursor', [
                                 msg('operator', 'operator', 'Decode monitoring snapshot; attach traceId, observationId, startTime', 'backend:scripts/ops/langfuse-rag-traces.cjs:29-50'),
                             ]),
                             ('else', [
                                 msg('operator', 'operator', 'Throw TRACE_PROVENANCE=INCOMPLETE or AMBIGUOUS; stop export', 'backend:scripts/ops/langfuse-rag-traces.cjs:29-44', 'backend:scripts/ops/langfuse-rag-traces.cjs:67-79'),
                             ]),
                       ),
                   ]),
             ),
             frame('opt',
                   ('all pages and provenance validations succeed', [
                       msg('operator', 'operator', 'Return validated traces for diagnostic export', 'backend:scripts/ops/langfuse-rag-traces.cjs:81-86'),
                   ]),
             ),
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
    width = max(max(lanes.values()) + 250, 1500)

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
    '30b-index-stale-fencing',
    '35a-series-creation-flow',
    '35b-series-reels-ordering',
    '38a-share-link-generation',
    '40a-rag-turn-memory-assembly',
    '40b-rag-summary-maintenance',
    '41a-rag-streamed-generation',
    '41b-rag-verification-attribution',
    '42b-observability-trace-analysis',
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
    '01-microservices-architecture',
    '02-application-architecture',
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
    '12-identity-social',
    '13-content',
    '14-semantic-hierarchy',
    '15-index-state',
    '16-ai-conversation',
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
    '29d-index-deferred-visual-retry',
    '30a-index-checkpoint-resume',
    '30b-index-failure-retry-dlq',
    '31a-index-atomic-activation',
    '31b-index-rollback-recovery',
    '32a-feed-cache-paging',
    '32b-feed-background-refill',
    '33-cache-invalidation',
    '34a-hls-owner-preview',
    '34b-hls-validated-stream',
    '35a-series-create-update',
    '35b-series-membership-order',
    '36a-series-playback-entry',
    '36b-series-episode-switch',
    '37a-share-to-ai-assistant',
    '37b-share-to-user-chat',
    '38a-share-link-create-revoke',
    '38b-share-link-resolution',
    '39a-rag-scope-routing',
    '39b-rag-search-rerank',
    '40a-rag-answer-memory',
    '40b-rag-turn-memory-update',
    '41a-rag-draft-verify-cite',
    '41b-rag-stream-delivery',
    '42a-observability-trace-capture',
    '42b-observability-trace-export',
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
