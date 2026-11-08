#!/usr/bin/env python3
"""Modernize Velora diagram labels to natural domain language and simplify connectors."""
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

REPLACEMENTS = {
    # 17 Register
    "POST /auth/register": "Submit registration details (email, username, password)",
    "auth.register [RMQ RPC]": "Dispatch registration request via RabbitMQ RPC",
    "create_user: unverified profile": "Create unverified user profile in database",
    "Created user identity": "User profile created with pending verification",
    "Assign USER role": "Assign default USER role",
    "SET verify:code; six digits; TTL 900s": "Generate 6-digit confirmation code (15-min TTL)",
    "mail.send confirmation": "Send verification email with confirmation code",
    "POST /auth/confirm {token}": "Submit email confirmation code",
    "auth.confirm_account [RMQ RPC]": "Verify confirmation code via RabbitMQ RPC",
    "GET verify:token": "Lookup active confirmation code from cache",
    "verify_user(userId)": "Mark user account as verified in database",
    "DELETE verify:token (after verification)": "Invalidate consumed confirmation code",
    "Verification completed": "Account verification confirmed",
    "HTTP registration result": "Return registration success response",
    "HTTP verification result": "Return account verified confirmation",
    "InvalidTokenError / RPC 400": "Reject invalid or expired confirmation code",
    "HTTP invalid confirmation": "Display confirmation error to user",
    "Registration identity + success message": "Deliver registration identity and success notice",
    "userId or null": "Return user profile identifier or null",

    # 18 Login
    "POST /auth/mobile/login": "Submit mobile login credentials (email & password)",
    "auth.login [RMQ RPC]; Cache-Control no-store": "Authenticate user credentials via RabbitMQ",
    "validate_user(credentials)": "Verify account status and validate password hash",
    "Validated user or null": "Return validated user identity",
    "401 invalid credentials / 403 unverified": "Reject invalid credentials or unverified account",
    "Read authoritative roles": "Fetch authoritative user roles and permissions",
    "Persist hash + encrypted refresh; expiry = now + 90 days": "Store encrypted refresh token session (90-day expiry)",
    "HTTP token pair; no cookies": "Return new access and refresh token pair",
    "Persist refresh before publishing<br>memory access; delete retry ID<br>best-effort": "Securely store refresh token and clear<br>temporary retry identifier",
    "Persist refresh before publishing memory access; delete retry ID best-effor": "Securely store refresh token and clear temporary retry identifier",
    "GET /auth/me": "Query authenticated user profile",
    "HTTP AuthUser": "Return authenticated user profile to client",
    "HTTP authentication rejection": "Deliver authentication failure response",
    "Install profile only if hydrationVersion remains current": "Update active profile if cache hydration version matches",

    # 19 Google Login
    "POST /auth/mobile/google/verify {idToken}": "Submit Google OAuth ID token for verification",
    "auth.verify_google_token [RMQ RPC]; no-store": "Verify Google ID token via RabbitMQ",
    "user.find_by_email(profile.email)": "Query user profile by verified Google email",
    "update_user: link Google identity; preserve existing picture": "Link Google identity to user account in database",
    "create_user: verified Google profile": "Create verified user account from Google profile",
    "Created user; isNewUser=true, userId": "Provision new user account and issue profile ID",

    # 20 Refresh
    "POST /auth/mobile/refresh {refreshToken,refreshRequestId}": "Request session token rotation (refresh token & request ID)",
    "auth.refresh [RMQ RPC]": "Dispatch token rotation request via RabbitMQ",
    "verifyAsync refresh JWT signature and expiry": "Verify refresh token signature and expiration",
    "Verify signature/expiry; type=refresh; legacy needs jti": "Verify refresh token signature and valid token type",
    "InvalidTokenError; no global revoke": "Reject malformed or expired token (no session revoke)",
    "Find stored token by hash (legacy migration fallback)": "Query active token session from database by hash",
    "Stored token or null": "Return active token record",
    "Revoke all tokens for verified payload.sub": "Revoke all active user sessions (Stolen token detected)",
    "InvalidTokenError / rejected refresh": "Reject refresh: Token invalid or session revoked",
    "recoverRotatedRefreshToken(oldId, requestId)": "Attempt grace-period token recovery for dropped request",
    "Recovery only if ID matches, retry window open, replacement nonrevoked": "Verify retry request ID and valid grace-period window",
    "user.find_by_id(verified sub)": "Verify user account active and in good standing",
    "access 15m (type=access); reuse recovered refresh": "Issue new 15-min access token and reuse recovered refresh token",
    "Recovered replacement + new access": "Return recovered session tokens to Gateway",
    "Transactional CAS revoke old + create replacement; recover same-reques": "Atomically rotate token session in database (CAS revoke old + insert new)",
    "Transactional CAS revoke old + create replacement; recover same-request rotation conflict": "Atomically rotate token session in database (CAS revoke old + insert new)",
    "Persisted replacement or null": "Return newly persisted replacement token",
    "Revoke all user tokens after unrecoverable rotation conflict": "Emergency revoke all sessions after unrecoverable CAS conflict",
    "Replacement token pair": "Return freshly rotated access and refresh token pair",
    "HTTP replacement token pair": "Deliver rotated access and refresh token pair",
    "Persist refresh; then expose access; delete retry ID best-effort": "Store new refresh token in SecureStore and expose new access token",
    "Clear local token session; propagate auth error": "Clear local credentials and redirect user to login",
    "Retain credentials and stable request ID; propagate error": "Retain credentials for retry and propagate network error",
    "Created refreshPromise finally clears itself; joined callers await sam": "Clear mutex promise; concurrent callers receive new token",

    # 21 Authorization
    "GET /content/series/:id/episodes with bearer token": "Request protected series episodes (Bearer token)",
    "auth.verify_token [RMQ RPC; 5s timeout]": "Verify access token validity via RabbitMQ (5s timeout)",
    "verifyAsync JWT signature + expiry / tokenType=access": "Verify JWT signature, expiry and access token type",
    "RPC 401 invalid/expired token": "Reject expired or invalid access token",
    "HTTP 401; stop before Content": "Return 401 Unauthorized (Block before downstream)",
    "Cache lookup user roles in Redis": "Lookup cached user roles in Redis",
    "GET roles:userId; read failure treated as miss": "Fetch cached user roles from Redis",
    "Authorized token payload + permissions": "Return authorized token claims and user permissions",
    "Forward authenticated request with userId header": "Forward request to Content Service with verified user ID",
    "content.get_reel_series_episodes(vi ewerId,isAdmin,query)": "Request series episodes with viewer permissions",
    "content.get_reel_series_episodes(vi ewerId, isAdmin, query)": "Request series episodes with viewer permissions",
    "content.get_reel_series_episodes(viewerId, isAdmin, query)": "Request series episodes with viewer permissions",

    # 22 Logout
    "beginLogout: set fen": "Initiate logout: Set client fence to block concurrent refresh",
    "POST /auth/logout": "Submit logout request with refresh token",
    "auth.logout [RMQ RPC]": "Process logout request via RabbitMQ RPC",
    "Revoke refresh token session in database": "Revoke active refresh token session in database",
    "Clear local SecureStore tokens": "Purge local session tokens from SecureStore",
    "Redirect user to login screen": "Redirect user to unauthenticated login screen",
    "Logged out successfully; optional userId": "Confirm session termination for user",

    # 23 Friend send/accept
    "POST /friends/request": "Send friend request to target user",
    "friend.send_request [RMQ RPC]": "Dispatch friend request via RabbitMQ",
    "friend.send_request {userId:A,recipientId:B}": "Dispatch friend request to recipient via RabbitMQ",
    "request_sent with new requestId": "Emit friend request sent notification",
    "POST /friends/requests/:requestId/accept": "Submit friend request acceptance",
    "POST /friends/requests/:id/accept": "Submit friend request acceptance",
    "friend.accept_request {userId:B,requestId}": "Process friend request acceptance via RabbitMQ",
    "findById(requestId)": "Query existing friend request by ID",
    "Verify target user exists and not blocked": "Verify target user exists and neither user is blocked",
    "Create pending friendship record": "Insert pending friendship record in database",
    "POST /friends/accept": "Accept pending friend request",
    "friend.accept_request [RMQ RPC]": "Dispatch friend accept via RabbitMQ",
    "Update friendship status to ACCEPTED": "Update friendship status to ACCEPTED in database",
    "friends + requestId + optional<br>conversationId": "Confirmed friendship record, request ID<br>and optional conversation channel",
    "friends + requestId + optional conversationId": "Confirmed friendship record, request ID and optional conversation channel",

    # 24 Friend removal
    "POST /friends/unfriend": "Remove existing friendship relationship",
    "friend.remove_friend [RMQ RPC]": "Process unfriend request via RabbitMQ",
    "friend.remove {authenticated<br>userId,friendUserId}": "Remove friendship record between users<br>via RabbitMQ RPC",
    "friend.remove {authenticated userId,friendUserId}": "Remove friendship record between users via RabbitMQ RPC",
    "POST /friends/requests/:requestId/reject": "Reject pending friend invitation",
    "friend.reject_request {authenticated userId,requestId}": "Process request rejection via RabbitMQ",
    "Transaction delete PENDING request where recipientId=actor": "Atomically delete pending invitation from database",
    "DELETE /friends/requests/:requestId": "Cancel outbound friend request",
    "friend.cancel_request {authenticated userId,requestId}": "Process request cancellation via RabbitMQ",
    "Transaction delete PENDING request where requesterId=actor": "Atomically delete pending invitation from database",
    "DELETE /friends/:userId": "Remove friendship relationship",
    "friend.remove_friend {authenticated userId,targetId}": "Process unfriend request via RabbitMQ",
    "Transaction delete canonical pair + reverse pair": "Atomically delete friendship and reciprocal relation",
    "Delete friendship record from database": "Delete friendship record from database",

    # 25 Friend block
    "POST /friends/block": "Block target user",
    "POST /friends/:userId/block": "Submit block request for target user",
    "friend.block_user [RMQ RPC]": "Process user block via RabbitMQ",
    "findPublicUsersByIds([blockedUserId ])": "Query public profile for blocked user",
    "findPublicUsersByIds([blockedUserId])": "Query public profile for blocked user",
    "Transaction: upsert directed block + delete canonical relati": "Record block relationship and dissolve friendship",
    "Transaction: upsert directed block + delete canonical relation": "Record block relationship and dissolve friendship",
    "Transaction: upsert directed block": "Record block relationship and dissolve friendship",
    "{userId,blocked:true,message}": "Confirm user successfully blocked",
    "Insert block record and invalidate social cache": "Insert block record and invalidate cached friend relationships",

    # 26 User recommendation
    "GET /users/recommended": "Query recommended user profiles",
    "GET /users/recommended?limit&feedSes sionId": "Request personalized user recommendations",
    "GET /users/recommended?limit&feedSessionId": "Request personalized user recommendations",
    "user.get_recommendations [RMQ RPC]": "Request graph user recommendations via RabbitMQ",
    "user.get_recommended_public(view erId,limit,feedSessionId)": "Compute candidate user recommendations for viewer",
    "user.get_recommended_public(viewerId, limit, feedSessionId)": "Compute candidate user recommendations for viewer",
    "user.get_recommended_public(viewerId,limit,feedSessionId)": "Compute candidate user recommendations for viewer",
    "Query mutual friends and interest graph": "Traverse social graph for mutual connections and topic affinities",
    "Return ranked recommended users": "Return ranked list of recommended user profiles",

    # 27 Upload & retry
    "POST /media/upload-url\n{purpose: reel, fileType, publishIntentId}": "Request upload authorization & presigned URL\n(Reel intent, file type)",
    "Authenticated media.get_presigned_url RPC": "Request upload lease & presigned URL via RPC",
    "Reserve user + intent + deterministic key\n24-hour source lease": "Reserve 24-hour deterministic upload lease",
    "Key advisory lock; reject cleanup claim / retired key": "Acquire advisory lock and protect key against cleanup",
    "Conditional presign: URL + key + expiresIn: 300": "Return presigned upload URL (5-min expiry)",
    "Retain presign checkpoint": "Save upload checkpoint in local storage",
    "PUT retained original; If-None-Match: *": "Upload raw video directly to Cloudflare R2",
    "2xx or 412 already present": "Confirm video uploaded (Success or already exists)",
    "POST /content/reels\n{publishIntentId, mediaKey, immutable publish payload}": "Submit Reel publication with intent ID and media key",
    "Authenticated userId + validated DTO via RPC": "Forward validated Reel submission to Content Service",
    "Find UNIQUE(userId, publishIntentId)": "Check for existing Reel by user and publish intent",
    "Canonical existing Reel; preserve all processing state": "Return existing canonical Reel (Idempotent replay)",
    "409 Conflict; never reset or create another Reel": "Reject conflicting publish payload (HTTP 409 Conflict)",
    "Transaction: Reel + initial media outbox + lease adoption\nDB UNIQUE(userId, publishIntentId)": "Atomically commit Reel record, adopt lease, and queue outbox job",
    "Canonical created Reel": "Reel successfully created in database",
    "After rollback, load winner by user + intent": "Concurrent race detected: Load winning canonical Reel",
    "Canonical Reel acknowledgement": "Acknowledge canonical Reel record",
    "Canonical reelId": "Deliver confirmed Reel ID to mobile creator",

    # 28 Media processing
    "SOURCE_VIDEO job + mediaAttemptId": "Deliver source video transcode job from queue",
    "Claim current media attempt; lease / retry fences": "Claim processing lease for current transcode attempt",
    "Download + validate source; apply requested trim / crop; transcode HLS": "Download video, apply trim/crop filters, and transcode to HLS",
    "Upload immutable attempt-scoped HLS playlists / segments and thumbnail": "Upload HLS playlists, segments, and thumbnail to Cloudflare R2",
    "persist_reel_media_completed\nvalidated keys + playback metadata + attempt": "Commit HLS playback assets and playback metadata",
    "ATOMIC: media COMPLETED; index PENDING; MEDIA_READY\nHLS / thumbnail keys + EXISTING_HLS evidence outbox": "Atomically mark Reel MEDIA_READY and queue evidence outbox job",
    "Applied or stale result": "Confirm media status updated to ready for playback",
    "Return / ACK (applied or stale)": "Acknowledge transcode job to RabbitMQ queue",
    "Claim committed evidence outbox": "Dispatcher claims pending multimodal evidence job",
    "Publish EXISTING_HLS job; durable retry on delivery failure": "Publish EXISTING_HLS evidence extraction job to RabbitMQ",
    "Separate evidence delivery; survives restart / redelivery": "Deliver multimodal evidence extraction job to worker",
    "Claim evidenceOnly on completed media; same attempt fencing": "Claim evidence lease against completed media attempt",
    "Materialize validated HLS; extract / segment audio; upload manifest": "Extract audio track from validated HLS and upload audio manifest",
    "Extract visual frames; upload checksummed visual manifest": "Extract keyframes and upload checksummed visual manifest",
    "persist_reel_hls_evidence_completed\nmanifest keys; preserve original source metadata": "Commit audio and visual evidence manifests",
    "ATOMIC: evidence metadata + one logical indexing outbox": "Atomically commit evidence manifests and queue indexing outbox job",
    "Reliably publish indexing job from outbox": "Dispatcher publishes indexing job to RabbitMQ queue",
    "Index job with available audio / visual manifest dependencies": "Deliver indexing job to Reel Indexing Service",

    # 29 Index normal
    "reel.index.process versioned job": "Deliver Reel indexing job from RabbitMQ",
    "Get attempt checkpoint": "Fetch checkpoint to resume indexing attempt",
    "Return DUPLICATE; skip pipeline": "Attempt already completed (Acknowledge and skip)",
    "content.claim_reel_indexing_attempt [RMQ RPC]": "Claim indexing attempt lease via Content Service RPC",
    "claimed boolean": "Return attempt lease claim status",
    "Return STALE; skip pipeline": "Attempt expired or stale (Acknowledge and skip)",
    "startOrResume(job)": "Initialize or resume attempt state record",
    "GET audio manifest only to infer missing hasAudio metadata": "Fetch audio manifest to verify audio stream properties",
    "Classify route NO_AUDIO / SHORT / LONG": "Classify processing route: NO_AUDIO, SHORT, or LONG",
    "GET frame bytes and verify SHA256 inside loop": "Download keyframe image bytes and verify SHA256 checksum",
    "ai.analyze_visual_frame(imageBase 64,timestampMs)": "Analyze visual frame content (Scene captions, OCR, objects)",
    "ai.analyze_visual_frame(imageBase64,timestampMs)": "Analyze visual frame content (Scene captions, OCR, objects)",
    "Visual caption/OCR/objects and provenance": "Return structured frame description, objects, and OCR",
    "Successful or optional-skipped visual branch sets visualReady": "Mark visual analysis checkpoint complete",
    "Metadata-only sections=[]; set transcriptReady; no ASR": "Bypass speech ASR; use creator metadata and visual OCR",
    "Preserve strong creator metadata locally": "Retain author title, description, and tags locally",
    "ai.extract_reel_metadata(original transcript or rollup)": "Extract unified Reel summary, keywords, and topics via LLM",
    "Metadata; creator-authored fields stay authoritative": "Return extracted metadata; creator fields remain primary",
    "Save extracted metadata and sections": "Checkpoint extracted metadata and transcript sections",
    "ai.count_document_tokens(model,id +retrievalText) per token-gate batch": "Validate chunk token counts against embedding context limit",
    "ai.count_document_tokens(model,id+retrievalText) per token-gate batch": "Validate chunk token counts against embedding context limit",
    "Exact document token counts": "Return verified document chunk token counts",
    "Persist token-validated/reversioned drafts": "Persist validated chunk drafts in checkpoint store",
    "Find reusable embeddings by full content/model identity": "Query cache for reusable embeddings by chunk hash and model",
    "ai.generate_embedding_batch missing drafts (configured batches)": "Generate 768-dim vector embeddings for uncached chunks via TEI",
    "Vectors, model identity and item errors": "Return normalized vector embeddings and model metadata",
    "Save valid reusable embeddings in R2 staging": "Stage reusable vector embeddings in Cloudflare R2",
    "Stage vector bundle to R2 + persist SQL candidate & journal": "Stage complete vector bundle to R2 & record candidate journal in DB",

    # 30 Index resume
    "Resume attempt from last verified checkpoint": "Resume attempt processing from last verified checkpoint",
    "Extend attempt lease in Content Service": "Extend indexing attempt lease in Content Service",
    "Fence stale attempt delivery": "Reject stale attempt result from superseded worker",
    "transcribeAudioKey(artifactKey, prompt)": "Transcribe segmented audio via Whisper speech model",

    # 31 Index commit
    "POST /internal/index/commit": "Trigger atomic candidate index activation",
    "content.is_reel_indexing_attempt_cu rrent(reelId, attemptId)": "Verify indexing attempt is active and current",
    "content.is_reel_indexing_attempt_current(reelId, attemptId)": "Verify indexing attempt is active and current",
    "Finalize under lock: delete obsolete rows; verify Qdrant poi": "Finalize under lock: Prune obsolete rows & verify Qdrant points",
    "Finalize under lock: delete obsolete rows; verify Qdrant points": "Finalize under lock: Prune obsolete rows & verify Qdrant points",
    "Finalize under lock: delete obsolete<br>rows; verify Qdrant points; purge R2 staged vectors": "Finalize under lock: Prune obsolete<br>records, verify vector points & purge staging",
    "Finalize under lock: delete obsolete rows; verify Qdrant points; purge R2 staged vectors": "Finalize under lock: Prune obsolete records, verify vector points & purge staging",
    "Activate candidate Qdrant collection": "Switch active collection alias to candidate in Qdrant",
    "Update Reel indexStatus to COMPLETED": "Mark Reel indexStatus COMPLETED in database",
    "Rollback candidate collection on error": "Rollback candidate collection and restore active alias on failure",

    # 32 Feed
    "GET /content/reels/recommended;\ncursor/session/": "Request recommended reels feed page\n(Cursor & session ID)",
    "GET /content/reels/recommended;<br>cursor/session/": "Request recommended reels feed page\n(Cursor & session ID)",
    "content.get_recommended_reels(vie<br>werId, query)": "Forward feed recommendation query to Content Service",
    "content.get_recommended_reels(viewerId, query)": "Forward feed recommendation query to Content Service",
    "Launch void<br>refillPersonalizedSession().catch(": "Trigger asynchronous background feed session refill",
    "tryAcquireRefillLock; TTL 60s": "Acquire distributed Redis refill lock (60-second TTL)",
    "Await getFeedAudience(viewerId)": "Query viewer friend network and audience exclusions",
    "Excluded user IDs and friend IDs": "Return blocked author IDs and audience filters",
    "Read latest session; preserve<br>viewer/version bi": "Read active feed session cache from Redis",
    "Save audience exclusions;<br>refillComplete=false": "Update audience exclusions and mark refill in-progress",
    "Collect enabled candidates with<br>audience/seen e": "Retrieve candidate reels excluding seen and blocked items",
    "findViewerInterestTags(viewerId, 20)": "Retrieve viewer interest profile and affinity tags",
    "Rank pipeline; append unseen<br>IDs only": "Score and rank candidates, filtering previously seen reels",
    "Save entities and refilled session;<br>refillCompl": "Append ranked reels to session cache and mark refill complete",
    "finally: releaseRefillLock(sessionId,<br>lockToken": "Release distributed Redis refill lock",
    "items + nextCursor + feedSessionId + algorithmVers": "Return paged feed items, next cursor, and session ID",
    "HTTP feed page": "Deliver recommended feed page to mobile viewer",

    # 33 Cache invalidation
    "Publish reel.updated event": "Publish reel.updated event to RabbitMQ fanout",
    "Evict cached Reel detail from Redis": "Evict cached Reel record from Redis",
    "Invalidate affected user feed sessions": "Invalidate cached feed sessions referencing modified Reel",

    # 34 Playback & HLS
    "Canonical reelId after upload / create ACK\nretained original + trim / crop + owner / device": "Save local playback registration\n(Retained original video, trim/crop, owner scope)",
    "Resolve source for current authenticated owner": "Resolve playback source for current authenticated owner",
    "Use retained original URI with existing trim / crop renderer": "Play retained local original video with client-side crop/trim",
    "Existing cached HLS manifest source": "Play cached offline HLS manifest source",
    "Validated hlsMaster / stream URL": "Play validated remote HLS master stream",
    "Native HLS playback directly; no Gateway byte proxy": "Stream HLS segments directly from CDN / Cloudflare R2",
    "Existing TanStack status query": "Poll Reel processing status via HTTP GET",
    "Media and indexing statuses remain distinct": "Return Reel mediaStatus and indexStatus flags",
    "Prefer validated HLS; safely replace the existing coordinated player source": "Seamlessly transition player source to validated remote HLS",

    # 35 Series management
    "POST /content/series (authenticated owner)": "Create new Reel Series with title & visibility",
    "content.create_reel_series(ownerId, payload)": "Dispatch series creation to Content Service via RPC",
    "Create Series with owner/title/description/visibility": "Insert Series record with episodes in database",
    "PATCH /content/series/:id": "Update Series metadata and episode ordering",
    "Transaction: recheck owner; update<br>Series metadata": "Verify series ownership and update<br>series metadata in database",
    "content.update_reel_series(ownerId, payload)": "Dispatch series update to Content Service via RPC",
    "content.add_reel_to_series(ownerId, reelIds)": "Append selected Reel to series playlist",
    "content.add_reel_to_series(ownerId, reelId)": "Append selected Reel to series playlist",
    "DELETE /content/series/:id/reels/:reelId": "Request episode removal from series",
    "Serializable detach:<br>seriesId/episodeNumber=null;<br>normalize remaining numbering": "Detach Reel from series and renumber<br>remaining episodes sequentially",
    "content.remove_reel_from_series(ow nerId, reelId)": "Remove Reel episode from series in Content Service",
    "content.remove_reel_from_series(ownerId, reelId)": "Remove Reel episode from series in Content Service",
    "content.reorder_series_episodes(ownerId, reelIds)": "Reorder series episodes in Content Service",
    "content.reorder_reel_series(ownerId,<br>full reelIds)": "Reorder series episode sequence<br>in Content Service",
    "content.reorder_reel_series(ownerId, full reelIds)": "Reorder series episode sequence in Content Service",

    # 36 Series playback
    "GET /content/series/:id/episodes; aroundReelId or directional cursor": "Request series episodes around current reel",
    "content.get_reel_series_episodes(vi ewerId, isAdmin, query)": "Fetch series episodes from Content Service",
    "content.get_reel_series_episodes(viewerId, isAdmin, query)": "Fetch series episodes from Content Service",
    "Read Series metadata by id; missing -> NotFound": "Lookup Series metadata in database",
    "friend.can_view_reel_content(viewerI d, ownerId, visibility)": "Verify viewer friendship and series visibility",
    "friend.can_view_reel_content(viewerId, ownerId, visibility)": "Verify viewer friendship and series visibility",
    "Increment sheet session; present()": "Present episode selection sheet",
    "handleEpisodeSelect(reelId)": "User selects target episode from series list",
    "pendingSelectedReelIdRef = reelId": "Store selected episode in local component state",
    "dismiss()": "Dismiss episode selection sheet",
    "onDismiss -> handleEpisodeSheetDismiss()": "Trigger episode transition on sheet dismissal",
    "Clear pending; set activeRef, playingReelId, selectedReelId": "Update active player reference and start playback",

    # 37 Sharing direct / AI
    "POST /content/reels/:id/share": "Share Reel to chat conversation or AI assistant",
    "content.share_reel(sharer, conversation, target)": "Dispatch Reel share request via RabbitMQ",
    "Find Reel; require mediaStatus=COMPLETED + validated hlsMasterKey": "Verify Reel exists and mediaStatus is COMPLETED",
    "shareReel upsert with<br>messageId=null; may return existing<br>linked share": "Create share record without message binding<br>(or return existing active share)",
    "shareReel upsert with messageId=null; may return existing linked share": "Create share record without message binding (or return existing active share)",
    "shareReel upsert with messageId=null; may return existing li": "Create share record without message binding",
    "updateReelShareMessageId(share.i d, message.id)": "Bind shared Reel record to sent message ID",
    "updateReelShareMessageId(share.id, message.id)": "Bind shared Reel record to sent message ID",
    "ReelShareResponse incl messageId and optional message": "Return shared Reel response with message link",
    "get_conversation_detail(conversatio nId, sharer)": "Fetch conversation participants and permissions",
    "get_conversation_detail(conversationId, sharer)": "Fetch conversation participants and permissions",
    "GET<br>/conversations/:id/messages/around/<br>:messageId (before=1, after=1)": "Fetch contextual messages around<br>shared Reel in conversation",
    "GET /conversations/:id/messages/around/ :messageId (before=1": "Fetch contextual messages around shared Reel",
    "GET /conversations/:id/messages/around/:messageId (before=1": "Fetch contextual messages around shared Reel",
    "get_messages_around(userId, conversationId, messageId)": "Retrieve adjacent message thread for Reel context",

    # 38 Sharing public link
    "POST /content/reels/:id/share-link": "Create public sharing link for Reel",
    "content.create_reel_share_link(creat edBy, reuseExisting, expiresInDays)": "Generate unique public share link in Content Service",
    "content.create_reel_share_link(createdBy, reuseExisting, expiresInDays)": "Generate unique public share link in Content Service",
    "findReelShareLinkByToken(token)": "Query shared Reel access link by public token",
    "Find active Reel+creator link at now": "Check for existing active public share link",
    "Reuse existing link": "Return existing active share link URL",

    # 39 RAG retrieval
    "send_message(text, conversationId, clientMessageId)": "Send chat question with shared Reel in conversation",
    "ai.stream_question(message, userId, conversationId, answerMemory)": "Stream question with conversation history to AI Service",
    "content.resolve_reel_context_access (conversationId, userId)": "Verify user authorization for shared Reels in conversation",
    "content.resolve_reel_context_access(conversationId, userId)": "Verify user authorization for shared Reels in conversation",
    "Conversation-scoped shares with media/index COMPLETED; distinct Reel IDs": "Query authorized, media-ready and indexed Reel IDs",
    "Scoped ready/indexed shared IDs; lookup failure -> []": "Return list of authorized and indexed Reel IDs",
    "Semantic query routing (bounded primary/fallback policy)": "Route query intent: REEL_GROUNDED, GENERAL_CHAT, or NO_CONTEXT",
    "Route decision (or router unavailable error)": "Return routing decision",
    "Use source-specific deterministic retrieval plan": "Apply source-specific deterministic retrieval configuration",
    "Structured retrieval planner; failure -> NONE": "Plan retrieval parameters (search limit, rerank limit, threshold)",
    "Normalized plan / fail-closed diagnostics": "Return validated retrieval plan",
    "POST /embed; RETRIEVAL_QUERY; validate vector model/version/dimensions": "Generate 768-dim query embedding vector via TEI",
    "Normalized vector + identity": "Return normalized query embedding vector",
    "index.search_chunks(scoped IDs, sourceOrder=ASC, limit=1); hydrate scoped evidence": "Search top-K vector chunks in Qdrant scoped to authorized Reel IDs",
    "POST /rerank; planned rerankLimit; bounded TEI retries": "Rerank retrieved chunks with cross-encoder reranking model",
    "Rerank scores": "Return cross-encoder relevance scores",
    "Slice retrieved candidates to rerankLimit": "Filter and retain top reranked candidate chunks",
    "index.get_adjacent_chunks(chunkId, reelId, parentId, eligible IDs, requiredIndexVersion, limit=2)": "Fetch adjacent chunks for temporal and narrative context expansion",
    "index.get_reel_document(item.reelId )": "Fetch Reel document metadata and scene summaries",
    "index.get_reel_document(item.reelId)": "Fetch Reel document metadata and scene summaries",
    "retrievalReady=true; answer-context join": "Join grounded evidence chunks with user conversation turn",

    # 40 RAG memory
    "Read last 20 messages; exclude current question/recalled/signals; retain eligibl": "Read last 20 messages from MongoDB conversation history",
    "answerMemory = last 12 eligible recent messages": "Select bounded recent turn window (12 eligible messages)",
    "Read conversation summary by conversationId": "Fetch progressive conversation summary from database",
    "Generate RETRIEVAL_QUERY embedding": "Generate retrieval embedding for conversation history query",
    "Read bounded user pool; lexical rank; relevant slice or high-confidence fallback": "Lexically rank and select most relevant conversation memory turns",
    "markUsed(selected IDs); return up to 8 selected memories": "Mark memories as referenced; return up to 8 memories",
    "summarizeTurn(existingSummary,<br>completed recentMessages, user +<br>assistant)": "Synthesize rolling turn summary<br>with memory agent",
    "summarizeTurn(existingSummary, completed recentMessages, use": "Synthesize rolling turn summary with memory agent",
    "Estimate<br>messageCount=max(completed<br>recentMessages.length + 2, 2)": "Compute bounded message count<br>for context window estimation",
    "Estimate messageCount=max(completed recentMessages.length +": "Compute bounded message count for context window estimation",

    # 41 RAG answer
    "Increment retryCount; set nextDraftSource=VERIFIER_RE VISION; clear citations": "Request targeted factual revision from Verifier Agent",
    "Increment retryCount; set nextDraftSource=VERIFIER_REVISION; clear citations": "Request targeted factual revision from Verifier Agent",
    "Coverage NOT_REQUIRED=1; provider NOT_CALLED": "General conversation: Skip evidence verification",
    "Structured citation attribution: question/answer/claims/candidates, max 3 citati": "Attribute grounded citations to source evidence chunks (max 3)",
    "Claims/evidence selections; exact IDs filtered": "Return verified factual claims and matched citation chunk IDs",
    "Increment citationRetryCount; clear coverage/citations; request factual-claim re": "Retry answer generation to ground unverified factual claim",
    "Citation gate -> finalAnswerNode": "Grounded citations validated: Transition to answer delivery",
    "Local no-context answer; citations=[]; coverage NOT_REQUIRED; no drafting/verifier happy path": "Deliver no-context guidance answer directly",
    "ai.stream_token: at most 80 UTF-16 code units per existing-answer chunk": "Publish streamed token delta via RabbitMQ",
    "generateResponseStream(systemPr ompt, userMessage, callback)": "Stream grounded answer generation from LLM",
    "generateResponseStream(systemPrompt, userMessage, callback)": "Stream grounded answer generation from LLM",
    "ai.stream_token: callback token (no universal 80-unit bound)": "Publish streamed token delta via RabbitMQ",
    "Generated answer string": "LLM generation complete: Final answer text",
    "ai.stream_question final RPC response: answer/citations/metadata (or error)": "Return completed answer, verified citations, and trace metadata",
    "Await createMessage(assistant text + citations/recommendation metadata)": "Persist assistant response and verified citations in MongoDB",
    "Saved durable assistant": "Assistant message persisted in conversation store",
    "Callback new_message(saved assistant DTO with final metadata)": "Deliver completed message event with citation metadata",
    "bot_token(conversationId, token)": "Push real-time token to client over WebSocket",
    "ai.stream_token(conversationId, userId, token)": "Relay stream token to conversation channel",

    # 42 Observability
    "Allocate productionExecutionId = randomUUID()": "Allocate unique production trace execution ID",
    "withRoot(metadata, operation); root is created here": "Initialize root Langfuse observation trace span",
    "startActiveObservation(rag.workflow) ; propagate trace/session/release metadata": "Start active workflow trace with metadata propagation",
    "startActiveObservation(rag.workflow); propagate trace/session/release metadata": "Start active workflow trace with metadata propagation",
    "root.update: bounded input; capture query only if captureContent": "Record sanitized query inputs in trace span",
    "root.update(redacted output; schema rag-monitoring-v1)": "Export trace span with sanitized RAG metadata",
    "observations.getMany(name=rag.wo<br>rkflow, fields=basic,time,io, limit=100,<br>filters, cursor)": "Query RAG workflow trace observations<br>from Langfuse with bounded pagination",
    "observations.getMany(name=rag.wo rkflow, fields=basic,time,i": "Query RAG execution observations from Langfuse",
    "observations.getMany(name=rag.workflow, fields=basic,time,i": "Query RAG execution observations from Langfuse",
    "Decode monitoring snapshot;<br>attach traceId, observationId,<br>startTime": "Decode monitoring snapshot and attach<br>trace and observation identifiers",
    "Decode monitoring snapshot; attach traceId, observationId, s": "Decode trace payload and attach observation identifiers",
}

APP_ARCH_REPLACEMENTS = {
    "entry-label": "Client Ingress<br>(REST / Socket.IO)",
    "rest-label": "REST API Proxy",
    "socket-label": "Realtime Socket.IO",
    "gateway-rmq-label": "RabbitMQ Service RPC",
    "conversation-rmq-label": "RabbitMQ AI RPC / Events",
    "rpc-auth-label": "Auth RPC",
    "rpc-user-label": "User RPC",
    "rpc-friend-label": "Friend RPC",
    "rpc-content-label": "Content RPC",
    "rpc-ai-label": "AI Orchestration RPC",
    "rpc-media-label": "Media Lease RPC",
    "media-jobs-label": "Media Transcode Queue",
    "index-jobs-label": "Reel Indexing Queue",
    "inference-label": "LLM & Vision APIs<br>(Groq / Cloudflare)",
    "embedding-label": "TEI Embedding & Rerank<br>(HTTP Microservices)",
    "ai-tracing-label": "Langfuse Observability<br>(OTEL Traces)",
    "direct-media-label": "Direct S3 Upload<br>& HLS Stream Delivery",
    "media-r2-label": "Cloudflare R2<br>Object Storage",
    "index-r2-label": "R2 Evidence Artifacts<br>(Audio & Keyframes)",
    "content-cache-label": "Redis Cache &<br>Feed Sessions",
    "auth-sql-label": "Auth PostgreSQL DB",
    "conversation-mongo-label": "MongoDB Chat Store<br>(Turns & Citations)",
    "index-db-label": "Qdrant Vector DB &<br>PostgreSQL Index Store",
}

def clean_text(s):
    return html.unescape(re.sub('<[^<]+?>', ' ', s)).strip()

def update_steps_recursive(steps):
    for s in steps:
        if s.get('type') == 'message':
            lbl = s.get('label', '')
            for old, new in REPLACEMENTS.items():
                if old in lbl or clean_text(old) == clean_text(lbl):
                    s['label'] = new
                    break
        elif s.get('type') == 'frame':
            for op in s.get('operands', []):
                update_steps_recursive(op.get('steps', []))

def modernize_tree(root):
    for d in root.findall('diagram'):
        did = d.attrib.get('id')
        mx = d.find('mxGraphModel')
        if mx is None:
            continue

        # 1. Update semanticModel
        sm_str = mx.attrib.get('semanticModel')
        if sm_str:
            try:
                sm = json.loads(sm_str)
                if 'steps' in sm:
                    update_steps_recursive(sm['steps'])
                mx.set('semanticModel', json.dumps(sm, ensure_ascii=False, separators=(',', ':')))
            except Exception as e:
                pass

        # 2. Update mxCells
        r = mx.find('root')
        if r is None:
            continue

        for c in r.findall('mxCell'):
            cid = c.attrib.get('id', '')
            val = c.attrib.get('value', '')

            # Application architecture labels
            if cid in APP_ARCH_REPLACEMENTS:
                c.set('value', APP_ARCH_REPLACEMENTS[cid])
                continue

            # Sequence diagram edges
            if c.attrib.get('edge') == '1' and val and 'dashed=1;endArrow=none' not in c.attrib.get('style', ''):
                matched = False
                for old, new in REPLACEMENTS.items():
                    if old in val or clean_text(old) == clean_text(val):
                        plain_new = new.replace('<br>', '\n')
                        c.set('value', html.escape(plain_new).replace('\n', '<br>'))
                        matched = True
                        break

            # Normalize self-call geometry and offset to be snug (10px from loop)
            if c.attrib.get('edge') == '1' and c.attrib.get('fromParticipant') and c.attrib.get('fromParticipant') == c.attrib.get('toParticipant'):
                geom = c.find('mxGeometry')
                if geom is not None:
                    sp = geom.find('mxPoint[@as="sourcePoint"]')
                    tp = geom.find('mxPoint[@as="targetPoint"]')
                    if sp is not None and tp is not None:
                        x = float(sp.attrib.get('x', '0'))
                        y = float(sp.attrib.get('y', '0'))
                        tp.set('y', str(y + 28))
                        pts = geom.find('Array[@as="points"]')
                        if pts is None:
                            pts = ET.SubElement(geom, 'Array', **{'as': 'points'})
                        else:
                            pts.clear()
                        ET.SubElement(pts, 'mxPoint', x=str(x + 40), y=str(y))
                        ET.SubElement(pts, 'mxPoint', x=str(x + 40), y=str(y + 28))
                        offset = geom.find('mxPoint[@as="offset"]')
                        if offset is None:
                            offset = ET.SubElement(geom, 'mxPoint', **{'as': 'offset'})
                        offset.set('x', '10')
                        offset.set('y', '-10')
                        style = c.attrib.get('style', '')
                        if 'edgeStyle=orthogonalEdgeStyle' not in style:
                            c.set('style', style + ';edgeStyle=orthogonalEdgeStyle;curved=0;rounded=0;orthogonalLoop=1;jettySize=auto;labelBackgroundColor=#ffffff;labelWidth=240;whiteSpace=wrap;align=left;')

def main():
    print("Reading velora-architecture.drawio...")
    tree = ET.parse(ARCH_DRAWIO)
    root = tree.getroot()

    print("Modernizing labels across all diagrams...")
    modernize_tree(root)

    # Save back
    doc_text = ET.tostring(root, encoding='unicode')
    ARCH_DRAWIO.write_text(doc_text)
    print("Saved velora-architecture.drawio")

    # Update standalone SVGs in importable-svg
    print("Updating importable-svg files...")
    for page in root.findall('diagram'):
        pid = page.attrib.get('id')
        svg_file = IMPORTABLE_DIR / f'{pid}.drawio.svg'
        if svg_file.exists():
            svg_text = svg_file.read_text()
            payload = '<mxfile host="app.diagrams.net" type="device">' + ET.tostring(page, encoding='unicode') + '</mxfile>'
            match = re.search(r'<svg\b[^>]*>', svg_text, re.S)
            if match:
                opening = re.sub(r'\scontent=\"[^\"]*\"', '', match.group(0))
                opening = opening[:-1] + f' content=\"{html.escape(payload, quote=True)}\">'

                body = svg_text[match.end():]
                # Replace visible text strings in SVG body only
                for old, new in REPLACEMENTS.items():
                    body = body.replace(html.escape(clean_text(old)), html.escape(clean_text(new)))
                    body = body.replace(clean_text(old), clean_text(new))

                new_svg = svg_text[:match.start()] + opening + body
                svg_file.write_text(new_svg)

    # Update combined SVG
    print("Updating velora-diagrams.drawio.svg...")
    combined_svg = COMBINED_SVG.read_text()
    match = re.search(r'<svg\b[^>]*>', combined_svg, re.S)
    if match:
        opening = re.sub(r'\scontent=\"[^\"]*\"', '', match.group(0))
        opening = opening[:-1] + f' content=\"{html.escape(doc_text, quote=True)}\">'
        COMBINED_SVG.write_text(combined_svg[:match.start()] + opening + combined_svg[match.end():])

    print("Modernization complete!")

if __name__ == '__main__':
    main()
