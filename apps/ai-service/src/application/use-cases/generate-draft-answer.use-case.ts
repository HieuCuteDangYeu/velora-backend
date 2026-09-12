import type { IAiApplicationConfig } from '@ai/domain/interfaces/ai-application-config.interface';
import type { IChatPromptBuilder } from '@ai/domain/interfaces/chat-prompt-builder.interface';
import type {
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
import { assessExactEvidenceProvenance } from './exact-evidence-provenance';

interface RawDraftAnswer {
  answer?: unknown;
  claims?: unknown;
}

const QUANTITY_QUESTION_PATTERN =
  /\b(?:how many|how much|how low|how high|how long|how old|number of|what (?:number|percentage|percent|year|date))\b/i;

const NUMBER_WORD_VALUES = new Map<string, string>([
  ['zero', '0'],
  ['one', '1'],
  ['two', '2'],
  ['three', '3'],
  ['four', '4'],
  ['five', '5'],
  ['six', '6'],
  ['seven', '7'],
  ['eight', '8'],
  ['nine', '9'],
  ['ten', '10'],
  ['eleven', '11'],
  ['twelve', '12'],
  ['thirteen', '13'],
  ['fourteen', '14'],
  ['fifteen', '15'],
  ['sixteen', '16'],
  ['seventeen', '17'],
  ['eighteen', '18'],
  ['nineteen', '19'],
  ['twenty', '20'],
  ['thirty', '30'],
  ['forty', '40'],
  ['fifty', '50'],
  ['sixty', '60'],
  ['seventy', '70'],
  ['eighty', '80'],
  ['ninety', '90'],
  ['hundred', '100'],
  ['thousand', '1000'],
]);

const EXTRACTIVE_STOPWORDS = new Set([
  'a',
  'about',
  'an',
  'and',
  'are',
  'as',
  'at',
  'be',
  'being',
  'by',
  'can',
  'do',
  'does',
  'for',
  'from',
  'has',
  'have',
  'how',
  'in',
  'into',
  'is',
  'it',
  'of',
  'on',
  'or',
  'say',
  'said',
  'should',
  'someone',
  'that',
  'the',
  'they',
  'this',
  'to',
  'under',
  'use',
  'used',
  'using',
  'was',
  'were',
  'what',
  'where',
  'which',
  'who',
  'why',
  'with',
]);

const REFUSAL_ANSWER_PATTERN =
  /\b(?:no relevant|not enough|cannot|can't|unable|do not have|don't have|not available|could not)\b/i;

function quantityTokens(value: string): Set<string> {
  const tokens: string[] =
    value.toLowerCase().match(/[a-z]+|\d+(?:[.,]\d+)?/g) ?? [];
  return new Set<string>(
    tokens.flatMap((token) => {
      const wordValue = NUMBER_WORD_VALUES.get(token);
      if (wordValue) return [wordValue];
      if (/^\d/.test(token)) return [token.replace(/,/g, '')];
      return [];
    }),
  );
}

function extractiveTokens(value: string): string[] {
  return (
    value
      .toLowerCase()
      .match(/[a-z]+|\d+(?:[.,]\d+)?/g)
      ?.map((token) => NUMBER_WORD_VALUES.get(token) ?? token)
      .filter((token) => !EXTRACTIVE_STOPWORDS.has(token)) ?? []
  );
}

function splitEvidenceIntoSegments(value: string): string[] {
  const normalized = value.replace(/\s+/g, ' ').trim();
  if (!normalized) return [];

  const sentences = normalized
    .split(/(?<=[!?])\s+|(?<=[A-Za-z]\.)\s+(?=[A-Z])/)
    .map((item) => item.trim())
    .filter(Boolean);
  if (sentences.length > 1 || normalized.length <= 600) return sentences;

  const clauses = normalized
    .split(/(?<=[,;:])\s+/)
    .map((item) => item.trim())
    .filter(Boolean);
  return clauses.length > 1 ? clauses : [normalized];
}

function overlapCount(left: string[], right: string[]): number {
  const rightSet = new Set(right);
  return new Set(left.filter((token) => rightSet.has(token))).size;
}

function hasSupportedQuantity(
  question: string,
  evidence: string[],
  answer: string,
): boolean {
  if (!QUANTITY_QUESTION_PATTERN.test(question)) return true;
  const evidenceQuantities = quantityTokens(evidence.join(' '));
  if (evidenceQuantities.size === 0) return true;
  const answerQuantities = quantityTokens(answer);
  return [...answerQuantities].some((value) => evidenceQuantities.has(value));
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

    const finalize = (candidate: RawDraftAnswer): RagDraftAnswer => {
      const normalized = this.normalize(
        candidate,
        state,
        allowedEvidenceIds,
        authorizedEvidenceText,
      );
      return this.extractiveTranscriptFallback(
        state,
        normalized,
        authorizedEvidence,
      );
    };

    let raw: RawDraftAnswer;
    try {
      raw = await request(systemPrompt);
      return { ...finalize(raw), diagnostics };
    } catch (error: unknown) {
      if (!(error instanceof DraftAnswerContractError)) throw error;
      raw = await request(
        `${systemPrompt}\n\nThe previous response violated the local grounding contract, including the explicit-quantity requirement. Re-answer the exact requested relation with the supported value stated explicitly, then return a non-empty, exhaustive claim mapping using only the supplied authorized evidence IDs.`,
      );
    }

    return { ...finalize(raw), diagnostics };
  }

  private extractiveTranscriptFallback(
    state: RagChatWorkflowState,
    draft: RagDraftAnswer,
    authorizedEvidence: Array<{
      evidenceId: string;
      evidenceType: string;
      evidenceText: string;
    }>,
  ): RagDraftAnswer {
    if (
      state.route?.intent !== 'REEL_VIDEO_QUESTION' ||
      !(state.route.requiredEvidence ?? []).includes('TRANSCRIPT') ||
      authorizedEvidence.length === 0
    ) {
      return draft;
    }

    const exactProvenance = assessExactEvidenceProvenance({
      answer: draft.answer,
      candidates: authorizedEvidence
        .filter((item) => item.evidenceType === 'TRANSCRIPT')
        .map((item) => ({
          evidenceType: 'TRANSCRIPT' as const,
          evidenceText: item.evidenceText,
        })),
    });
    if (
      exactProvenance.supported &&
      !REFUSAL_ANSWER_PATTERN.test(draft.answer)
    ) {
      return draft;
    }

    const questionTokens = extractiveTokens(state.userMessage);
    const answerTokens = extractiveTokens(draft.answer);
    let best:
      | {
          answer: string;
          evidenceId: string;
          questionOverlap: number;
          answerOverlap: number;
          length: number;
        }
      | undefined;

    for (const item of authorizedEvidence) {
      if (item.evidenceType !== 'TRANSCRIPT' || !item.evidenceText.trim()) {
        continue;
      }
      for (const segment of splitEvidenceIntoSegments(item.evidenceText)) {
        const segmentTokens = extractiveTokens(segment);
        const questionOverlap = overlapCount(questionTokens, segmentTokens);
        const answerOverlap = overlapCount(answerTokens, segmentTokens);
        if (questionOverlap === 0) continue;

        const candidate = {
          answer: segment,
          evidenceId: item.evidenceId,
          questionOverlap,
          answerOverlap,
          length: segmentTokens.length,
        };
        if (
          !best ||
          candidate.questionOverlap > best.questionOverlap ||
          (candidate.questionOverlap === best.questionOverlap &&
            candidate.answerOverlap > best.answerOverlap) ||
          (candidate.questionOverlap === best.questionOverlap &&
            candidate.answerOverlap === best.answerOverlap &&
            candidate.length < best.length)
        ) {
          best = candidate;
        }
      }
    }

    if (!best) return draft;
    return {
      ...draft,
      answer: best.answer,
      claims: [{ claim: best.answer, evidenceIds: [best.evidenceId] }],
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
  ): RagDraftAnswer {
    const answer = typeof raw.answer === 'string' ? raw.answer.trim() : '';
    if (!answer)
      throw new DraftAnswerContractError(
        'Answer model returned an empty answer',
      );
    if (
      !hasSupportedQuantity(state.userMessage, authorizedEvidenceText, answer)
    ) {
      throw new DraftAnswerContractError(
        'Answer model omitted a directly supported quantity',
      );
    }

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
