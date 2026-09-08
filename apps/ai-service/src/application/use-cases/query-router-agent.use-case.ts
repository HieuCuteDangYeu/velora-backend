import type { IAiApplicationConfig } from '@ai/domain/interfaces/ai-application-config.interface';
import type {
  RagChatIntent,
  RagChatRouteDecision,
  RagRecommendationAction,
  RagReferenceTarget,
  RagReelQuestionType,
  RagRouterSemanticInconsistencyDetails,
  RagRouterSemanticInconsistencyType,
  RagRouterReferentContext,
  RagRequiredEvidence,
} from '@ai/domain/interfaces/rag-chat-workflow.interface';
import type {
  IStructuredLlmService,
  StructuredLlmCallDiagnostics,
  StructuredLlmJsonSchema,
} from '@ai/domain/interfaces/structured-llm.service.interface';
import { Inject, Injectable, Logger } from '@nestjs/common';
import {
  boundPromptText,
  readRagPromptBounds,
} from '@ai/domain/services/rag-prompt-bounds';

interface RawRouteDecision {
  intent?: unknown;
  referenceTarget?: unknown;
  reelQuestionType?: unknown;
  requiredEvidence?: unknown;
  recommendationAction?: unknown;
  reason?: unknown;
}

type RawRecord = Record<string, unknown>;

export function shouldRetryPrimaryRouter(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const record = error as RawRecord;
  return (
    record.code === 'STRUCTURED_COMPLETION_PROVIDER_ERROR' &&
    record.transient === true
  );
}

export class RouterUnavailableError extends Error {
  readonly code = 'ROUTER_UNAVAILABLE';

  constructor(
    readonly semanticCalls: StructuredLlmCallDiagnostics[] = [],
    readonly causeCode?: string,
    readonly semanticInconsistencyType?: RagRouterSemanticInconsistencyType,
    readonly semanticInconsistencyDetails?: RagRouterSemanticInconsistencyDetails,
  ) {
    super('Semantic router is temporarily unavailable');
    this.name = 'RouterUnavailableError';
  }
}

export class RouterSemanticInconsistencyError extends Error {
  readonly code = 'ROUTER_SEMANTIC_INCONSISTENT';

  constructor(
    readonly semanticInconsistencyType: RagRouterSemanticInconsistencyType,
    readonly semanticInconsistencyDetails: RagRouterSemanticInconsistencyDetails = {},
  ) {
    super('Semantic router returned an internally inconsistent referent');
    this.name = 'RouterSemanticInconsistencyError';
  }
}

@Injectable()
export class QueryRouterAgentUseCase {
  private readonly logger = new Logger(QueryRouterAgentUseCase.name);

  private readonly validIntents = new Set<RagChatIntent>([
    'NORMAL_CHAT',
    'REEL_VIDEO_QUESTION',
    'CONVERSATION_MEMORY_QUESTION',
    'USER_MEMORY_QUESTION',
    'TASK_ACTION_REQUEST',
  ]);

  private readonly validReferenceTargets = new Set<RagReferenceTarget>([
    'NONE',
    'SHARED_REEL',
    'CONVERSATION',
    'USER_MEMORY',
  ]);

  private readonly validReelQuestionTypes = new Set<RagReelQuestionType>([
    'NONE',
    'TRANSCRIPT_CONTENT',
    'VISUAL_CONTENT',
    'GENERAL_REEL_SUMMARY',
    'REEL_METADATA',
    'AMBIGUOUS_REEL_REFERENCE',
  ]);

  private readonly validRequiredEvidence = new Set<RagRequiredEvidence>([
    'NONE',
    'TRANSCRIPT',
    'VISUAL',
    'AUDIO',
    'METADATA',
    'CONVERSATION_MEMORY',
    'USER_MEMORY',
  ]);

  constructor(
    @Inject('IStructuredLlmService')
    private readonly structuredLlmService: IStructuredLlmService,
    @Inject('IAiApplicationConfig')
    private readonly config: IAiApplicationConfig,
  ) {}

  async execute(input: {
    message: string;
    recentHistory?: string;
    hasSharedReelContext?: boolean;
    sharedReelCount?: number;
    referentContext?: RagRouterReferentContext;
  }): Promise<RagChatRouteDecision> {
    const boundedInput = this.boundInput(input);
    if (!boundedInput.message.trim()) {
      return {
        ...this.createNormalChatRoute(
          'Empty or whitespace message treated as normal chat.',
        ),
        diagnostics: {
          modelRole: 'ROUTER',
          providerStatus: 'NOT_CALLED',
          decisionSource: 'STRUCTURAL',
        },
      };
    }

    const semanticCalls: StructuredLlmCallDiagnostics[] = [];
    const primaryModel = this.config.model('ROUTER');

    try {
      const result = this.normalize(
        await this.routeWithPrimaryAttempts({
          input: boundedInput,
          model: primaryModel,
          semanticCalls,
        }),
        boundedInput,
      );

      if (this.needsReferentReconciliation(result, boundedInput)) {
        return await this.routeWithFallback({
          input: boundedInput,
          semanticCalls,
          primaryResult: result,
          primaryAttemptCount: this.primaryAttemptCount(
            semanticCalls,
            primaryModel,
          ),
          reason: 'STRUCTURAL_REFERENT_AMBIGUITY',
        });
      }

      return {
        ...result,
        diagnostics: {
          modelRole: 'ROUTER',
          model: primaryModel,
          providerStatus: 'SUCCESS',
          decisionSource: 'LLM',
          semanticCalls,
        },
      };
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      if (!this.isFallbackEligible(error)) {
        this.logger.warn(
          `[QueryRouterAgent] semantic routing failed: ${message}`,
        );
        throw error;
      }

      return await this.routeWithFallback({
        input: boundedInput,
        semanticCalls,
        primaryAttemptCount: this.primaryAttemptCount(
          semanticCalls,
          primaryModel,
        ),
        semanticInconsistency:
          error instanceof RouterSemanticInconsistencyError ? error : undefined,
        reason:
          error instanceof RouterSemanticInconsistencyError
            ? 'PRIMARY_SEMANTIC_INCONSISTENCY'
            : 'PRIMARY_PROVIDER_FAILURE',
      });
    }
  }

  private boundInput(
    input: Parameters<QueryRouterAgentUseCase['execute']>[0],
  ): Parameters<QueryRouterAgentUseCase['execute']>[0] {
    const bounds = readRagPromptBounds(this.config);
    return {
      ...input,
      message: boundPromptText(input.message, bounds.maxUserMessageChars),
      recentHistory: boundPromptText(
        input.recentHistory,
        bounds.maxRecentTotalChars,
      ),
      referentContext: input.referentContext
        ? {
            ...input.referentContext,
            recentEventTypes: input.referentContext.recentEventTypes?.slice(
              -bounds.maxRecentMessages,
            ),
          }
        : input.referentContext,
    };
  }

  private async routeWithFallback(input: {
    input: Parameters<QueryRouterAgentUseCase['execute']>[0];
    semanticCalls: StructuredLlmCallDiagnostics[];
    primaryResult?: RagChatRouteDecision;
    primaryAttemptCount: number;
    semanticInconsistency?: RouterSemanticInconsistencyError;
    reason: string;
  }): Promise<RagChatRouteDecision> {
    const fallbackModel = this.config
      .get<string>('AI_ROUTER_FALLBACK_MODEL')
      ?.trim();
    if (!fallbackModel) {
      if (input.primaryResult) return input.primaryResult;
      throw new RouterUnavailableError(
        input.semanticCalls,
        input.reason === 'PRIMARY_SEMANTIC_INCONSISTENCY'
          ? 'ROUTER_SEMANTIC_INCONSISTENT'
          : input.semanticCalls.at(-1)?.errorCode,
        input.semanticInconsistency?.semanticInconsistencyType,
        input.semanticInconsistency?.semanticInconsistencyDetails,
      );
    }

    try {
      const result = this.normalize(
        await this.routeWithModel({
          input: input.input,
          model: fallbackModel,
          attempt: input.primaryAttemptCount + 1,
          maxTokens: Math.round(
            this.config.number(
              'AI_ROUTER_FALLBACK_MAX_TOKENS',
              this.config.maxCompletionTokens('ROUTER'),
              128,
              4096,
            ),
          ),
          semanticCalls: input.semanticCalls,
          timeoutMs: Math.round(
            this.config.number(
              'AI_ROUTER_FALLBACK_TIMEOUT_MS',
              30_000,
              500,
              120_000,
            ),
          ),
        }),
        input.input,
      );
      return {
        ...result,
        diagnostics: {
          modelRole: 'ROUTER',
          model: fallbackModel,
          providerStatus: 'SUCCESS',
          decisionSource: 'LLM_FALLBACK',
          semanticCalls: input.semanticCalls,
          fallbackReason: input.reason,
        },
      };
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.warn(
        `[QueryRouterAgent] bounded semantic fallback failed: ${message}`,
      );
      throw new RouterUnavailableError(
        input.semanticCalls,
        this.errorCode(error) ??
          (input.semanticInconsistency
            ? 'ROUTER_SEMANTIC_INCONSISTENT'
            : undefined),
        (error instanceof RouterSemanticInconsistencyError
          ? error
          : input.semanticInconsistency
        )?.semanticInconsistencyType,
        (error instanceof RouterSemanticInconsistencyError
          ? error
          : input.semanticInconsistency
        )?.semanticInconsistencyDetails,
      );
    }
  }

  private async routeWithPrimaryAttempts(input: {
    input: Parameters<QueryRouterAgentUseCase['execute']>[0];
    model: string;
    semanticCalls: StructuredLlmCallDiagnostics[];
  }): Promise<RawRouteDecision> {
    const maxAttempts = Math.round(
      this.config.number('AI_ROUTER_PRIMARY_MAX_ATTEMPTS', 1, 1, 2),
    );
    const timeoutMs = this.config.timeoutMs('ROUTER');

    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      try {
        return await this.routeWithModel({
          input: input.input,
          model: input.model,
          attempt,
          semanticCalls: input.semanticCalls,
          timeoutMs,
        });
      } catch (error: unknown) {
        if (attempt >= maxAttempts || !shouldRetryPrimaryRouter(error)) {
          throw error;
        }
      }
    }

    throw new Error('Router primary attempts exhausted');
  }

  private primaryAttemptCount(
    semanticCalls: StructuredLlmCallDiagnostics[],
    model: string,
  ): number {
    return Math.max(
      1,
      semanticCalls.filter(
        (call) => call.modelRole === 'ROUTER' && call.model === model,
      ).length,
    );
  }

  private errorCode(error: unknown): string | undefined {
    if (!error || typeof error !== 'object' || !('code' in error)) {
      return undefined;
    }
    return typeof error.code === 'string' ? error.code : undefined;
  }

  private async routeWithModel(input: {
    input: {
      message: string;
      recentHistory?: string;
      hasSharedReelContext?: boolean;
      sharedReelCount?: number;
      referentContext?: RagRouterReferentContext;
    };
    model: string;
    attempt: number;
    maxTokens?: number;
    semanticCalls: StructuredLlmCallDiagnostics[];
    timeoutMs: number;
  }): Promise<RawRouteDecision> {
    return await this.structuredLlmService.generateObject<RawRouteDecision>({
      systemPrompt: this.buildSystemPrompt(),
      userPrompt: this.buildUserPrompt(input.input),
      jsonSchema: this.getJsonSchema(),
      maxTokens: input.maxTokens ?? this.config.maxCompletionTokens('ROUTER'),
      schemaVersion: 'router-semantic-v4',
      temperature: 0,
      model: input.model,
      modelRole: 'ROUTER',
      attempt: input.attempt,
      onDiagnostics: (diagnostics) => input.semanticCalls.push(diagnostics),
      timeoutMs: input.timeoutMs,
    });
  }

  private isFallbackEligible(error: unknown): boolean {
    if (!error || typeof error !== 'object' || !('code' in error)) return false;
    if (
      error.code === 'STRUCTURED_COMPLETION_PROVIDER_ERROR' &&
      'transient' in error &&
      error.transient === false
    ) {
      return false;
    }
    return (
      error.code === 'STRUCTURED_COMPLETION_TIMEOUT' ||
      error.code === 'STRUCTURED_COMPLETION_PROVIDER_ERROR' ||
      error.code === 'STRUCTURED_COMPLETION_SCHEMA_INVALID' ||
      error.code === 'ROUTER_SEMANTIC_INCONSISTENT'
    );
  }

  private buildSystemPrompt(): string {
    return `
You route Velora AI messages by meaning. Return only schema-valid JSON and never answer the user.
Output exactly these top-level fields and no others: intent, referenceTarget, reelQuestionType, requiredEvidence, recommendationAction, reason. recommendationAction contains exactly: type, query, allowPersonalizedFallback, suggestedQueries. The application derives retrieval/memory/verification flags and result-count policy; do not output those fields.
Apply every definition by semantic meaning regardless of the language used in the user message, recent history, or reel. Emit only the canonical enum values in this schema; never translate enum values into natural-language labels.

Intent meanings:
- NORMAL_CHAT: general conversation, coding help, app discussion, clarification, recommendation/discovery requests, or normal assistant chat.
- REEL_VIDEO_QUESTION: the user asks about a reel/video/clip/media item shared in the current conversation.
- CONVERSATION_MEMORY_QUESTION: the user asks what happened earlier in this conversation.
- USER_MEMORY_QUESTION: the user asks about stable facts, preferences, profile, or remembered user information.
- TASK_ACTION_REQUEST: the user asks to execute an external operation or change application/account state. This intent is a classification, not authorization to execute it. Read-only in-app content discovery and search suggestions are NORMAL_CHAT, never TASK_ACTION_REQUEST.

Reference target meanings:
- NONE: the current message does not semantically refer to shared media, conversation history, or user memory.
- SHARED_REEL: the meaning of the current message depends on reel/video/media shared in this conversation, including implicit factual follow-ups.
- CONVERSATION: the user asks about earlier turns or events in this conversation.
- USER_MEMORY: the user asks about stable remembered facts or preferences about the user.

Reel question type meanings:
- NONE: not a question about a shared reel/video.
- TRANSCRIPT_CONTENT: asks for specific spoken or textual reel content, including a fact, quantity, cause, relation, comparison, sequence, explanation, claim, quote, or what someone says, explains, discusses, mentions, captions, or teaches. Facts about entities, events, places, roles, dates, relationships, causes, quantities, or processes stated within the media are content facts, not reel metadata. It is not an overall summary request.
- VISUAL_CONTENT: asks about visual appearance, objects, people, colors, text on screen, layout, or what is seen.
- GENERAL_REEL_SUMMARY: asks for the shared reel's overall meaning, summary, topic, main point, takeaway, or what it is about. Do not use it for one specific fact, relation, comparison, cause, quantity, sequence, or other detail.
- REEL_METADATA: asks about properties of the reel as a media object or publication, such as its title, description, caption, hashtags, tags, uploader, creator attribution of the reel itself, or upload/share metadata.
- AMBIGUOUS_REEL_REFERENCE: refers to a shared reel/video but the requested information is unclear.

Evidence meanings:
- TRANSCRIPT: spoken words, transcript chunks, captions, or textual reel content are needed.
- VISUAL: visual frame analysis or OCR is needed.
- AUDIO: non-speech audio, music, tone, sound effects, or background audio is needed.
- METADATA: title, description, caption, tags, hashtags, author, or share metadata is needed.
- CONVERSATION_MEMORY: recent conversation/history summary is needed.
- USER_MEMORY: long-term user memory is needed.
- NONE: no special evidence is needed.

Recommendation action meanings:
- NONE: do not attach reel recommendations or query suggestions.
- RECOMMEND_REELS: user clearly asks to find, recommend, show, discover, or get reels/videos/content.
- SUGGEST_QUERIES: user asks what to search, search keywords, topic ideas, or query suggestions.

Invariants:
- A question about an available shared reel is REEL_VIDEO_QUESTION, not discovery.
- A follow-up asking for new information from shared media remains REEL_VIDEO_QUESTION even when recent history already contains a user question and assistant answer about that media or subject. Use CONVERSATION_MEMORY_QUESTION only when the current message asks what the user or assistant previously said, asked, decided, or discussed.
- Metadata describes the media item itself. A person, organization, location, role, date, relationship, cause, quantity, comparison, sequence, or process stated by the media is a content-level fact and requires the matching content evidence. Uploader or creator attribution means attribution of the reel itself, not a person mentioned inside it.
- Summary needs TRANSCRIPT and METADATA; transcript, visual, and metadata questions require their matching evidence. Never substitute transcript for visual proof.
- Reel retrieval is required when grounded reel evidence is needed. Reel and memory answers require verification.
- Conversation memory is for prior conversation context; user memory is only for stable preferences/profile.
- RECOMMEND_REELS is only for explicit content discovery. Use a clean topic query; broad discovery may allow personalized fallback, topic-specific discovery may not.
- SUGGEST_QUERIES is only for requested search terms. Otherwise recommendationAction is NONE.
- Specific factual, quantitative, causal, relational, comparative, or sequence questions about the reel use TRANSCRIPT_CONTENT unless the user explicitly asks about visual appearance, on-screen text/layout, or metadata.
- Both discovery actions require intent=NORMAL_CHAT, referenceTarget=NONE, reelQuestionType=NONE, requiredEvidence=[NONE]. Internal search is not an external task. For NONE use query="", allowPersonalizedFallback=false and suggestedQueries=[]. For RECOMMEND_REELS use suggestedQueries=[]; for SUGGEST_QUERIES provide suggestions and allowPersonalizedFallback=false.
- Evidence is minimal for the classified question: TRANSCRIPT_CONTENT=[TRANSCRIPT], VISUAL_CONTENT=[VISUAL], REEL_METADATA=[METADATA], GENERAL_REEL_SUMMARY=[TRANSCRIPT,METADATA]. Non-reel routes use their own memory evidence or [NONE], never reel modalities.
- Do not invent context or use keyword/regex routing.
- Structural event metadata says what happened, not what the current message means. A recent reel share is evidence for resolving an implicit referent, but unrelated chat remains NORMAL_CHAT with referenceTarget=NONE.
- Treat language as presentation context, not as a change to the taxonomy: equivalent meanings in different languages use the same intent, reference, reel type, evidence, and recommendation enums.
- referenceTarget=SHARED_REEL requires intent=REEL_VIDEO_QUESTION. CONVERSATION requires CONVERSATION_MEMORY_QUESTION. USER_MEMORY requires USER_MEMORY_QUESTION. All other routes use NONE.
`.trim();
  }

  private buildUserPrompt(input: {
    message: string;
    recentHistory?: string;
    hasSharedReelContext?: boolean;
    sharedReelCount?: number;
    referentContext?: RagRouterReferentContext;
  }): string {
    return `
Current user message:
${input.message}

Shared reel context:
${input.hasSharedReelContext ? `AVAILABLE (${input.sharedReelCount ?? 0} accessible reel${input.sharedReelCount === 1 ? '' : 's'})` : 'NOT AVAILABLE'}

Structural referent context (contains no reel IDs and does not decide meaning):
${JSON.stringify(
  input.referentContext ?? {
    conversationHasSharedReelContext: input.hasSharedReelContext ?? false,
    accessibleSharedReelCount: input.sharedReelCount ?? 0,
    recentShareEvent: false,
    recentEventTypes: [],
  },
)}

Recent conversation context:
${input.recentHistory || '(empty)'}

Classify the current user message.
`.trim();
  }

  private getJsonSchema(): StructuredLlmJsonSchema {
    return {
      type: 'object',
      additionalProperties: false,
      required: [
        'intent',
        'referenceTarget',
        'reelQuestionType',
        'requiredEvidence',
        'recommendationAction',
        'reason',
      ],
      properties: {
        intent: {
          type: 'string',
          enum: [
            'NORMAL_CHAT',
            'REEL_VIDEO_QUESTION',
            'CONVERSATION_MEMORY_QUESTION',
            'USER_MEMORY_QUESTION',
            'TASK_ACTION_REQUEST',
          ],
        },
        referenceTarget: {
          type: 'string',
          enum: ['NONE', 'SHARED_REEL', 'CONVERSATION', 'USER_MEMORY'],
        },
        reelQuestionType: {
          type: 'string',
          description:
            'Classify the requested reel information: specific spoken/textual content, visual content, overall summary, metadata, or an unclear reel request.',
          enum: [
            'NONE',
            'TRANSCRIPT_CONTENT',
            'VISUAL_CONTENT',
            'GENERAL_REEL_SUMMARY',
            'REEL_METADATA',
            'AMBIGUOUS_REEL_REFERENCE',
          ],
        },
        requiredEvidence: {
          type: 'array',
          description:
            'Return the minimal evidence modalities needed for the semantic request. Content-level facts stated within the media use TRANSCRIPT; metadata about the media item itself uses METADATA; this may be an independent set for an ambiguous reel request.',
          minItems: 1,
          maxItems: 4,
          items: {
            type: 'string',
            enum: [
              'NONE',
              'TRANSCRIPT',
              'VISUAL',
              'AUDIO',
              'METADATA',
              'CONVERSATION_MEMORY',
              'USER_MEMORY',
            ],
          },
        },
        recommendationAction: {
          type: 'object',
          additionalProperties: false,
          required: [
            'type',
            'query',
            'allowPersonalizedFallback',
            'suggestedQueries',
          ],
          properties: {
            type: {
              type: 'string',
              enum: ['NONE', 'RECOMMEND_REELS', 'SUGGEST_QUERIES'],
            },
            query: { type: 'string', maxLength: 240 },
            allowPersonalizedFallback: { type: 'boolean' },
            suggestedQueries: {
              type: 'array',
              maxItems: 5,
              items: { type: 'string', maxLength: 160 },
            },
          },
        },
        reason: { type: 'string', maxLength: 240 },
      },
    };
  }

  private normalize(
    raw: RawRouteDecision,
    input: { hasSharedReelContext?: boolean },
  ): RagChatRouteDecision {
    const intent = this.normalizeIntent(raw.intent);
    const referenceTarget = this.normalizeReferenceTarget(raw.referenceTarget);
    this.validateReferentConsistency(
      intent,
      referenceTarget,
      input.hasSharedReelContext ?? false,
    );
    const reelQuestionType = this.normalizeReelQuestionType(
      raw.reelQuestionType,
      intent,
    );

    const requiredEvidence = this.normalizeRequiredEvidence(
      raw.requiredEvidence,
      intent,
      reelQuestionType,
    );

    return {
      intent,
      referenceTarget,
      needsRetrieval: intent === 'REEL_VIDEO_QUESTION',
      needsUserMemory:
        intent === 'NORMAL_CHAT' || intent === 'USER_MEMORY_QUESTION',
      needsConversationSummary: [
        'NORMAL_CHAT',
        'CONVERSATION_MEMORY_QUESTION',
        'REEL_VIDEO_QUESTION',
      ].includes(intent),
      needsVerification: intent !== 'NORMAL_CHAT',
      reelQuestionType,
      requiredEvidence,
      recommendationAction: this.normalizeRecommendationAction(
        raw.recommendationAction,
        intent,
      ),
      reason:
        typeof raw.reason === 'string' && raw.reason.trim()
          ? raw.reason.trim()
          : 'No router reason provided.',
    };
  }

  private normalizeReferenceTarget(value: unknown): RagReferenceTarget {
    if (
      typeof value === 'string' &&
      this.validReferenceTargets.has(value as RagReferenceTarget)
    ) {
      return value as RagReferenceTarget;
    }
    throw new RouterSemanticInconsistencyError('INVALID_REFERENCE_TARGET');
  }

  private validateReferentConsistency(
    intent: RagChatIntent,
    referenceTarget: RagReferenceTarget,
    hasSharedReelContext: boolean,
  ): void {
    const expected: Record<RagChatIntent, RagReferenceTarget> = {
      NORMAL_CHAT: 'NONE',
      REEL_VIDEO_QUESTION: 'SHARED_REEL',
      CONVERSATION_MEMORY_QUESTION: 'CONVERSATION',
      USER_MEMORY_QUESTION: 'USER_MEMORY',
      TASK_ACTION_REQUEST: 'NONE',
    };
    if (referenceTarget !== expected[intent]) {
      throw new RouterSemanticInconsistencyError('INTENT_REFERENCE_MISMATCH', {
        actualIntent: intent,
        actualReferenceTarget: referenceTarget,
        expectedReferenceTarget: expected[intent],
      });
    }
    if (referenceTarget === 'SHARED_REEL' && !hasSharedReelContext) {
      throw new RouterSemanticInconsistencyError(
        'SHARED_REEL_CONTEXT_UNAVAILABLE',
        {
          actualIntent: intent,
          actualReferenceTarget: referenceTarget,
          expectedReferenceTarget: expected[intent],
        },
      );
    }
  }

  private needsReferentReconciliation(
    route: RagChatRouteDecision,
    input: { referentContext?: RagRouterReferentContext },
  ): boolean {
    return Boolean(
      input.referentContext?.recentShareEvent &&
      route.referenceTarget === 'NONE',
    );
  }

  private normalizeIntent(value: unknown): RagChatIntent {
    if (
      typeof value === 'string' &&
      this.validIntents.has(value as RagChatIntent)
    ) {
      return value as RagChatIntent;
    }

    throw new RouterSemanticInconsistencyError('INVALID_INTENT');
  }

  private normalizeReelQuestionType(
    value: unknown,
    intent: RagChatIntent,
  ): RagReelQuestionType {
    if (
      typeof value === 'string' &&
      this.validReelQuestionTypes.has(value as RagReelQuestionType)
    ) {
      if ((intent === 'REEL_VIDEO_QUESTION') === (value !== 'NONE'))
        return value as RagReelQuestionType;

      throw new RouterSemanticInconsistencyError('INTENT_REEL_TYPE_MISMATCH', {
        actualIntent: intent,
        actualReelQuestionType: value as RagReelQuestionType,
        ...(intent !== 'REEL_VIDEO_QUESTION'
          ? { expectedReelQuestionType: 'NONE' as const }
          : {}),
      });
    }

    throw new RouterSemanticInconsistencyError('INTENT_REEL_TYPE_MISMATCH', {
      actualIntent: intent,
    });
  }

  private normalizeRequiredEvidence(
    value: unknown,
    intent: RagChatIntent,
    reelQuestionType: RagReelQuestionType,
  ): RagRequiredEvidence[] {
    if (Array.isArray(value)) {
      const normalized = value.filter(
        (item): item is RagRequiredEvidence =>
          typeof item === 'string' &&
          this.validRequiredEvidence.has(item as RagRequiredEvidence),
      );

      if (
        normalized.length > 0 &&
        normalized.length === value.length &&
        new Set(normalized).size === normalized.length
      ) {
        const expected = this.defaultRequiredEvidence(intent, reelQuestionType);
        const ambiguous =
          intent === 'REEL_VIDEO_QUESTION' &&
          reelQuestionType === 'AMBIGUOUS_REEL_REFERENCE';
        if (
          ambiguous
            ? normalized.every((item) =>
                ['TRANSCRIPT', 'VISUAL', 'AUDIO', 'METADATA'].includes(item),
              )
            : normalized.length === expected.length &&
              expected.every((item) => normalized.includes(item))
        )
          return normalized;
      }
    }

    const expected = this.defaultRequiredEvidence(intent, reelQuestionType);
    const actualEvidence = Array.isArray(value)
      ? value.filter(
          (item): item is RagRequiredEvidence =>
            typeof item === 'string' &&
            this.validRequiredEvidence.has(item as RagRequiredEvidence),
        )
      : [];
    throw new RouterSemanticInconsistencyError('REQUIRED_EVIDENCE_MISMATCH', {
      actualIntent: intent,
      actualReelQuestionType: reelQuestionType,
      actualEvidence,
      expectedEvidence: expected,
    });
  }

  private normalizeRecommendationAction(
    value: unknown,
    intent: RagChatIntent,
  ): RagRecommendationAction {
    const record = this.asRecord(value);

    if (!record) {
      throw new RouterSemanticInconsistencyError(
        'INVALID_RECOMMENDATION_ACTION',
      );
    }

    const type = record.type;
    const actionTypes = ['NONE', 'RECOMMEND_REELS', 'SUGGEST_QUERIES'] as const;
    if (
      typeof type !== 'string' ||
      !actionTypes.includes(type as (typeof actionTypes)[number])
    ) {
      throw new RouterSemanticInconsistencyError(
        'INVALID_RECOMMENDATION_ACTION',
      );
    }
    const actionType = type as (typeof actionTypes)[number];
    if (actionType !== 'NONE' && intent !== 'NORMAL_CHAT') {
      throw new RouterSemanticInconsistencyError(
        'RECOMMENDATION_INTENT_MISMATCH',
        {
          actualIntent: intent,
          recommendationActionType: actionType,
        },
      );
    }
    const query = this.normalizeOptionalString(record.query);
    const suggestions = this.normalizeSuggestedQueries(record.suggestedQueries);
    if (
      (actionType === 'NONE' &&
        (query ||
          record.allowPersonalizedFallback === true ||
          suggestions.length > 0)) ||
      (actionType === 'RECOMMEND_REELS' && suggestions.length > 0) ||
      (actionType === 'SUGGEST_QUERIES' &&
        (record.allowPersonalizedFallback === true || suggestions.length === 0))
    ) {
      throw new RouterSemanticInconsistencyError(
        'RECOMMENDATION_PAYLOAD_MISMATCH',
        { recommendationActionType: actionType },
      );
    }

    if (actionType === 'RECOMMEND_REELS') {
      const query = this.normalizeOptionalString(record.query);
      const allowPersonalizedFallback =
        typeof record.allowPersonalizedFallback === 'boolean'
          ? record.allowPersonalizedFallback
          : !query;

      return {
        type: 'RECOMMEND_REELS',
        ...(query ? { query } : {}),
        minRelevantItems: 2,
        allowPersonalizedFallback,
        reason: this.normalizeReason(
          record.reason,
          'User asked for reel recommendations.',
        ),
      };
    }

    if (actionType === 'SUGGEST_QUERIES') {
      return {
        type: 'SUGGEST_QUERIES',
        ...(this.normalizeOptionalString(record.query)
          ? { query: this.normalizeOptionalString(record.query) }
          : {}),
        suggestedQueries: this.normalizeSuggestedQueries(
          record.suggestedQueries,
        ),
        reason: this.normalizeReason(
          record.reason,
          'User asked for query suggestions.',
        ),
      };
    }

    return {
      type: 'NONE',
      reason: this.normalizeReason(
        record.reason,
        'No recommendation action needed.',
      ),
    };
  }

  private defaultRequiredEvidence(
    intent: RagChatIntent,
    reelQuestionType: RagReelQuestionType,
  ): RagRequiredEvidence[] {
    if (intent === 'REEL_VIDEO_QUESTION') {
      if (reelQuestionType === 'GENERAL_REEL_SUMMARY') {
        return ['TRANSCRIPT', 'METADATA'];
      }

      if (reelQuestionType === 'TRANSCRIPT_CONTENT') {
        return ['TRANSCRIPT'];
      }

      if (reelQuestionType === 'REEL_METADATA') {
        return ['METADATA'];
      }

      if (reelQuestionType === 'VISUAL_CONTENT') {
        return ['VISUAL'];
      }

      return ['TRANSCRIPT', 'METADATA'];
    }

    if (intent === 'CONVERSATION_MEMORY_QUESTION') {
      return ['CONVERSATION_MEMORY'];
    }

    if (intent === 'USER_MEMORY_QUESTION') {
      return ['USER_MEMORY'];
    }

    return ['NONE'];
  }

  private normalizeSuggestedQueries(value: unknown): string[] {
    if (!Array.isArray(value)) {
      return [];
    }

    const seen = new Set<string>();
    const suggestions: string[] = [];

    for (const item of value) {
      if (typeof item !== 'string') {
        continue;
      }

      const normalized = item.replace(/\s+/g, ' ').trim();

      if (!normalized || seen.has(normalized.toLowerCase())) {
        continue;
      }

      seen.add(normalized.toLowerCase());
      suggestions.push(normalized);

      if (suggestions.length >= 3) {
        break;
      }
    }

    return suggestions;
  }

  private normalizeOptionalString(value: unknown): string | undefined {
    if (typeof value !== 'string') {
      return undefined;
    }

    const normalized = value.replace(/\s+/g, ' ').trim();

    return normalized.length > 0 ? normalized : undefined;
  }

  private normalizeReason(value: unknown, fallback: string): string {
    if (typeof value === 'string' && value.trim()) {
      return value.trim();
    }

    return fallback;
  }

  private asRecord(value: unknown): RawRecord | undefined {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      return undefined;
    }

    return value as RawRecord;
  }

  private createNormalChatRoute(reason: string): RagChatRouteDecision {
    return {
      intent: 'NORMAL_CHAT',
      referenceTarget: 'NONE',
      needsRetrieval: false,
      needsUserMemory: true,
      needsConversationSummary: true,
      needsVerification: false,
      reelQuestionType: 'NONE',
      requiredEvidence: ['NONE'],
      recommendationAction: {
        type: 'NONE',
        reason,
      },
      reason,
    };
  }
}
