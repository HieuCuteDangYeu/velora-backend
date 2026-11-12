# Velora diagrams

Master file: `velora-architecture.drawio` (one page per diagram, in the order below). Each page is exported natively by draw.io to `importable-svg/<id>.drawio.svg` with its editable XML embedded; `velora-diagrams.drawio.svg` embeds the complete multi-page file.
Regenerate with `DRAWIO_BIN=<draw.io desktop> python3 scripts/diagrams/export_drawio_figures.py` and check with `python3 scripts/diagrams/validate_reel_exports.py`.

| # | Diagram | Export |
|---|---|---|
| 1 | 01 · Velora microservices architecture | [`01-microservices-architecture.drawio.svg`](importable-svg/01-microservices-architecture.drawio.svg) |
| 2 | 02 · Velora application architecture | [`02-application-architecture.drawio.svg`](importable-svg/02-application-architecture.drawio.svg) |
| 3 | 03 · D0 · Velora context | [`03-dfd-context.drawio.svg`](importable-svg/03-dfd-context.drawio.svg) |
| 4 | 04 · D1 · Main Velora subsystems | [`04-dfd-overview.drawio.svg`](importable-svg/04-dfd-overview.drawio.svg) |
| 5 | 05 · D2 · Account and access | [`05-dfd-auth.drawio.svg`](importable-svg/05-dfd-auth.drawio.svg) |
| 6 | 06 · D2 · Friendship lifecycle | [`06-dfd-social.drawio.svg`](importable-svg/06-dfd-social.drawio.svg) |
| 7 | 06a · D2 · User discovery | [`06a-dfd-user-recommendations.drawio.svg`](importable-svg/06a-dfd-user-recommendations.drawio.svg) |
| 8 | 07 · D2 · Reels and Series | [`07-dfd-content.drawio.svg`](importable-svg/07-dfd-content.drawio.svg) |
| 9 | 07a · D2 · Reel sharing | [`07a-dfd-sharing.drawio.svg`](importable-svg/07a-dfd-sharing.drawio.svg) |
| 10 | 08 · D2 · Upload and media publication | [`08-dfd-media.drawio.svg`](importable-svg/08-dfd-media.drawio.svg) |
| 11 | 08a · D2 · HLS playback | [`08a-dfd-streaming.drawio.svg`](importable-svg/08a-dfd-streaming.drawio.svg) |
| 12 | 09 · D2 · Searchable Reel evidence | [`09-dfd-index.drawio.svg`](importable-svg/09-dfd-index.drawio.svg) |
| 13 | 10 · D2 · Reel recommendations | [`10-dfd-reels.drawio.svg`](importable-svg/10-dfd-reels.drawio.svg) |
| 14 | 10a · D2 · Reel playback feedback | [`10a-dfd-feedback.drawio.svg`](importable-svg/10a-dfd-feedback.drawio.svg) |
| 15 | 10b · D2 · Semantic candidate discovery | [`10b-dfd-semantic-candidates.drawio.svg`](importable-svg/10b-dfd-semantic-candidates.drawio.svg) |
| 16 | 11 · D2 · Grounded AI answer | [`11-dfd-rag.drawio.svg`](importable-svg/11-dfd-rag.drawio.svg) |
| 17 | 11a · D2 · Durable AI memory | [`11a-dfd-memory.drawio.svg`](importable-svg/11a-dfd-memory.drawio.svg) |
| 18 | 12 · Identity and social entities | [`12-identity-social.drawio.svg`](importable-svg/12-identity-social.drawio.svg) |
| 19 | 13 · Reel, Series and sharing entities | [`13-content.drawio.svg`](importable-svg/13-content.drawio.svg) |
| 20 | 14 · Semantic evidence entities | [`14-semantic-hierarchy.drawio.svg`](importable-svg/14-semantic-hierarchy.drawio.svg) |
| 21 | 15 · Indexing attempt and reusable state | [`15-index-state.drawio.svg`](importable-svg/15-index-state.drawio.svg) |
| 22 | 16 · AI conversation, memory and shared-Reel entities | [`16-ai-conversation.drawio.svg`](importable-svg/16-ai-conversation.drawio.svg) |
| 23 | 17a · New user registration, saga compensation and confirmation email | [`17a-auth-registration-request.drawio.svg`](importable-svg/17a-auth-registration-request.drawio.svg) |
| 24 | 17b · Account confirmation with the emailed code | [`17b-auth-email-verification.drawio.svg`](importable-svg/17b-auth-email-verification.drawio.svg) |
| 25 | 18 · Login and session restoration | [`18-auth-login.drawio.svg`](importable-svg/18-auth-login.drawio.svg) |
| 26 | 19 · Google identity login | [`19-auth-google.drawio.svg`](importable-svg/19-auth-google.drawio.svg) |
| 27 | 20a · Standard refresh-token rotation | [`20a-auth-refresh-standard.drawio.svg`](importable-svg/20a-auth-refresh-standard.drawio.svg) |
| 28 | 20b · Concurrent 401s share one refresh request | [`20b-auth-refresh-deduplication.drawio.svg`](importable-svg/20b-auth-refresh-deduplication.drawio.svg) |
| 29 | 20c · Lost-response recovery and refresh replay protection | [`20c-auth-refresh-recovery-theft.drawio.svg`](importable-svg/20c-auth-refresh-recovery-theft.drawio.svg) |
| 30 | 21 · Protected resource authorization | [`21-auth-authorization.drawio.svg`](importable-svg/21-auth-authorization.drawio.svg) |
| 31 | 22 · Logout versus in-flight refresh | [`22-auth-logout.drawio.svg`](importable-svg/22-auth-logout.drawio.svg) |
| 32 | 23a · Send a friend request | [`23a-friend-send-request.drawio.svg`](importable-svg/23a-friend-send-request.drawio.svg) |
| 33 | 23b · Accept a friend request | [`23b-friend-accept-request.drawio.svg`](importable-svg/23b-friend-accept-request.drawio.svg) |
| 34 | 24a · Reject a friend request | [`24a-friend-reject-request.drawio.svg`](importable-svg/24a-friend-reject-request.drawio.svg) |
| 35 | 24b · Cancel a sent friend request | [`24b-friend-cancel-request.drawio.svg`](importable-svg/24b-friend-cancel-request.drawio.svg) |
| 36 | 24c · Remove a friend | [`24c-friend-unfriend.drawio.svg`](importable-svg/24c-friend-unfriend.drawio.svg) |
| 37 | 25 · Blocking and cache reconciliation | [`25-friend-block.drawio.svg`](importable-svg/25-friend-block.drawio.svg) |
| 38 | 26 · Graph user recommendation flow | [`26-user-recommendation.drawio.svg`](importable-svg/26-user-recommendation.drawio.svg) |
| 39 | 27a · Publish request, upload lease and video upload | [`27a-reel-upload-flow.drawio.svg`](importable-svg/27a-reel-upload-flow.drawio.svg) |
| 40 | 27b · Publish idempotency, fingerprint and race reconciliation | [`27b-reel-publish-idempotency.drawio.svg`](importable-svg/27b-reel-publish-idempotency.drawio.svg) |
| 41 | 28a · Source transcode and immediate HLS playback readiness | [`28a-media-playback-readiness.drawio.svg`](importable-svg/28a-media-playback-readiness.drawio.svg) |
| 42 | 28b · Durable multimodal evidence extraction and index handoff | [`28b-media-evidence-pipeline.drawio.svg`](importable-svg/28b-media-evidence-pipeline.drawio.svg) |
| 43 | 29a · Indexing attempt claim and route classification | [`29a-index-intake-routing.drawio.svg`](importable-svg/29a-index-intake-routing.drawio.svg) |
| 44 | 29b · Keyframe analysis, transcription and metadata extraction | [`29b-index-multimodal-extraction.drawio.svg`](importable-svg/29b-index-multimodal-extraction.drawio.svg) |
| 45 | 29c · Token gating, embedding generation and candidate staging | [`29c-index-vectorization-staging.drawio.svg`](importable-svg/29c-index-vectorization-staging.drawio.svg) |
| 46 | 29d · Daily retry for Reels indexed without visual scenes | [`29d-index-deferred-visual-retry.drawio.svg`](importable-svg/29d-index-deferred-visual-retry.drawio.svg) |
| 47 | 30a · Same-attempt resume without repeating finished work | [`30a-index-checkpoint-resume.drawio.svg`](importable-svg/30a-index-checkpoint-resume.drawio.svg) |
| 48 | 30b · Job outcome handling: acknowledge, retry or dead-letter | [`30b-index-failure-retry-dlq.drawio.svg`](importable-svg/30b-index-failure-retry-dlq.drawio.svg) |
| 49 | 31a · Candidate activation, Qdrant projection and completion | [`31a-index-atomic-activation.drawio.svg`](importable-svg/31a-index-atomic-activation.drawio.svg) |
| 50 | 31b · Rejected or failed activation: rollback and stale outcome | [`31b-index-rollback-recovery.drawio.svg`](importable-svg/31b-index-rollback-recovery.drawio.svg) |
| 51 | 32a · Feed paging from the cached session and first-page slate | [`32a-feed-cache-paging.drawio.svg`](importable-svg/32a-feed-cache-paging.drawio.svg) |
| 52 | 32b · Background refill: candidate pools, ranking and optional neural rerank | [`32b-feed-background-refill.drawio.svg`](importable-svg/32b-feed-background-refill.drawio.svg) |
| 53 | 33 · Versioned Reel cache invalidation versus stale fill | [`33-cache-invalidation.drawio.svg`](importable-svg/33-cache-invalidation.drawio.svg) |
| 54 | 34a · Owner-local preview before the validated stream is ready | [`34a-hls-owner-preview.drawio.svg`](importable-svg/34a-hls-owner-preview.drawio.svg) |
| 55 | 34b · Status polling and the switch to the validated HLS stream | [`34b-hls-validated-stream.drawio.svg`](importable-svg/34b-hls-validated-stream.drawio.svg) |
| 56 | 35a · Create and update a Series | [`35a-series-create-update.drawio.svg`](importable-svg/35a-series-create-update.drawio.svg) |
| 57 | 35b · Add, remove and reorder Series episodes | [`35b-series-membership-order.drawio.svg`](importable-svg/35b-series-membership-order.drawio.svg) |
| 58 | 36a · Series episode page access and loading | [`36a-series-playback-entry.drawio.svg`](importable-svg/36a-series-playback-entry.drawio.svg) |
| 59 | 36b · Choosing an episode and loading further pages | [`36b-series-episode-switch.drawio.svg`](importable-svg/36b-series-episode-switch.drawio.svg) |
| 60 | 37a · Share a Reel with the Velora AI assistant | [`37a-share-to-ai-assistant.drawio.svg`](importable-svg/37a-share-to-ai-assistant.drawio.svg) |
| 61 | 37b · Share a Reel with another user or group | [`37b-share-to-user-chat.drawio.svg`](importable-svg/37b-share-to-user-chat.drawio.svg) |
| 62 | 38a · Create and revoke a public share link | [`38a-share-link-create-revoke.drawio.svg`](importable-svg/38a-share-link-create-revoke.drawio.svg) |
| 63 | 38b · Resolve a public share link | [`38b-share-link-resolution.drawio.svg`](importable-svg/38b-share-link-resolution.drawio.svg) |
| 64 | 39a · AI question entry, Reel scope and query routing | [`39a-rag-scope-routing.drawio.svg`](importable-svg/39a-rag-scope-routing.drawio.svg) |
| 65 | 39b · Retrieval planning, hybrid search, cross-encoder rerank and sufficiency | [`39b-rag-search-rerank.drawio.svg`](importable-svg/39b-rag-search-rerank.drawio.svg) |
| 66 | 40a · Bounded answer memory and memory selection for a question | [`40a-rag-answer-memory.drawio.svg`](importable-svg/40a-rag-answer-memory.drawio.svg) |
| 67 | 40b · Completed-turn memory: summary and long-term user memory | [`40b-rag-turn-memory-update.drawio.svg`](importable-svg/40b-rag-turn-memory-update.drawio.svg) |
| 68 | 41a · Draft, verify and cite the grounded answer | [`41a-rag-draft-verify-cite.drawio.svg`](importable-svg/41a-rag-draft-verify-cite.drawio.svg) |
| 69 | 41b · Stream the final answer and persist it | [`41b-rag-stream-delivery.drawio.svg`](importable-svg/41b-rag-stream-delivery.drawio.svg) |
| 70 | 42a · Langfuse trace capture around a RAG workflow run | [`42a-observability-trace-capture.drawio.svg`](importable-svg/42a-observability-trace-capture.drawio.svg) |
| 71 | 42b · Operator export and validation of RAG traces | [`42b-observability-trace-export.drawio.svg`](importable-svg/42b-observability-trace-export.drawio.svg) |
