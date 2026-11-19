#!/usr/bin/env python3
"""Sequence models added after the 2026-11-12 audit: photo questions, guardrails, conversation recall,
subtitle translation, message push delivery and call setup.

`build(msg, note, frame)` returns model dicts in the same shape as SPLIT_MODELS in
build_and_modernize_all_diagrams.py. Evidence is resolved from regular expressions at build time, so the
cited line ranges always start at the cited code.
"""
from drawio_kit import ev as B, mev as M


def build(msg, note, frame):
    models = []

    # ------------------------------------------------------------------------------------------------
    models.append(dict(
        id='43a-ai-photo-question', title='43a · Photo question to the Velora AI assistant',
        participants=[('mobile', 'Velora-Mobile'), ('gateway', 'API Gateway'), ('media', 'Media Service'), ('r2', 'Cloudflare R2'),
                      ('conv', 'Conversation Service'), ('ai', 'AI Service'), ('vision', 'Vision provider')],
        steps=[
            msg('mobile', 'gateway', 'POST /media/upload-url (purpose chat, JPEG / PNG / WebP)', M('src/api/media.api.ts', r"upload-url"), B('apps/api-gateway/src/media/media.controller.ts', r"@Post\('upload-url'\)")),
            msg('gateway', 'media', 'media.get_presigned_url (userId, fileType, purpose)', B('apps/api-gateway/src/media/media.controller.ts', r"media\.get_presigned_url")),
            msg('media', 'gateway', 'Presigned PUT URL for chat-images/{userId}/{uuid}.{ext}', B('apps/media-service/src/application/use-cases/get-presigned-url.use-case.ts', r"folder = 'chat-images'"), reply=True),
            msg('mobile', 'r2', 'PUT the photo directly to storage', M('src/api/media.api.ts', r"finalize-upload")),
            msg('mobile', 'conv', 'send_message (type image, media.fileKey, optional caption, clientMessageId)', B('apps/conversation-service/src/infrastructure/gateways/chat.gateway.ts', r"@SubscribeMessage\('send_message'\)"), sort='asynchSignal'),
            frame('alt',
                  ('the photo key belongs to the sender and is JPEG, PNG or WebP', [
                      note('Only the sender\'s own upload may be read by the AI; the caption is the words, and the composer placeholder counts as no caption', B('apps/conversation-service/src/application/policies/bot-turn-image.ts', r'resolveBotTurnImages')),
                      frame('alt',
                            ('the sender is inside both the turn budget and the tighter photo budget', [
                                msg('conv', 'ai', 'ai.stream_question (caption, photo key and type, answerMemory)', B('apps/conversation-service/src/application/use-cases/process-bot-reply.use-case.ts', r'askQuestionStream')),
                                note('Input guardrail screens the caption first (39a); a bare photo asks for Reels like the picture', B('apps/ai-service/src/application/use-cases/stream-chat.use-case.ts', r'DEFAULT_IMAGE_ONLY_QUESTION')),
                                note('At most 3 photos per turn; every key is checked against the requester before any download', B('apps/ai-service/src/application/use-cases/describe-chat-images.use-case.ts', r'isChatImageKeyOwnedBy\(input\.userId')),
                                msg('ai', 'r2', 'Read the photo by key (size limit 4 MiB by default)', B('apps/ai-service/src/application/use-cases/describe-chat-images.use-case.ts', r'storage\.downloadImage')),
                                msg('r2', 'ai', 'Photo bytes', B('apps/ai-service/src/infrastructure/services/r2-chat-image-storage.service.ts', r'class R2ChatImageStorageService'), reply=True),
                                msg('ai', 'vision', 'Analyse the image: caption, visible text, objects (Cloudflare first, Groq when its daily allocation is spent)', B('apps/ai-service/src/application/use-cases/describe-chat-images.use-case.ts', r'this\.vision\.analyzeImage')),
                                frame('alt',
                                      ('the provider describes the photo', [
                                          msg('vision', 'ai', 'Description, text found in the photo, up to 12 objects', B('apps/ai-service/src/application/use-cases/describe-chat-images.use-case.ts', r'const description'), reply=True),
                                          note('Text inside a photo is attacker-controllable: the typed-input pattern check screens it and a hit drops the text but keeps the description', B('apps/ai-service/src/application/use-cases/describe-chat-images.use-case.ts', r'image OCR dropped')),
                                          note('The description is appended to the question as data (never instructions); the router treats questions about the photo itself as OFF_TOPIC and "Reels like this" as discovery', B('apps/ai-service/src/application/use-cases/query-router-agent.use-case.ts', r'Photo note')),
                                          note('The normal RAG workflow answers (39a to 41b)', B('apps/ai-service/src/application/use-cases/stream-chat.use-case.ts', r'this\.chatAdmission\.run')),
                                          msg('ai', 'conv', 'Answer, citations, recommended Reels and a 240-character photo description', B('apps/ai-service/src/application/use-cases/stream-chat.use-case.ts', r'formatRagImageHint'), reply=True),
                                          note('The bot message keeps photoOfMessageId and photoDescription so memory can recall what the photo showed (43c)', B('apps/conversation-service/src/application/use-cases/process-bot-reply.use-case.ts', r'photoOfMessageId')),
                                      ]),
                                      ('the provider quota is spent', [
                                          msg('ai', 'conv', 'AI_BUSY with retryAfterSeconds (60 s)', B('apps/ai-service/src/application/use-cases/describe-chat-images.use-case.ts', r'throw new ChatBusyError'), reply=True),
                                      ]),
                                      ('the photo cannot be read', [
                                          msg('ai', 'conv', 'IMAGE_UNREADABLE: say so instead of answering without the photo', B('apps/ai-service/src/infrastructure/controller/ai.controller.ts', r'IMAGE_UNREADABLE'), reply=True),
                                      ]),
                                ),
                            ]),
                            ('the sender exceeded a turn or photo budget', [
                                msg('conv', 'mobile', 'bot_reply_failed with RATE_LIMITED and retryAfterSeconds; the photo message stays stored', B('apps/conversation-service/src/application/use-cases/trigger-bot-reply.use-case.ts', r"code: 'RATE_LIMITED'"), sort='asynchSignal'),
                            ]),
                      ),
                  ]),
                  ('the key is not the sender\'s or the type is unsupported', [
                      note('The message is an ordinary photo message: no AI turn starts', B('apps/conversation-service/src/application/use-cases/trigger-bot-reply.use-case.ts', r"userMessage\.type !== 'text' && !hasImage")),
                  ]),
            ),
        ]))

    # ------------------------------------------------------------------------------------------------
    models.append(dict(
        id='43b-ai-guardrails', title='43b · Guardrails around an AI turn: input, evidence, output and memory',
        participants=[('conv', 'Conversation Service'), ('ai', 'AI Service'), ('classifier', 'Classifier model (optional)'), ('retrieval', 'Retrieval'), ('llm', 'Answer model'), ('mem', 'Memory writers')],
        steps=[
            note('Each of the four checks has its own mode (off · shadow · enforce) so it can be replayed on real traffic before it enforces; findings are content-free codes in the log and the Langfuse root output', B('apps/ai-service/src/domain/services/rag-guardrail/rag-guardrail.ts', r'readRagGuardrailModes')),
            msg('conv', 'ai', 'ai.stream_question (message, optional photo)', B('apps/ai-service/src/infrastructure/controller/ai.controller.ts', r"@MessagePattern\('ai\.stream_question'\)")),
            note('1 · Input: pattern check on the typed message, run before admission and before any model call', B('apps/ai-service/src/application/use-cases/refuse-rag-input.use-case.ts', r'RAG_INPUT_REFUSAL_MESSAGE')),
            frame('opt',
                  ('the patterns let the message through and the classifier is on', [
                      msg('ai', 'classifier', 'Second opinion on the message (borderline only by default; one extra call; timeout 4 s fails open)', B('apps/ai-service/src/application/use-cases/classify-rag-input.use-case.ts', r'class ClassifyRagInputUseCase')),
                      msg('classifier', 'ai', 'Verdict with confidence; it can only add a refusal, never lift one', B('apps/ai-service/src/application/use-cases/classify-rag-input.use-case.ts', r'refuse'), reply=True),
                  ]),
            ),
            frame('alt',
                  ('a high-severity finding and the input check enforces', [
                      msg('ai', 'conv', 'Fixed refusal at once: no model slot, no retrieval, no memory write', B('apps/ai-service/src/application/use-cases/stream-chat.use-case.ts', r'blocked=true input='), reply=True),
                  ]),
                  ('the message is allowed', [
                      msg('ai', 'retrieval', 'Retrieve evidence for the question', B('apps/ai-service/src/infrastructure/adapters/langgraph-rag-chat-workflow.adapter.ts', r'private guardEvidence')),
                      note('2 · Evidence: a chunk with a high-severity injection finding is dropped before it reaches the prompt', B('apps/ai-service/src/domain/services/rag-guardrail/rag-guardrail.ts', r'export function filterEvidenceForPrompt')),
                      msg('retrieval', 'ai', 'Kept chunks and the findings for the dropped ones', B('apps/ai-service/src/application/use-cases/screen-rag-result.use-case.ts', r'filterEvidence<T'), reply=True),
                      note('3 · Memory in the prompt: stored summaries and facts that carry a high-severity finding are left out', B('apps/ai-service/src/infrastructure/adapters/chat-prompt-builder.adapter.ts', r'shouldBlockRagMemory')),
                      msg('ai', 'llm', 'Draft, verify and stream the answer', B('apps/ai-service/src/application/use-cases/stream-final-answer.use-case.ts', r'generateResponseStream')),
                      note('4 · Output: live text is held back 160 characters and screened as it grows; a leak is replaced by a fixed message and publishing stops', B('apps/ai-service/src/application/use-cases/stream-final-answer.use-case.ts', r'Output enforcement: hold the tail')),
                      msg('ai', 'conv', 'Answer, or the fixed output refusal that does not say why', B('apps/ai-service/src/application/use-cases/screen-rag-result.use-case.ts', r'RAG_OUTPUT_REFUSAL_MESSAGE'), reply=True),
                      msg('conv', 'ai', 'ai.conversation_turn_completed (caption, answer, memory)', B('apps/conversation-service/src/application/use-cases/process-bot-reply.use-case.ts', r'emitConversationTurnCompleted'), sort='asynchSignal'),
                      msg('ai', 'mem', 'Summary and long-term memory writers', B('apps/ai-service/src/application/use-cases/update-conversation-memory.use-case.ts', r'screenRagMemoryUseCase\?\.blocks')),
                      note('5 · Memory write: text with a high-severity finding is never stored, so an attack that was answered once cannot persist', B('apps/ai-service/src/application/use-cases/screen-rag-memory.use-case.ts', r'blocks\(texts')),
                  ]),
            ),
            note('A guardrail failure never takes chat down: every check fails open and logs the error. Text from a failed check is not a reason to refuse.', B('apps/ai-service/src/application/use-cases/screen-rag-memory.use-case.ts', r'Guardrail memory screening failed')),
        ]))

    # ------------------------------------------------------------------------------------------------
    models.append(dict(
        id='43c-ai-conversation-recall', title='43c · Recalling earlier messages, saved facts and photo descriptions',
        participants=[('conv', 'Conversation Service'), ('cdb', 'Conversation message store'), ('ai', 'AI recall step'), ('tei', 'TEI embeddings'), ('aidb', 'AI user-memory DB')],
        steps=[
            msg('conv', 'cdb', 'Read the newest 120 messages of the conversation', B('apps/conversation-service/src/application/use-cases/build-bot-memory-context.use-case.ts', r'findMessagesByConversationId')),
            note('answerMemory carries the last 12 eligible messages and up to 80 older ones cut to 300 characters; photo descriptions replace the bare image placeholder', B('apps/conversation-service/src/application/use-cases/build-bot-memory-context.use-case.ts', r'const recentMessages'), B('apps/conversation-service/src/application/use-cases/build-bot-memory-context.use-case.ts', r'collectPhotoDescriptions')),
            msg('conv', 'ai', 'ai.stream_question (message, answerMemory with recent and older messages)', B('apps/conversation-service/src/infrastructure/adapters/ai-service.adapter.ts', r'ai\.stream_question')),
            note('Router: explicit recall wording ("do you remember", first-person preference or possession) is routed as a conversation or saved-fact question even if the model said plain chat', B('apps/ai-service/src/application/use-cases/query-router-agent.use-case.ts', r'looksLikeRecallQuestion')),
            frame('alt',
                  ('the intent is a conversation-memory or user-memory question', [
                      note('At the answer-context join the recall step runs; it is best effort and a failure leaves the recent history to answer', B('apps/ai-service/src/infrastructure/adapters/langgraph-rag-chat-workflow.adapter.ts', r'createAnswerContextJoinNode')),
                      note('Candidates: the 60 newest older messages, minus the assistant\'s canned replies and any text the memory guardrail blocks', B('apps/ai-service/src/application/use-cases/recall-conversation-context.use-case.ts', r'isCannedAssistantReply')),
                      frame('par',
                            ('earlier messages', [
                                msg('ai', 'tei', 'Embed the question and up to 20 candidates the cache does not hold (timeout; a late batch still fills the cache)', B('apps/ai-service/src/application/use-cases/recall-conversation-context.use-case.ts', r'MAX_EMBEDDED_CANDIDATES')),
                                msg('tei', 'ai', 'Vectors; on a timeout or error ranking falls back to word match only', B('apps/ai-service/src/application/use-cases/recall-conversation-context.use-case.ts', r'using word match only'), reply=True),
                                note('Rank by similarity and words; the strongest match, searched over the live window too, becomes a quotable answer', B('apps/ai-service/src/domain/services/rank-recalled-messages.ts', r'export function rankRecalledMessages'), B('apps/ai-service/src/domain/services/rank-recalled-messages.ts', r'export function strongRecallMatch')),
                            ]),
                            ('saved facts', [
                                msg('ai', 'aidb', 'Relevant user memories for the question (vector search, then lexical fallback)', B('apps/ai-service/src/application/use-cases/recall-conversation-context.use-case.ts', r'relevantUserMemories\(state\.userId')),
                                msg('aidb', 'ai', 'Up to 8 memories', B('apps/ai-service/src/application/use-cases/get-relevant-user-memories.use-case.ts', r'class GetRelevantUserMemoriesUseCase'), reply=True),
                            ]),
                      ),
                      note('Selection forces recent history, the summary and the recalled messages into the prompt; retrieved Reel chunks are not used', B('apps/ai-service/src/application/use-cases/recall-conversation-context.use-case.ts', r'includeRetrievedChunks: false')),
                      frame('alt',
                            ('the model drafts a grounded answer', [
                                note('Answer from recent history, recalled messages and saved facts', B('apps/ai-service/src/infrastructure/adapters/chat-prompt-builder.adapter.ts', r'recalled', 40)),
                            ]),
                            ('the answer model fails or cannot answer', [
                                note('Quote the user\'s own matching message; with no match say "I could not find that in our conversation" or "I do not have that saved about you"', B('apps/ai-service/src/infrastructure/adapters/langgraph-rag-chat-workflow.adapter.ts', r"I could not find that in our conversation")),
                            ]),
                      ),
                  ]),
                  ('any other intent', [
                      note('Recall is skipped; the normal memory selector decides what the prompt needs (40a)', B('apps/ai-service/src/application/use-cases/recall-conversation-context.use-case.ts', r'if \(!this\.isRecallTurn\(state\)\) return \{\}')),
                  ]),
            ),
        ]))

    # ------------------------------------------------------------------------------------------------
    models.append(dict(
        id='44a-reel-subtitles', title='44a · Reel subtitles: translate once, store per language, serve to the viewer',
        participants=[('indexer', 'Reel Indexing'), ('content', 'Content Service'), ('db', 'Content Database'), ('ai', 'AI Service'), ('llm', 'Translation model'), ('gateway', 'API Gateway'), ('mobile', 'Velora-Mobile')],
        steps=[
            msg('indexer', 'content', 'content.complete_indexing (index attempt, transcript segments)', B('apps/content-service/src/application/use-cases/complete-reel-indexing.use-case.ts', r'completeIndexing')),
            msg('content', 'db', 'Activate the index result and store the transcript', B('apps/content-service/src/application/use-cases/complete-reel-indexing.use-case.ts', r'repository\.completeIndexing')),
            msg('content', 'indexer', 'Acknowledge; translation runs after the acknowledgement', B('apps/content-service/src/application/use-cases/complete-reel-indexing.use-case.ts', r'Translation can take minutes'), reply=True),
            note('Reels that finish in a burst are translated one after another through a promise queue so they cannot flood the AI service', B('apps/content-service/src/application/use-cases/pre-translate-reel-subtitles.use-case.ts', r'private queue: Promise')),
            frame('loop',
                  ('each offered language (vi, en) other than the spoken language', [
                      msg('content', 'db', 'Find the stored track and compare its sourceHash with the transcript', B('apps/content-service/src/application/services/reel-subtitle-translator.service.ts', r'async hasCurrent')),
                      frame('alt',
                            ('a current track exists', [
                                note('Already stored: nothing to translate', B('apps/content-service/src/application/use-cases/pre-translate-reel-subtitles.use-case.ts', r'alreadyStored\.push')),
                            ]),
                            ('missing or built from an older transcript', [
                                note('Two requests for the same new translation share one in-flight model call', B('apps/content-service/src/application/services/reel-subtitle-translator.service.ts', r'private readonly inFlight')),
                                msg('content', 'ai', 'ai.translate_subtitle_cues (language pair, title, indexed cues)', B('apps/content-service/src/infrastructure/adapters/ai-subtitle-translation.adapter.ts', r"ai\.translate_subtitle_cues")),
                                msg('ai', 'llm', 'Translate in batches of 20 lines, up to 3 attempts per batch (Muse when enabled, otherwise Ollama)', B('apps/ai-service/src/application/use-cases/translate-subtitle-cues.use-case.ts', r'const BATCH_SIZE'), B('apps/ai-service/src/infrastructure/adapters/hybrid-structured-llm.adapter.ts', r'DEFAULT_MUSE_ROLES')),
                                msg('llm', 'ai', 'Translated lines', B('apps/ai-service/src/application/use-cases/translate-subtitle-cues.use-case.ts', r'every input line must come back|Every input line must come back'), reply=True),
                                msg('ai', 'content', 'All lines translated, or an error: never a partial track', B('apps/ai-service/src/application/use-cases/translate-subtitle-cues.use-case.ts', r'not a half-translated track'), reply=True),
                                msg('content', 'db', 'Save the track with sourceHash and model (unique per reel and language)', B('apps/content-service/src/application/services/reel-subtitle-translator.service.ts', r'this\.tracks\.save')),
                            ]),
                      ),
                  ]),
            ),
            note('A language that fails is translated later when a viewer asks for it; the failure never disturbs processing', B('apps/content-service/src/application/use-cases/pre-translate-reel-subtitles.use-case.ts', r'result\.failed\.push')),
            msg('mobile', 'gateway', 'GET /content/reels/:id/subtitles?language=vi|en|original', M('src/api/reels.api.ts', r'getSubtitles'), B('apps/api-gateway/src/content/content.controller.ts', r"@Get\('reels/:id/subtitles'\)")),
            msg('gateway', 'content', 'content.get_reel_subtitles (reelId, viewer, language)', B('apps/api-gateway/src/content/content.controller.ts', r"content\.get_reel_subtitles")),
            frame('alt',
                  ('the reel is missing or the viewer may not see it', [
                      msg('content', 'gateway', 'Not found', B('apps/content-service/src/application/use-cases/get-reel-subtitles.use-case.ts', r'Returns null when the reel'), reply=True),
                  ]),
                  ('the reel has no transcript', [
                      msg('content', 'gateway', 'SubtitlesUnavailableError', B('apps/content-service/src/application/use-cases/get-reel-subtitles.use-case.ts', r'This reel has no transcript'), reply=True),
                  ]),
                  ('the language is the spoken language or "original"', [
                      msg('content', 'gateway', 'Cues in the spoken language, translated=false', B('apps/content-service/src/application/use-cases/get-reel-subtitles.use-case.ts', r"input\.language === 'original'"), reply=True),
                  ]),
                  ('a translation is requested', [
                      msg('content', 'db', 'Read the stored track, or translate and store it now (shared in-flight work)', B('apps/content-service/src/application/use-cases/get-reel-subtitles.use-case.ts', r'this\.translator\.track\(reel')),
                      msg('content', 'gateway', 'Translated cues, translated=true', B('apps/content-service/src/application/use-cases/get-reel-subtitles.use-case.ts', r'translated: true'), reply=True),
                  ]),
            ),
            msg('gateway', 'mobile', 'Timed cues; the app caches them per viewer, reel and language and can prefetch', M('src/hooks/useReelSubtitles.ts', r'getSubtitlesQueryOptions'), reply=True),
        ]))

    return models
