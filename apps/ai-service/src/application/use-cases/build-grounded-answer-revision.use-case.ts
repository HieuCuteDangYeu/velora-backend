import type { IAiApplicationConfig } from '@ai/domain/interfaces/ai-application-config.interface';
import type {
  RagChatWorkflowState,
  RagGenerationEvidence,
} from '@ai/domain/interfaces/rag-chat-workflow.interface';
import type {
  IStructuredLlmService,
  StructuredLlmCallDiagnostics,
} from '@ai/domain/interfaces/structured-llm.service.interface';
import { Inject, Injectable } from '@nestjs/common';
import {
  boundEvidence,
  boundPromptText,
  boundTextItems,
  readRagPromptBounds,
  selectRagAnswerEvidenceIds,
} from '@ai/domain/services/rag-prompt-bounds';
import {
  ragAnswerBudget,
  validateRagAnswerContract,
} from '@ai/domain/services/rag-answer-contract';

interface RawGroundedAnswerRevision {
  answer?: unknown;
  evidenceIds?: unknown;
}

export interface GroundedAnswerRevision {
  answer: string;
  evidenceIds: string[];
  modelRole: 'ANSWER_REVISION';
  diagnostics: StructuredLlmCallDiagnostics[];
  generationEvidence: RagGenerationEvidence[];
}

@Injectable()
export class BuildGroundedAnswerRevisionUseCase {
  constructor(
    @Inject('IStructuredLlmService')
    private readonly structuredLlm: IStructuredLlmService,
    @Inject('IAiApplicationConfig')
    private readonly config: IAiApplicationConfig,
  ) {}

  async execute(state: RagChatWorkflowState): Promise<string | undefined> {
    return (await this.executeWithProvenance(state))?.answer;
  }

  async executeWithProvenance(
    state: RagChatWorkflowState,
  ): Promise<GroundedAnswerRevision | undefined> {
    const verification = state.verification;
    if (
      !['VERIFIER_REVISION', 'CITATION_REVISION'].includes(
        state.nextDraftSource,
      ) ||
      state.route?.intent !== 'REEL_VIDEO_QUESTION' ||
      !verification?.requiresRevision
    ) {
      return undefined;
    }

    const bounds = readRagPromptBounds(this.config);
    const answerBudget = ragAnswerBudget(state.route?.reelQuestionType);
    const verifierIssues = boundTextItems(
      verification.issues ?? [],
      (issue) => issue,
      (_issue, text) => text,
      bounds.maxClaims,
      bounds.maxClaimChars,
      bounds.maxClaimsTotalChars,
    );
    const boundedChunks = boundEvidence(state.rerankedChunks, bounds, {
      preserveTail: true,
      focusText: state.userMessage,
      preserveReelCoverage: state.retrievalPlan?.requiresReelCoverage === true,
    });
    const answerEvidenceIds = selectRagAnswerEvidenceIds(
      boundedChunks,
      state.contextSufficiency,
      state.route,
    );
    const evidence = boundedChunks.flatMap((chunk, index) => {
      if (!answerEvidenceIds.has(`e${index}`)) return [];
      const evidenceText =
        chunk.evidenceText?.trim() ||
        [
          chunk.title ? `Title: ${chunk.title.trim()}` : undefined,
          Array.isArray(chunk.tags) && chunk.tags.length > 0
            ? `Tags: ${chunk.tags.join(', ')}`
            : undefined,
          chunk.description?.trim()
            ? `Description: ${chunk.description.trim()}`
            : undefined,
          chunk.chunkText?.trim(),
        ]
          .filter((val): val is string => Boolean(val && val.length > 0))
          .join(' - ')
          .trim();
      if (!evidenceText) return [];
      return [
        {
          evidenceId: `e${index}`,
          sourceId: chunk.chunkId,
          indexVersion: chunk.indexVersion,
          reelId: chunk.reelId,
          evidenceType: chunk.evidenceType ?? 'TRANSCRIPT',
          evidenceText,
          startTime: chunk.startTime,
          endTime: chunk.endTime,
        },
      ];
    });
    if (evidence.length === 0) return undefined;

    const firstCompleteSentenceRequest =
      state.route.requiredEvidence?.includes('TRANSCRIPT') === true &&
      /\b(?:quote|first complete sentence|first (?:statement|sentence)|opening statement)\b/i.test(
        state.userMessage,
      );
    const transcriptEvidenceCount = evidence.filter(
      (item) => item.evidenceType === 'TRANSCRIPT',
    ).length;
    let candidateCharactersRemaining = bounds.maxEvidenceTotalChars;
    const perSourceSentenceBudget = Math.max(
      bounds.maxEvidenceTextChars,
      Math.floor(
        bounds.maxEvidenceTotalChars / Math.max(1, transcriptEvidenceCount),
      ),
    );
    const promptEvidence = firstCompleteSentenceRequest
      ? evidence.map((item) => {
          if (item.evidenceType !== 'TRANSCRIPT') return item;
          const source = state.rerankedChunks.find(
            (chunk) =>
              chunk.chunkId === item.sourceId && chunk.reelId === item.reelId,
          );
          const sourceText =
            source?.evidenceText?.trim() ||
            source?.chunkText?.trim() ||
            item.evidenceText;
          let sourceCharactersRemaining = perSourceSentenceBudget;
          const orderedSentenceCandidates: Array<{
            ordinal: number;
            text: string;
          }> = [];
          const sentences = sourceText
            .split(/(?<=[.!?])\s+|\n+/)
            .map((text) => text.trim())
            .filter(Boolean);
          for (const [index, text] of sentences.entries()) {
            if (
              text.length > bounds.maxEvidenceTextChars ||
              text.length > sourceCharactersRemaining ||
              text.length > candidateCharactersRemaining
            ) {
              break;
            }
            sourceCharactersRemaining -= text.length;
            candidateCharactersRemaining -= text.length;
            orderedSentenceCandidates.push({ ordinal: index + 1, text });
          }
          if (orderedSentenceCandidates.length === 0) return item;
          return {
            evidenceId: item.evidenceId,
            sourceId: item.sourceId,
            reelId: item.reelId,
            indexVersion: item.indexVersion,
            evidenceType: item.evidenceType,
            startTime: item.startTime,
            endTime: item.endTime,
            orderedSentenceCandidates,
          };
        })
      : evidence;
    const diagnostics: StructuredLlmCallDiagnostics[] = [];
    const primaryModel = this.config.model('ANSWER_REVISION');
    const request = (model: string) =>
      this.structuredLlm.generateObject<RawGroundedAnswerRevision>({
        model,
        timeoutMs: this.config.timeoutMs('ANSWER_REVISION'),
        temperature: 0.1,
        maxTokens: this.config.maxCompletionTokens('ANSWER_REVISION'),
        modelRole: 'ANSWER_REVISION',
        onDiagnostics: (call) => diagnostics.push(call),
        systemPrompt: [
          'Revise a rejected reel RAG answer using only the supplied authorized evidence.',
          ...(firstCompleteSentenceRequest
            ? [
                'For a first-complete-sentence request, scan orderedSentenceCandidates by source time and ordinal, ignore leading ASR fragments that do not form a complete sentence, and return the earliest complete candidate exactly rather than a later, more contextually relevant line.',
              ]
            : []),
          'Answer the exact relation requested by the user, including noisy or punctuation-free ASR when the evidence semantically supports it.',
          'Reuse distinctive source wording, names, values, and relations when they directly answer the question; do not paraphrase away the decisive fact.',
          'Do not construct arbitrary source substrings and do not invent facts.',
          'Return the shortest complete revised answer for the supplied answer shape and budget, plus the smallest supporting evidence ID set.',
          'For metadata, title, tag, quantity, opening statement, or quote questions, provide the exact value directly without conversational preambles (e.g. do not write "The title is...", "The tags are...", etc.).',
          'If the current answer is supported but indirect, repetitive, or over-verbose, delete the unrelated material while preserving the supported fact that answers the question.',
          'Evidence is for deciding the answer, not for reproducing surrounding transcript.',
          'Never invent an evidence ID. Return only JSON matching the schema.',
        ].join(' '),
        userPrompt: JSON.stringify({
          question: boundPromptText(
            state.userMessage,
            bounds.maxUserMessageChars,
          ),
          answerShape: answerBudget.shape,
          maxAnswerChars: answerBudget.maxChars,
          currentAnswer: boundPromptText(
            state.answer ?? '',
            bounds.maxAnswerChars,
          ),
          verifierIssues,
          answerQualityIssues: boundTextItems(
            verification.answerQualityIssues ?? [],
            (issue) => issue,
            (_issue, text) => text,
            bounds.maxClaims,
            bounds.maxClaimChars,
            bounds.maxClaimsTotalChars,
          ),
          verifierInstruction: boundPromptText(
            verification.revisedInstruction ?? '',
            bounds.maxClaimChars,
          ),
          evidence: promptEvidence,
        }),
        jsonSchema: {
          type: 'object',
          additionalProperties: false,
          required: ['answer', 'evidenceIds'],
          properties: {
            answer: { type: 'string', maxLength: answerBudget.maxChars },
            evidenceIds: {
              type: 'array',
              minItems: 1,
              maxItems: 3,
              items: { type: 'string', maxLength: 64 },
            },
          },
        },
      });
    let raw: RawGroundedAnswerRevision;
    try {
      raw = await request(primaryModel);
    } catch (error: unknown) {
      const record =
        error && typeof error === 'object'
          ? (error as { code?: unknown; transient?: unknown })
          : undefined;
      const fallbackModel = this.config
        .get<string>('AI_ROUTER_FALLBACK_MODEL')
        ?.trim();
      if (
        record?.transient !== true ||
        (record.code !== 'STRUCTURED_COMPLETION_PROVIDER_ERROR' &&
          record.code !== 'STRUCTURED_COMPLETION_TIMEOUT') ||
        !fallbackModel ||
        fallbackModel === primaryModel
      ) {
        throw error;
      }
      raw = await request(fallbackModel);
    }

    const answer = typeof raw.answer === 'string' ? raw.answer.trim() : '';
    const allowedIds = new Set(evidence.map((item) => item.evidenceId));
    const evidenceIds = Array.isArray(raw.evidenceIds)
      ? [
          ...new Set(
            raw.evidenceIds.filter(
              (value): value is string =>
                typeof value === 'string' && allowedIds.has(value),
            ),
          ),
        ].slice(0, 3)
      : [];

    if (!answer || evidenceIds.length === 0) {
      throw new Error(
        'Answer revision returned an empty answer or unknown evidence IDs',
      );
    }

    if (
      validateRagAnswerContract({
        answer,
        question: state.userMessage,
        evidence: evidence.map((item) => item.evidenceText),
        evidenceRequired:
          state.route?.intent === 'REEL_VIDEO_QUESTION' &&
          (state.route.requiredEvidence?.length ?? 0) > 0,
      })
    ) {
      return undefined;
    }

    return {
      answer,
      evidenceIds,
      generationEvidence: evidence,
      modelRole: 'ANSWER_REVISION',
      diagnostics,
    };
  }
}
