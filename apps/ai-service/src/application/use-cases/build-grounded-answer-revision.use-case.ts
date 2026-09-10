import type { IAiApplicationConfig } from '@ai/domain/interfaces/ai-application-config.interface';
import type { RagChatWorkflowState } from '@ai/domain/interfaces/rag-chat-workflow.interface';
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

interface RawGroundedAnswerRevision {
  answer?: unknown;
  evidenceIds?: unknown;
}

export interface GroundedAnswerRevision {
  answer: string;
  evidenceIds: string[];
  modelRole: 'ANSWER_REVISION';
  diagnostics: StructuredLlmCallDiagnostics[];
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
    if (
      !['VERIFIER_REVISION', 'CITATION_REVISION'].includes(
        state.nextDraftSource,
      ) ||
      state.route?.intent !== 'REEL_VIDEO_QUESTION' ||
      !state.verification?.requiresRevision
    ) {
      return undefined;
    }

    const bounds = readRagPromptBounds(this.config);
    const verifierIssues = boundTextItems(
      state.verification.issues ?? [],
      (issue) => issue,
      (_issue, text) => text,
      bounds.maxClaims,
      bounds.maxClaimChars,
      bounds.maxClaimsTotalChars,
    );
    const boundedChunks = boundEvidence(state.rerankedChunks, bounds, {
      preserveTail: true,
      focusText: state.userMessage,
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
        (chunk.evidenceType === 'METADATA'
          ? chunk.chunkText.trim()
          : undefined);
      if (!evidenceText) return [];
      return [
        {
          evidenceId: `e${index}`,
          reelId: chunk.reelId,
          evidenceType: chunk.evidenceType ?? 'TRANSCRIPT',
          evidenceText,
          startTime: chunk.startTime,
          endTime: chunk.endTime,
        },
      ];
    });
    if (evidence.length === 0) return undefined;

    const diagnostics: StructuredLlmCallDiagnostics[] = [];
    const raw =
      await this.structuredLlm.generateObject<RawGroundedAnswerRevision>({
        model: this.config.model('ANSWER_REVISION'),
        timeoutMs: this.config.timeoutMs('ANSWER_REVISION'),
        temperature: 0.1,
        maxTokens: this.config.maxCompletionTokens('ANSWER_REVISION'),
        modelRole: 'ANSWER_REVISION',
        onDiagnostics: (call) => diagnostics.push(call),
        systemPrompt: [
          'Revise a rejected reel RAG answer using only the supplied authorized evidence.',
          'Answer the exact relation requested by the user, including noisy or punctuation-free ASR when the evidence semantically supports it.',
          'Reuse distinctive source wording, names, values, and relations when they directly answer the question; do not paraphrase away the decisive fact.',
          'Do not construct arbitrary source substrings and do not invent facts.',
          'Return a concise revised answer and the smallest supporting evidence ID set.',
          'Never invent an evidence ID. Return only JSON matching the schema.',
        ].join(' '),
        userPrompt: JSON.stringify({
          question: boundPromptText(
            state.userMessage,
            bounds.maxUserMessageChars,
          ),
          currentAnswer: boundPromptText(
            state.answer ?? '',
            bounds.maxAnswerChars,
          ),
          verifierIssues,
          verifierInstruction: boundPromptText(
            state.verification.revisedInstruction ?? '',
            bounds.maxClaimChars,
          ),
          evidence,
        }),
        jsonSchema: {
          type: 'object',
          additionalProperties: false,
          required: ['answer', 'evidenceIds'],
          properties: {
            answer: { type: 'string', maxLength: 2_500 },
            evidenceIds: {
              type: 'array',
              minItems: 1,
              maxItems: 3,
              items: { type: 'string', maxLength: 64 },
            },
          },
        },
      });

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

    return {
      answer,
      evidenceIds,
      modelRole: 'ANSWER_REVISION',
      diagnostics,
    };
  }
}
