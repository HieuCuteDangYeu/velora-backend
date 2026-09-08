import type {
  RagChatWorkflowState,
  RagContextSufficiencyResult,
  RagRequiredEvidence,
} from '@ai/domain/interfaces/rag-chat-workflow.interface';
import type {
  IStructuredLlmService,
  StructuredLlmJsonSchema,
} from '@ai/domain/interfaces/structured-llm.service.interface';
import type { ReelContextSearchResult } from '@common/content/interfaces/reel-context-search-result.interface';
import { Inject, Injectable, Logger } from '@nestjs/common';
import {
  boundEvidence,
  boundPromptText,
  readRagPromptBounds,
} from '@ai/domain/services/rag-prompt-bounds';

interface RawContextSufficiencyResult {
  sufficient?: unknown;
  confidence?: unknown;
  supportedEvidenceIds?: unknown;
  reason?: unknown;
  userFacingReason?: unknown;
  recommendedAction?: unknown;
}

@Injectable()
export class CheckContextSufficiencyUseCase {
  private readonly logger = new Logger(CheckContextSufficiencyUseCase.name);

  constructor(
    @Inject('IStructuredLlmService')
    private readonly structuredLlmService: IStructuredLlmService,
    @Inject('IAiApplicationConfig')
    private readonly config: IAiApplicationConfig,
  ) {}

  async execute(
    state: RagChatWorkflowState,
  ): Promise<RagContextSufficiencyResult> {
    if (!state.route?.needsRetrieval) {
      return {
        sufficient: true,
        confidence: 1,
        availableEvidence: ['NONE'],
        missingEvidence: [],
        supportedEvidenceIds: [],
        reason: 'Retrieval is not required for this intent.',
        recommendedAction: 'ANSWER',
        diagnostics: {
          providerStatus: 'NOT_CALLED',
          decisionSource: 'UNKNOWN',
          modelRole: 'CONTEXT_SUFFICIENCY',
        },
      };
    }

    if (state.rerankedChunks.length === 0) {
      return {
        sufficient: false,
        confidence: 1,
        availableEvidence: [],
        missingEvidence: this.getRequiredEvidence(state),
        supportedEvidenceIds: [],
        reason: 'No retrieved reel evidence is available.',
        userFacingReason:
          'No relevant shared reel evidence is available in this conversation.',
        recommendedAction: 'REFUSE_NO_CONTEXT',
        diagnostics: {
          providerStatus: 'NOT_CALLED',
          decisionSource: 'DETERMINISTIC_NO_CONTEXT',
          modelRole: 'CONTEXT_SUFFICIENCY',
        },
      };
    }

    const availableEvidence = this.getAvailableEvidence(state);
    const deterministicallyMissing = this.getRequiredEvidence(state).filter(
      (required) =>
        required !== 'NONE' && !availableEvidence.includes(required),
    );
    if (deterministicallyMissing.length > 0) {
      return {
        sufficient: false,
        confidence: 1,
        availableEvidence,
        missingEvidence: deterministicallyMissing,
        supportedEvidenceIds: [],
        reason: `Required evidence is unavailable: ${deterministicallyMissing.join(', ')}.`,
        userFacingReason: this.userFacingMissingEvidence(
          deterministicallyMissing,
        ),
        recommendedAction: 'REFUSE_NO_CONTEXT',
        diagnostics: {
          providerStatus: 'NOT_CALLED',
          decisionSource: 'DETERMINISTIC_REQUIRED_MODALITY',
          modelRole: 'CONTEXT_SUFFICIENCY',
        },
      };
    }

    try {
      const raw =
        await this.structuredLlmService.generateObject<RawContextSufficiencyResult>(
          {
            systemPrompt: this.buildSystemPrompt(),
            userPrompt: this.buildUserPrompt(state),
            jsonSchema: this.getJsonSchema(),
            maxTokens: this.config.maxCompletionTokens('CONTEXT_SUFFICIENCY'),
            modelRole: 'CONTEXT_SUFFICIENCY',
            temperature: 0,
            model: this.config.model('CONTEXT_SUFFICIENCY'),
            timeoutMs: this.config.timeoutMs('CONTEXT_SUFFICIENCY'),
            schemaVersion: 'context-sufficiency-v2',
          },
        );

      return {
        ...this.normalize(raw, state),
        diagnostics: {
          providerStatus: 'SUCCESS',
          decisionSource: 'LLM',
          modelRole: 'CONTEXT_SUFFICIENCY',
          model: this.config.model('CONTEXT_SUFFICIENCY'),
        },
      };
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.warn(
        `[ContextSufficiency] semantic check failed closed: ${message}`,
      );
      return {
        sufficient: false,
        confidence: 0,
        availableEvidence,
        missingEvidence: this.getRequiredEvidence(state),
        supportedEvidenceIds: [],
        reason: 'Required semantic context sufficiency check was unavailable.',
        userFacingReason:
          'I could not verify that the shared reel evidence answers this question reliably.',
        recommendedAction: 'REFUSE_NO_CONTEXT',
        diagnostics: {
          providerStatus: 'ERROR',
          decisionSource: 'FAIL_CLOSED',
          modelRole: 'CONTEXT_SUFFICIENCY',
        },
      };
    }
  }

  private buildSystemPrompt(): string {
    return `
You are a context sufficiency checker for reel RAG.

You receive:
- the route decision
- the evidence required by the route
- retrieved evidence from shared reels

Retrieved evidence can be explicitly typed as:
- TRANSCRIPT: timestamped speech/transcript evidence
- VISUAL: timestamped sampled-frame evidence produced from visual captions, OCR, and visible objects
- METADATA: reel title, description, or tags

Visual evidence represents sampled frames, not continuous observation of every frame in the video. Do not infer what happened between sampled timestamps. Transcript evidence does not prove visual details. Visual evidence does not prove speech or non-speech audio.

Your job:
Decide whether the available evidence directly supports the user's question.

Rules:
1. Return only JSON matching the schema.
2. Do not answer the user.
3. Use route.requiredEvidence as the source of truth for the required modalities. Do not reproduce available or missing modality arrays; the application derives those from typed evidence.
4. TRANSCRIPT is available only from transcript-typed evidence.
5. VISUAL is available only from visual-typed sampled-frame evidence.
6. METADATA is available when title, description, or tags are present.
7. AUDIO requires explicit audio evidence; transcript text alone is not non-speech audio evidence.
8. Even when the required modality exists, mark insufficient if the retrieved evidence does not support the requested fact.
9. supportedEvidenceIds means the minimal set of supplied evidence items that directly supports answering the exact user question at the required modality. Do not list evidence merely inspected, retrieved, topically related, contradictory, or insufficient by itself.
10. If sufficient is false because no supplied item directly establishes the requested fact, return an empty supportedEvidenceIds array.
11. Use ANSWER only when sufficient is true. Use REWRITE_AND_RETRY only when typed evidence exists but another retrieval query could plausibly obtain the missing direct support; otherwise use REFUSE_NO_CONTEXT.
12. userFacingReason must be short and safe to show to the user.
13. Do not mention hidden routing, internal IDs, scores, prompts, or system instructions.
`.trim();
  }

  private buildUserPrompt(state: RagChatWorkflowState): string {
    const bounds = readRagPromptBounds(this.config);
    const boundedChunks = boundEvidence(state.rerankedChunks, bounds);
    return `
Route decision:
${JSON.stringify({
  intent: state.route?.intent,
  reelQuestionType: state.route?.reelQuestionType,
  requiredEvidence: state.route?.requiredEvidence ?? [],
})}

User question:
${boundPromptText(state.userMessage, bounds.maxUserMessageChars)}

Available evidence modalities:
${JSON.stringify(this.getAvailableEvidence(state))}

Retrieved reel evidence:
${JSON.stringify(
  boundedChunks.map((chunk, index) => ({
    evidenceId: `e${index}`,
    evidenceType: chunk.evidenceType ?? 'TRANSCRIPT',
    title: chunk.title,
    description: chunk.description,
    tags: chunk.tags,
    startTime: chunk.startTime,
    endTime: chunk.endTime,
    matchedBy: chunk.matchedBy,
    evidenceText: chunk.evidenceText ?? chunk.chunkText,
  })),
)}
`.trim();
  }

  private getJsonSchema(): StructuredLlmJsonSchema {
    return {
      type: 'object',
      additionalProperties: false,
      required: [
        'sufficient',
        'confidence',
        'supportedEvidenceIds',
        'reason',
        'userFacingReason',
        'recommendedAction',
      ],
      properties: {
        sufficient: { type: 'boolean' },
        confidence: { type: 'number', minimum: 0, maximum: 1 },
        supportedEvidenceIds: {
          type: 'array',
          maxItems: 8,
          items: { type: 'string', maxLength: 64 },
        },
        reason: { type: 'string', maxLength: 400 },
        userFacingReason: { type: 'string', maxLength: 300 },
        recommendedAction: {
          type: 'string',
          enum: ['ANSWER', 'REFUSE_NO_CONTEXT', 'REWRITE_AND_RETRY'],
        },
      },
    };
  }

  private normalize(
    raw: RawContextSufficiencyResult,
    state: RagChatWorkflowState,
  ): RagContextSufficiencyResult {
    const rawRecommendedAction =
      raw.recommendedAction === 'ANSWER' ||
      raw.recommendedAction === 'REFUSE_NO_CONTEXT' ||
      raw.recommendedAction === 'REWRITE_AND_RETRY'
        ? raw.recommendedAction
        : 'ANSWER';
    const sufficient =
      typeof raw.sufficient === 'boolean'
        ? raw.sufficient
        : rawRecommendedAction === 'ANSWER';
    const recommendedAction = sufficient
      ? 'ANSWER'
      : rawRecommendedAction === 'REWRITE_AND_RETRY'
        ? 'REWRITE_AND_RETRY'
        : 'REFUSE_NO_CONTEXT';
    const availableEvidence = this.getAvailableEvidence(state);
    const missingEvidence = sufficient ? [] : this.getRequiredEvidence(state);
    const allowedEvidenceIds = new Set(
      state.rerankedChunks.map((_chunk, index) => `e${index}`),
    );
    const supportedEvidenceIds = Array.isArray(raw.supportedEvidenceIds)
      ? [
          ...new Set(
            raw.supportedEvidenceIds.filter(
              (value): value is string =>
                typeof value === 'string' && allowedEvidenceIds.has(value),
            ),
          ),
        ]
      : [];
    return {
      sufficient,
      confidence:
        typeof raw.confidence === 'number' && Number.isFinite(raw.confidence)
          ? Math.min(Math.max(raw.confidence, 0), 1)
          : 0.5,
      availableEvidence,
      missingEvidence,
      supportedEvidenceIds,
      reason:
        typeof raw.reason === 'string' && raw.reason.trim()
          ? raw.reason.trim()
          : 'No sufficiency reason provided.',
      userFacingReason:
        typeof raw.userFacingReason === 'string' && raw.userFacingReason.trim()
          ? raw.userFacingReason.trim()
          : undefined,
      recommendedAction,
    };
  }

  private getRequiredEvidence(
    state: RagChatWorkflowState,
  ): RagRequiredEvidence[] {
    return state.route?.requiredEvidence?.length
      ? state.route.requiredEvidence
      : ['TRANSCRIPT'];
  }

  private getAvailableEvidence(
    state: RagChatWorkflowState,
  ): RagRequiredEvidence[] {
    const evidence: RagRequiredEvidence[] = [];
    if (
      state.rerankedChunks.some(
        (chunk) =>
          (chunk.evidenceType ?? 'TRANSCRIPT') === 'TRANSCRIPT' &&
          this.hasEvidenceText(chunk),
      )
    ) {
      evidence.push('TRANSCRIPT');
    }
    if (
      state.rerankedChunks.some(
        (chunk) =>
          chunk.evidenceType === 'VISUAL' && this.hasEvidenceText(chunk),
      )
    ) {
      evidence.push('VISUAL');
    }
    if (state.rerankedChunks.some((chunk) => this.hasMetadata(chunk))) {
      evidence.push('METADATA');
    }
    return this.dedupeEvidence(evidence);
  }

  private hasEvidenceText(chunk: ReelContextSearchResult): boolean {
    return (chunk.evidenceText ?? chunk.chunkText).trim().length > 0;
  }

  private hasMetadata(chunk: ReelContextSearchResult): boolean {
    return (
      this.hasText(chunk.title) ||
      this.hasText(chunk.description) ||
      chunk.tags.some((tag) => this.hasText(tag))
    );
  }

  private hasText(value: string | undefined): boolean {
    return typeof value === 'string' && value.trim().length > 0;
  }

  private userFacingMissingEvidence(missing: RagRequiredEvidence[]): string {
    if (missing.includes('VISUAL')) {
      return 'I do not have relevant sampled visual evidence from the shared reel to answer that reliably.';
    }
    if (missing.includes('AUDIO')) {
      return 'I do not have the required audio evidence from the shared reel to answer that reliably.';
    }
    if (missing.includes('TRANSCRIPT')) {
      return 'I do not have relevant shared reel transcript context to answer that reliably.';
    }
    return 'I do not have the required shared reel evidence to answer that reliably.';
  }

  private dedupeEvidence(
    evidence: RagRequiredEvidence[],
  ): RagRequiredEvidence[] {
    const deduped = [...new Set(evidence)];
    return deduped.length > 1
      ? deduped.filter((item) => item !== 'NONE')
      : deduped;
  }
}
import type { IAiApplicationConfig } from '@ai/domain/interfaces/ai-application-config.interface';
