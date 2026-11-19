# Velora diagrams

Master file: `velora-architecture.drawio` (one page per diagram, in the order below). Each page is exported natively by draw.io to `importable-svg/<id>.drawio.svg` with its editable XML embedded; `velora-diagrams.drawio.svg` embeds the complete multi-page file.
Rebuild in this order: `build_and_modernize_all_diagrams.py` (sequence pages, from `SPLIT_MODELS` and `sequence_models_extra.py`), `architecture_pages.py` (01, 02, 02a-02e), `patch_hand_pages.py` (DFD, ER and authorization edits), then `DRAWIO_BIN=<draw.io desktop> python3 scripts/diagrams/export_drawio_figures.py` and `python3 scripts/diagrams/validate_reel_exports.py`. `reanchor_evidence.py` moves cited line ranges after code changes.

| # | Diagram | Export |
|---|---|---|
| 1 | 01 · Velora high-level architecture | [`01-microservices-architecture.drawio.svg`](importable-svg/01-microservices-architecture.drawio.svg) |
| 2 | 02 · Service communication and durable job topology | [`02-application-architecture.drawio.svg`](importable-svg/02-application-architecture.drawio.svg) |
| 3 | 02a · Deployment topology | [`02a-deployment-topology.drawio.svg`](importable-svg/02a-deployment-topology.drawio.svg) |
| 4 | 02b · Release pipeline | [`02b-release-pipeline.drawio.svg`](importable-svg/02b-release-pipeline.drawio.svg) |
| 5 | 02c · Observability and operations | [`02c-observability-stack.drawio.svg`](importable-svg/02c-observability-stack.drawio.svg) |
| 6 | 02d · AI model and provider routing | [`02d-ai-model-routing.drawio.svg`](importable-svg/02d-ai-model-routing.drawio.svg) |
| 7 | 02e · Velora-Mobile client architecture | [`02e-mobile-client-architecture.drawio.svg`](importable-svg/02e-mobile-client-architecture.drawio.svg) |
| 8 | 03 · D0 · Velora context | [`03-dfd-context.drawio.svg`](importable-svg/03-dfd-context.drawio.svg) |
| 9 | 04 · D1 · Main Velora subsystems | [`04-dfd-overview.drawio.svg`](importable-svg/04-dfd-overview.drawio.svg) |
| 10 | 05 · D2 · Account and access | [`05-dfd-auth.drawio.svg`](importable-svg/05-dfd-auth.drawio.svg) |
| 11 | 06 · D2 · Friendship lifecycle | [`06-dfd-social.drawio.svg`](importable-svg/06-dfd-social.drawio.svg) |
| 12 | 06a · D2 · User discovery | [`06a-dfd-user-recommendations.drawio.svg`](importable-svg/06a-dfd-user-recommendations.drawio.svg) |
| 13 | 07 · D2 · Reels and Series | [`07-dfd-content.drawio.svg`](importable-svg/07-dfd-content.drawio.svg) |
| 14 | 07a · D2 · Reel sharing | [`07a-dfd-sharing.drawio.svg`](importable-svg/07a-dfd-sharing.drawio.svg) |
| 15 | 08 · D2 · Upload and media publication | [`08-dfd-media.drawio.svg`](importable-svg/08-dfd-media.drawio.svg) |
| 16 | 08a · D2 · HLS playback | [`08a-dfd-streaming.drawio.svg`](importable-svg/08a-dfd-streaming.drawio.svg) |
| 17 | 09 · D2 · Searchable Reel evidence | [`09-dfd-index.drawio.svg`](importable-svg/09-dfd-index.drawio.svg) |
| 18 | 10 · D2 · Reel recommendations | [`10-dfd-reels.drawio.svg`](importable-svg/10-dfd-reels.drawio.svg) |
| 19 | 10a · D2 · Reel playback feedback | [`10a-dfd-feedback.drawio.svg`](importable-svg/10a-dfd-feedback.drawio.svg) |
| 20 | 10b · D2 · Semantic candidate discovery | [`10b-dfd-semantic-candidates.drawio.svg`](importable-svg/10b-dfd-semantic-candidates.drawio.svg) |
| 21 | 11 · D2 · Grounded AI answer | [`11-dfd-rag.drawio.svg`](importable-svg/11-dfd-rag.drawio.svg) |
| 22 | 11a · D2 · Durable AI memory | [`11a-dfd-memory.drawio.svg`](importable-svg/11a-dfd-memory.drawio.svg) |
| 23 | 12 · Identity and social entities | [`12-identity-social.drawio.svg`](importable-svg/12-identity-social.drawio.svg) |
| 24 | 13 · Reel, Series and sharing entities | [`13-content.drawio.svg`](importable-svg/13-content.drawio.svg) |
| 25 | 14 · Semantic evidence entities | [`14-semantic-hierarchy.drawio.svg`](importable-svg/14-semantic-hierarchy.drawio.svg) |
| 26 | 15 · Indexing attempt and reusable state | [`15-index-state.drawio.svg`](importable-svg/15-index-state.drawio.svg) |
| 27 | 16 · AI conversation, memory and shared-Reel entities | [`16-ai-conversation.drawio.svg`](importable-svg/16-ai-conversation.drawio.svg) |
| 28 | 17a · New user registration, saga compensation and confirmation email | [`17a-auth-registration-request.drawio.svg`](importable-svg/17a-auth-registration-request.drawio.svg) |
| 29 | 17b · Account confirmation with the emailed code | [`17b-auth-email-verification.drawio.svg`](importable-svg/17b-auth-email-verification.drawio.svg) |
| 30 | 18 · Login and session restoration | [`18-auth-login.drawio.svg`](importable-svg/18-auth-login.drawio.svg) |
| 31 | 19 · Google identity login | [`19-auth-google.drawio.svg`](importable-svg/19-auth-google.drawio.svg) |
| 32 | 20a · Standard refresh-token rotation | [`20a-auth-refresh-standard.drawio.svg`](importable-svg/20a-auth-refresh-standard.drawio.svg) |
| 33 | 20b · Concurrent 401s share one refresh request | [`20b-auth-refresh-deduplication.drawio.svg`](importable-svg/20b-auth-refresh-deduplication.drawio.svg) |
| 34 | 20c · Lost-response recovery and refresh replay protection | [`20c-auth-refresh-recovery-theft.drawio.svg`](importable-svg/20c-auth-refresh-recovery-theft.drawio.svg) |
| 35 | 21 · Protected resource authorization | [`21-auth-authorization.drawio.svg`](importable-svg/21-auth-authorization.drawio.svg) |
| 36 | 22 · Logout versus in-flight refresh | [`22-auth-logout.drawio.svg`](importable-svg/22-auth-logout.drawio.svg) |
| 37 | 23a · Send a friend request | [`23a-friend-send-request.drawio.svg`](importable-svg/23a-friend-send-request.drawio.svg) |
| 38 | 23b · Accept a friend request | [`23b-friend-accept-request.drawio.svg`](importable-svg/23b-friend-accept-request.drawio.svg) |
| 39 | 24a · Reject a friend request | [`24a-friend-reject-request.drawio.svg`](importable-svg/24a-friend-reject-request.drawio.svg) |
| 40 | 24b · Cancel a sent friend request | [`24b-friend-cancel-request.drawio.svg`](importable-svg/24b-friend-cancel-request.drawio.svg) |
| 41 | 24c · Remove a friend | [`24c-friend-unfriend.drawio.svg`](importable-svg/24c-friend-unfriend.drawio.svg) |
| 42 | 25 · Blocking and cache reconciliation | [`25-friend-block.drawio.svg`](importable-svg/25-friend-block.drawio.svg) |
| 43 | 26 · Graph user recommendation flow | [`26-user-recommendation.drawio.svg`](importable-svg/26-user-recommendation.drawio.svg) |
| 44 | 27a · Publish request, upload lease and video upload | [`27a-reel-upload-flow.drawio.svg`](importable-svg/27a-reel-upload-flow.drawio.svg) |
| 45 | 27b · Publish idempotency, fingerprint and race reconciliation | [`27b-reel-publish-idempotency.drawio.svg`](importable-svg/27b-reel-publish-idempotency.drawio.svg) |
| 46 | 28a · Source transcode and immediate HLS playback readiness | [`28a-media-playback-readiness.drawio.svg`](importable-svg/28a-media-playback-readiness.drawio.svg) |
| 47 | 28b · Durable multimodal evidence extraction and index handoff | [`28b-media-evidence-pipeline.drawio.svg`](importable-svg/28b-media-evidence-pipeline.drawio.svg) |
| 48 | 29a · Indexing attempt claim and route classification | [`29a-index-intake-routing.drawio.svg`](importable-svg/29a-index-intake-routing.drawio.svg) |
| 49 | 29b · Keyframe analysis, transcription and metadata extraction | [`29b-index-multimodal-extraction.drawio.svg`](importable-svg/29b-index-multimodal-extraction.drawio.svg) |
| 50 | 29c · Token gating, embedding generation and candidate staging | [`29c-index-vectorization-staging.drawio.svg`](importable-svg/29c-index-vectorization-staging.drawio.svg) |
| 51 | 29d · Daily retry for Reels indexed without visual scenes | [`29d-index-deferred-visual-retry.drawio.svg`](importable-svg/29d-index-deferred-visual-retry.drawio.svg) |
| 52 | 30a · Same-attempt resume without repeating finished work | [`30a-index-checkpoint-resume.drawio.svg`](importable-svg/30a-index-checkpoint-resume.drawio.svg) |
| 53 | 30b · Job outcome handling: acknowledge, retry, rotate or dead-letter | [`30b-index-failure-retry-dlq.drawio.svg`](importable-svg/30b-index-failure-retry-dlq.drawio.svg) |
| 54 | 31a · Candidate activation, Qdrant projection and completion | [`31a-index-atomic-activation.drawio.svg`](importable-svg/31a-index-atomic-activation.drawio.svg) |
| 55 | 31b · Rejected or failed activation: rollback and stale outcome | [`31b-index-rollback-recovery.drawio.svg`](importable-svg/31b-index-rollback-recovery.drawio.svg) |
| 56 | 32a · Feed paging from the cached session and first-page slate | [`32a-feed-cache-paging.drawio.svg`](importable-svg/32a-feed-cache-paging.drawio.svg) |
| 57 | 32b · Background refill: candidate pools, ranking and optional neural rerank | [`32b-feed-background-refill.drawio.svg`](importable-svg/32b-feed-background-refill.drawio.svg) |
| 58 | 33 · Versioned Reel cache invalidation versus stale fill | [`33-cache-invalidation.drawio.svg`](importable-svg/33-cache-invalidation.drawio.svg) |
| 59 | 34a · Owner-local preview before the validated stream is ready | [`34a-hls-owner-preview.drawio.svg`](importable-svg/34a-hls-owner-preview.drawio.svg) |
| 60 | 34b · Status polling and the switch to the validated HLS stream | [`34b-hls-validated-stream.drawio.svg`](importable-svg/34b-hls-validated-stream.drawio.svg) |
| 61 | 35a · Create and update a Series | [`35a-series-create-update.drawio.svg`](importable-svg/35a-series-create-update.drawio.svg) |
| 62 | 35b · Add, remove and reorder Series episodes | [`35b-series-membership-order.drawio.svg`](importable-svg/35b-series-membership-order.drawio.svg) |
| 63 | 36a · Series episode page access and loading | [`36a-series-playback-entry.drawio.svg`](importable-svg/36a-series-playback-entry.drawio.svg) |
| 64 | 36b · Choosing an episode and loading further pages | [`36b-series-episode-switch.drawio.svg`](importable-svg/36b-series-episode-switch.drawio.svg) |
| 65 | 37a · Share a Reel with the Velora AI assistant | [`37a-share-to-ai-assistant.drawio.svg`](importable-svg/37a-share-to-ai-assistant.drawio.svg) |
| 66 | 37b · Share a Reel with another user or group | [`37b-share-to-user-chat.drawio.svg`](importable-svg/37b-share-to-user-chat.drawio.svg) |
| 67 | 38a · Create and revoke a public share link | [`38a-share-link-create-revoke.drawio.svg`](importable-svg/38a-share-link-create-revoke.drawio.svg) |
| 68 | 38b · Resolve a public share link | [`38b-share-link-resolution.drawio.svg`](importable-svg/38b-share-link-resolution.drawio.svg) |
| 69 | 39a · AI question entry, Reel scope and query routing | [`39a-rag-scope-routing.drawio.svg`](importable-svg/39a-rag-scope-routing.drawio.svg) |
| 70 | 39b · Retrieval planning, hybrid search, cross-encoder rerank and sufficiency | [`39b-rag-search-rerank.drawio.svg`](importable-svg/39b-rag-search-rerank.drawio.svg) |
| 71 | 40a · Bounded answer memory and memory selection for a question | [`40a-rag-answer-memory.drawio.svg`](importable-svg/40a-rag-answer-memory.drawio.svg) |
| 72 | 40b · Completed-turn memory: summary and long-term user memory | [`40b-rag-turn-memory-update.drawio.svg`](importable-svg/40b-rag-turn-memory-update.drawio.svg) |
| 73 | 41a · Draft, verify and cite the grounded answer | [`41a-rag-draft-verify-cite.drawio.svg`](importable-svg/41a-rag-draft-verify-cite.drawio.svg) |
| 74 | 41b · Stream the final answer and persist it | [`41b-rag-stream-delivery.drawio.svg`](importable-svg/41b-rag-stream-delivery.drawio.svg) |
| 75 | 42a · Langfuse trace capture around a RAG workflow run | [`42a-observability-trace-capture.drawio.svg`](importable-svg/42a-observability-trace-capture.drawio.svg) |
| 76 | 42b · Operator export and validation of RAG traces | [`42b-observability-trace-export.drawio.svg`](importable-svg/42b-observability-trace-export.drawio.svg) |
| 77 | 43a · Photo question to the Velora AI assistant | [`43a-ai-photo-question.drawio.svg`](importable-svg/43a-ai-photo-question.drawio.svg) |
| 78 | 43b · Guardrails around an AI turn: input, evidence, output and memory | [`43b-ai-guardrails.drawio.svg`](importable-svg/43b-ai-guardrails.drawio.svg) |
| 79 | 43c · Recalling earlier messages, saved facts and photo descriptions | [`43c-ai-conversation-recall.drawio.svg`](importable-svg/43c-ai-conversation-recall.drawio.svg) |
| 80 | 44a · Reel subtitles: translate once, store per language, serve to the viewer | [`44a-reel-subtitles.drawio.svg`](importable-svg/44a-reel-subtitles.drawio.svg) |
