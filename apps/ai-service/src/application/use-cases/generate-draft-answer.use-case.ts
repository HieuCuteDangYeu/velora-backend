import type { IAiApplicationConfig } from '@ai/domain/interfaces/ai-application-config.interface';
import type { IChatPromptBuilder } from '@ai/domain/interfaces/chat-prompt-builder.interface';
import type {
  RagAnswerFallbackReason,
  RagAnswerGenerationMode,
  RagAnswerClaim,
  RagChatWorkflowState,
} from '@ai/domain/interfaces/rag-chat-workflow.interface';
import type {
  IStructuredLlmService,
  StructuredLlmCallDiagnostics,
  StructuredLlmJsonSchema,
} from '@ai/domain/interfaces/structured-llm.service.interface';
import { Inject, Injectable } from '@nestjs/common';
import {
  boundEvidence,
  boundPromptText,
  readRagPromptBounds,
  selectRagAnswerEvidenceIds,
} from '@ai/domain/services/rag-prompt-bounds';
import { validateRagAnswerContract } from '@ai/domain/services/rag-answer-contract';

interface RawDraftAnswer {
  answer?: unknown;
  claims?: unknown;
}

class DraftAnswerContractError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DraftAnswerContractError';
  }
}

export interface RagDraftAnswer {
  answer: string;
  claims: RagAnswerClaim[];
  modelRole: 'ANSWER';
  diagnostics: StructuredLlmCallDiagnostics[];
  finalizationMode: RagAnswerGenerationMode;
  fallbackReason?: RagAnswerFallbackReason;
}

@Injectable()
export class GenerateDraftAnswerUseCase {
  constructor(
    @Inject('IStructuredLlmService')
    private readonly structuredLlmService: IStructuredLlmService,
    @Inject('IChatPromptBuilder')
    private readonly chatPromptBuilder: IChatPromptBuilder,
    @Inject('IAiApplicationConfig')
    private readonly config: IAiApplicationConfig,
  ) {}

  async execute(state: RagChatWorkflowState): Promise<RagDraftAnswer> {
    const diagnostics: StructuredLlmCallDiagnostics[] = [];
    const bounds = readRagPromptBounds(this.config);
    const boundedChunks = boundEvidence(state.rerankedChunks, bounds, {
      preserveTail: true,
      focusText: state.userMessage,
    });
    const answerEvidenceIds = selectRagAnswerEvidenceIds(
      boundedChunks,
      state.contextSufficiency,
      state.route,
    );
    const answerEvidence = boundedChunks.flatMap((chunk, index) =>
      answerEvidenceIds.has(`e${index}`)
        ? [{ chunk, evidenceId: `e${index}` }]
        : [],
    );
    const authorizedEvidence = answerEvidence.map(({ chunk, evidenceId }) => ({
      evidenceId,
      evidenceType: chunk.evidenceType ?? 'TRANSCRIPT',
      evidenceText:
        chunk.evidenceText?.trim() ||
        (chunk.evidenceType === 'METADATA' ? chunk.chunkText.trim() : ''),
    }));
    const authorizedEvidenceText = authorizedEvidence.map(
      (item) => item.evidenceText,
    );
    const allowedEvidenceIds = new Set(
      answerEvidence.map(({ evidenceId }) => evidenceId),
    );
    const systemPrompt = [
      this.chatPromptBuilder.build(state, {
        includeRetrievedEvidence: false,
      }),
      'Return only JSON matching the supplied schema.',
      'Treat claims as an exhaustive grounding audit of every independently checkable factual reel assertion actually stated in answer; do not omit any such assertion.',
      'Split compound answer sentences into atomic claims when they contain multiple independently checkable facts. Each factual claim must be stated in answer exactly once; do not add factual claims that answer does not state.',
      'For every claim, declare only the authorized evidence IDs that directly support that exact assertion and requested relation or modality. Multiple claims may cite the same evidence ID, and one claim may cite multiple evidence IDs when combined support is genuinely required.',
      'Prefer the exact names, numbers, units, and relations stated by the supplied evidence. Do not import details from omitted or unrelated evidence.',
      'When the evidence directly states the requested fact, reuse its distinctive nouns, names, values, and relations instead of replacing them with broad synonyms or a high-level summary.',
      'For quantity, count, measurement, threshold, date, duration, or age questions, state the directly supported value and unit or relation explicitly. If evidence uses digits, preserve them or spell them out; never replace a supported quantity with a vague phrase.',
      'If you cannot produce a reliable claim mapping, return claims as an empty array rather than inventing evidence IDs; the downstream verifier and citation step independently validate a non-empty answer.',
      'Normal conversational statements that do not depend on reel evidence may have no claims.',
    ].join('\n\n');
    const userPrompt = JSON.stringify({
      currentQuestion: boundPromptText(
        state.userMessage,
        bounds.maxUserMessageChars,
      ),
      authorizedEvidence,
    });
    const request = (prompt: string) =>
      this.structuredLlmService.generateObject<RawDraftAnswer>({
        systemPrompt: prompt,
        userPrompt,
        jsonSchema: this.schema(),
        model: this.config.model('ANSWER'),
        timeoutMs: this.config.timeoutMs('ANSWER'),
        temperature: 0,
        maxTokens: this.config.maxCompletionTokens('ANSWER'),
        modelRole: 'ANSWER',
        onDiagnostics: (call) => diagnostics.push(call),
      });

    const fallbackCandidates =
      answerEvidence.length > 0
        ? answerEvidence
        : answerEvidenceIds.size > 0
          ? []
          : boundedChunks.map((chunk, index) => ({
              chunk,
              evidenceId: `e${index}`,
            }));
    const synthesized = (candidate: RawDraftAnswer): RagDraftAnswer => ({
      ...this.normalize(
        candidate,
        state,
        allowedEvidenceIds,
        authorizedEvidenceText,
      ),
      diagnostics,
      finalizationMode: 'SYNTHESIZED',
    });
    const fallback = (
      reason: RagAnswerFallbackReason,
    ): RagDraftAnswer | undefined => {
      const result = this.extractiveTranscriptFallback(
        state,
        fallbackCandidates,
      );
      if (!result) return undefined;
      return {
        answer: result.answer,
        claims: [
          {
            claim: result.answer,
            evidenceIds: result.evidenceIds,
          },
        ],
        modelRole: 'ANSWER',
        diagnostics,
        finalizationMode: 'EXTRACTIVE_TRANSCRIPT_FALLBACK',
        fallbackReason: reason,
      };
    };

    let raw: RawDraftAnswer;
    try {
      raw = await request(systemPrompt);
      return synthesized(raw);
    } catch (error: unknown) {
      if (!(error instanceof DraftAnswerContractError)) {
        const fallbackAnswer = fallback('ANSWER_GENERATION_FAILURE');
        if (fallbackAnswer) return fallbackAnswer;
        throw error;
      }
      try {
        raw = await request(
          `${systemPrompt}\n\nThe previous response violated the local grounding contract, including the explicit-quantity requirement. Re-answer the exact requested relation with the supported value stated explicitly, then return a non-empty, exhaustive claim mapping using only the supplied authorized evidence IDs.`,
        );
        return synthesized(raw);
      } catch (retryError: unknown) {
        const fallbackAnswer = fallback('UNUSABLE_SYNTHESIS');
        if (fallbackAnswer) return fallbackAnswer;
        throw retryError;
      }
    }
  }

  private extractiveTranscriptFallback(
    state: RagChatWorkflowState,
    candidates: Array<{
      evidenceId: string;
      chunk: {
        evidenceType?: string;
        evidenceText?: string;
        retrievalText?: string;
        chunkText?: string;
        reelId?: string;
      };
    }>,
  ): { answer: string; evidenceIds: string[] } | undefined {
    if (
      state.route?.intent !== 'REEL_VIDEO_QUESTION' ||
      !(state.route.requiredEvidence ?? []).includes('TRANSCRIPT') ||
      candidates.length === 0
    ) {
      return undefined;
    }

    const transcriptCandidates = candidates
      .map(({ chunk, evidenceId }) => ({
        evidenceId,
        evidenceType: chunk.evidenceType ?? 'TRANSCRIPT',
        evidenceText:
          chunk.evidenceText?.trim() ||
          chunk.retrievalText?.trim() ||
          chunk.chunkText?.trim() ||
          '',
        reelId: chunk.reelId,
      }))
      .filter(
        (candidate) =>
          candidate.evidenceType === 'TRANSCRIPT' &&
          candidate.evidenceText.length > 0,
      );
    if (transcriptCandidates.length === 0) return undefined;

    const first = transcriptCandidates[0];
    const selected = first.reelId
      ? transcriptCandidates
          .filter((candidate) => candidate.reelId === first.reelId)
          .slice(0, 2)
      : [first];
    const answer = selected
      .map((candidate) => candidate.evidenceText)
      .join('\n')
      .slice(0, 2_500)
      .trim();
    if (!answer) return undefined;

    return {
      answer,
      evidenceIds: selected.map((candidate) => candidate.evidenceId),
    };
  }

  private schema(): StructuredLlmJsonSchema {
    return {
      type: 'object',
      additionalProperties: false,
      required: ['answer', 'claims'],
      properties: {
        answer: { type: 'string', maxLength: 2_500 },
        claims: {
          type: 'array',
          description:
            'Exhaustive atomic grounding mappings for factual reel assertions actually stated in the answer.',
          maxItems: 12,
          items: {
            type: 'object',
            additionalProperties: false,
            required: ['claim', 'evidenceIds'],
            properties: {
              claim: {
                type: 'string',
                description:
                  'One independently checkable factual reel assertion actually stated in answer.',
                maxLength: 500,
              },
              evidenceIds: {
                type: 'array',
                description:
                  'Authorized evidence IDs that directly support this exact claim.',
                minItems: 1,
                maxItems: 3,
                items: { type: 'string', maxLength: 64 },
              },
            },
          },
        },
      },
    };
  }

  private normalize(
    raw: RawDraftAnswer,
    state: RagChatWorkflowState,
    allowedEvidenceIds: Set<string>,
    authorizedEvidenceText: string[],
  ): Omit<RagDraftAnswer, 'finalizationMode' | 'fallbackReason'> {
    const answer = typeof raw.answer === 'string' ? raw.answer.trim() : '';
    const contractError = validateRagAnswerContract({
      answer,
      question: state.userMessage,
      evidence: authorizedEvidenceText,
      evidenceRequired:
        state.route?.intent === 'REEL_VIDEO_QUESTION' &&
        (state.route.requiredEvidence?.length ?? 0) > 0,
    });
    if (contractError) throw new DraftAnswerContractError(contractError);

    const claims = Array.isArray(raw.claims)
      ? raw.claims.map((value) =>
          this.normalizeClaim(value, allowedEvidenceIds),
        )
      : [];
    return { answer, claims, modelRole: 'ANSWER', diagnostics: [] };
  }

  private normalizeClaim(
    value: unknown,
    allowedIds: Set<string>,
  ): RagAnswerClaim {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      throw new DraftAnswerContractError(
        'Answer model returned a malformed claim mapping',
      );
    }
    const record = value as Record<string, unknown>;
    const claim =
      typeof record['claim'] === 'string' ? record['claim'].trim() : '';
    const evidenceIds = Array.isArray(record['evidenceIds'])
      ? [
          ...new Set(
            record['evidenceIds'].filter(
              (id): id is string => typeof id === 'string',
            ),
          ),
        ]
      : [];
    if (!claim || evidenceIds.length === 0) {
      throw new DraftAnswerContractError(
        'Reel factual claims require evidence IDs',
      );
    }
    if (evidenceIds.some((id) => !allowedIds.has(id))) {
      throw new DraftAnswerContractError(
        'Answer model returned an unknown evidence ID',
      );
    }
    return { claim, evidenceIds };
  }
}
