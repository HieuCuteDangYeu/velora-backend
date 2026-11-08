import type { IAiApplicationConfig } from '@ai/domain/interfaces/ai-application-config.interface';
import type {
  RagAnswerClaim,
  RagChatWorkflowState,
  RagGenerationEvidence,
} from '@ai/domain/interfaces/rag-chat-workflow.interface';
import type {
  IStructuredLlmService,
  StructuredLlmCallDiagnostics,
} from '@ai/domain/interfaces/structured-llm.service.interface';
import { Inject, Injectable } from '@nestjs/common';
import {
  boundClaimMappings,
  boundEvidence,
  boundPromptText,
  boundTextItems,
  readRagPromptBounds,
  selectRagAnswerEvidenceIds,
  transcriptSegmentPromptBounds,
  transcriptSegmentRequestKind,
} from '@ai/domain/services/rag-prompt-bounds';
import {
  MULTIMODAL_TRANSCRIPT_SUMMARY_MAX_CHARS,
  ragAnswerBudget,
  TRANSCRIPT_SEGMENT_SUMMARY_MAX_CHARS,
  validateRagAnswerContract,
  missingRequiredReelEvidencePairs,
} from '@ai/domain/services/rag-answer-contract';
import {
  hasIncompleteTranscriptEnding,
  isTranscriptSentenceSelectionRequest,
} from '@ai/domain/services/rag-transcript-sentence-selection';

interface RawGroundedAnswerRevision {
  answer?: unknown;
  evidenceIds?: unknown;
  claims?: unknown;
}

export interface GroundedAnswerRevision {
  answer: string;
  evidenceIds: string[];
  claims?: RagAnswerClaim[];
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
    if (isTranscriptSentenceSelectionRequest(state.route)) {
      return undefined;
    }

    const requestKind = transcriptSegmentRequestKind(
      state.userMessage,
      state.route,
      state.retrievalPlan,
    );
    const bounds = transcriptSegmentPromptBounds(
      readRagPromptBounds(this.config),
      requestKind,
    );
    const answerBudget = ragAnswerBudget(state.route?.reelQuestionType, {
      multiReelTranscriptComparison: requestKind === 'MULTI_REEL_COMPARISON',
      transcriptSummaryMaxChars:
        requestKind === 'SUMMARY'
          ? state.route?.reelQuestionType === 'MULTIMODAL_CONTENT'
            ? MULTIMODAL_TRANSCRIPT_SUMMARY_MAX_CHARS
            : TRANSCRIPT_SEGMENT_SUMMARY_MAX_CHARS
          : undefined,
    });
    const windowStart =
      state.retrievalPlan?.transcriptTimestampSec ??
      state.retrievalPlan?.sourceTimestampSec;
    const windowEnd =
      state.retrievalPlan?.transcriptTimestampEndSec ??
      state.retrievalPlan?.sourceTimestampEndSec;
    const verifierIssues = boundTextItems(
      verification.issues ?? [],
      (issue) => issue,
      (_issue, text) => text,
      bounds.maxClaims,
      bounds.maxClaimChars,
      bounds.maxClaimsTotalChars,
    );
    const verifierSupportedClaims = boundClaimMappings(
      verification.supportedClaimMappings ?? [],
      bounds,
    );
    const verifierUnsupportedClaims = (
      verification.diagnostics?.unsupportedClaimMappings ?? []
    )
      .slice(0, bounds.maxClaims)
      .map((claim) => ({
        claim: boundPromptText(claim.claim, bounds.maxClaimChars),
        reason: boundPromptText(claim.reason, bounds.maxClaimChars),
      }));
    const revisionClaimsRequired = verifierSupportedClaims.length > 0;
    const boundedChunks = boundEvidence(state.rerankedChunks, bounds, {
      preserveTail: true,
      focusText: state.userMessage,
      preserveReelCoverage: state.retrievalPlan?.requiresReelCoverage === true,
      requiredEvidenceTypes: state.route?.requiredEvidence ?? [],
    });
    const answerEvidenceIds = selectRagAnswerEvidenceIds(
      boundedChunks,
      state.contextSufficiency,
      state.route,
      state.retrievalPlan?.requiresReelCoverage === true,
      requestKind === 'SUMMARY',
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
    const exactWindowEvidence = evidence.filter(
      (item) =>
        typeof windowStart === 'number' &&
        typeof windowEnd === 'number' &&
        item.evidenceType === 'TRANSCRIPT' &&
        typeof item.startTime === 'number' &&
        typeof item.endTime === 'number' &&
        Math.abs(item.startTime - windowStart) <= 0.05 &&
        Math.abs(item.endTime - windowEnd) <= 0.05,
    );

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
          'Answer the exact relation requested by the user, including noisy or punctuation-free ASR when the evidence semantically supports it.',
          'For direct fact and exact quote questions, reuse distinctive source wording, names, values, and relations. For SUMMARY requests, preserve those facts while paraphrasing complete statements according to the summary instructions below.',
          'Do not construct arbitrary source substrings and do not invent facts.',
          'Return the shortest complete revised answer for the supplied answer shape and budget, plus the smallest supporting evidence ID set.',
          'When multiple Reels and modalities are required, include evidence from every required modality for each Reel; evidence from another Reel cannot substitute.',
          'For metadata, title, tag, quantity, opening statement, or quote questions, provide the exact value directly without conversational preambles (e.g. do not write "The title is...", "The tags are...", etc.).',
          'If the current answer is supported but indirect, repetitive, or over-verbose, delete the unrelated material while preserving the supported fact that answers the question.',
          'Treat verifier issues as an edit list: correct or remove only the disputed claim, and retain every other supported fact, quantity, negation, and relation the user asked about.',
          'When verifierSupportedClaims is nonempty after a grounding rejection, use it as the allowlist of factual propositions for the revision. Preserve those supported facts and remove disputed implications. For SUMMARY, paraphrase the approved propositions concisely in new wording and do not reproduce the transcript; for direct facts or exact quotes, retain the source wording. Never add a factual claim outside the allowlist.',
          ...(verifierUnsupportedClaims.length > 0
            ? [
                'Treat verifierUnsupportedClaims as hard exclusions. Do not repeat or paraphrase those claims, even when neighboring transcript words make them seem likely.',
              ]
            : []),
          ...(revisionClaimsRequired
            ? [
                'Return one claim mapping per factual sentence in the revised answer. Each claim must be an exact substring of the answer and use only its authorized evidence IDs.',
              ]
            : []),
          ...(requestKind === 'MULTI_REEL_COMPARISON'
            ? [
                'For this comparison, preserve the complete earliest transcript segment for each Reel in its own labeled section and source order, then give one concise comparison that follows from those passages. Do not use ellipses, transfer facts between Reels, or claim a fact is shared unless both passages support it.',
              ]
            : requestKind === 'SUMMARY'
              ? [
                  state.route?.reelQuestionType === 'MULTIMODAL_CONTENT'
                    ? 'For this multimodal time-bounded request, format the answer as exactly two labeled sections: `Visible: ...` followed by `Spoken: ...`. Keep the Visible section to one brief observation and summarize only transcript text inside the requested interval in concise sentences proportional to the supported material. For long intervals with several distinct statements, use 4–6 concise Spoken sentences and cover the beginning, middle, and end in chronological order. Preserve actors, actions, relations, negation, causes, and key quantities; include distinct questions, thanks, preferences, negations, and direct insults when they matter. Do not collapse several turns into one vague statement. Use fewer sentences only when the evidence contains fewer distinct facts; do not pad short segments. Keep spoken questions as questions instead of inferring a speaker’s belief or intent, and do not add a causal link from adjacent statements unless the transcript states one. Do not repeat the frame timestamp or transcript time window; those belong in citations. Omit trailing keyword-only fragments from visual evidence. Do not quote the transcript or summarize it sentence by sentence. Omit filler and repeated dialogue while preserving speaker changes and uncertainty. Keep each action and its object together. Omit a clipped transcript tail unless needed; if needed, quote only the supplied words and state that the indexed excerpt ends there without inferring what the speaker does next.'
                    : 'For a time-bounded transcript summary, write 2–4 short sentences with one main point per sentence, using only transcript text inside the requested interval. Cover distinct questions, thanks, explicit preferences or negations, and stated abilities that matter to the request. Preserve the force of direct insults, quantities, negation, conditions, speaker changes, and uncertainty. Keep a spoken question as a question rather than inferring the speaker’s belief or intent, and do not add a causal link from adjacent statements unless the transcript states one. Do not repeat the requested time window; it belongs in the citation. Do not quote the transcript or summarize it sentence by sentence. Omit filler and repeated dialogue. Omit a clipped transcript tail unless needed; if needed, quote only the supplied words and state that the indexed excerpt ends there without claiming the speaker stops or completes the thought.',
                ]
              : [
                  'Evidence is for deciding the answer, not for reproducing surrounding transcript.',
                ]),
          ...(requestKind === 'SUMMARY'
            ? [
                'For SUMMARY, paraphrase complete statements; the general direct-source wording rule does not authorize verbatim quotes.',
                'When requestedTranscriptWindow.exactRangeEvidenceIds is nonempty, use only those evidence IDs as the source scope; ignore neighboring transcript excerpts. If an ID is listed in requestedTranscriptWindow.truncatedEvidenceIds, omit its trailing fragment unless needed; if needed, quote only the supplied words and describe the indexed excerpt boundary, not what the speaker does next.',
              ]
            : []),
          'Never invent an evidence ID. Return only JSON matching the schema.',
        ].join(' '),
        userPrompt: JSON.stringify({
          question: boundPromptText(
            state.userMessage,
            bounds.maxUserMessageChars,
          ),
          requestedTranscriptWindow:
            requestKind === 'SUMMARY' &&
            typeof windowStart === 'number' &&
            typeof windowEnd === 'number'
              ? {
                  startTime: windowStart,
                  endTime: windowEnd,
                  exactRangeEvidenceIds: exactWindowEvidence.map(
                    (item) => item.evidenceId,
                  ),
                  truncatedEvidenceIds: exactWindowEvidence.flatMap((item) =>
                    hasIncompleteTranscriptEnding(item.evidenceText)
                      ? [item.evidenceId]
                      : [],
                  ),
                }
              : undefined,
          answerShape: answerBudget.shape,
          maxAnswerChars: answerBudget.maxChars,
          transcriptSegmentRequestKind: requestKind,
          currentAnswer: boundPromptText(
            state.answer ?? '',
            bounds.maxAnswerChars,
          ),
          verifierIssues,
          verifierSupportedClaims,
          verifierUnsupportedClaims,
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
          evidence,
        }),
        jsonSchema: {
          type: 'object',
          additionalProperties: false,
          required: [
            'answer',
            'evidenceIds',
            ...(revisionClaimsRequired ? ['claims'] : []),
          ],
          properties: {
            answer: { type: 'string', maxLength: answerBudget.maxChars },
            evidenceIds: {
              type: 'array',
              minItems: 1,
              maxItems: evidence.length,
              items: { type: 'string', maxLength: 64 },
            },
            ...(revisionClaimsRequired
              ? {
                  claims: {
                    type: 'array',
                    minItems: 1,
                    maxItems: 12,
                    items: {
                      type: 'object',
                      additionalProperties: false,
                      required: ['claim', 'evidenceIds'],
                      properties: {
                        claim: { type: 'string', maxLength: 500 },
                        evidenceIds: {
                          type: 'array',
                          minItems: 1,
                          maxItems: 3,
                          items: { type: 'string', maxLength: 64 },
                        },
                      },
                    },
                  },
                }
              : {}),
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
        ].slice(0, evidence.length)
      : [];

    const revisionClaims = revisionClaimsRequired
      ? Array.isArray(raw.claims)
        ? raw.claims.flatMap((value): RagAnswerClaim[] => {
            if (!value || typeof value !== 'object') return [];
            const candidate = value as Record<string, unknown>;
            const claim =
              typeof candidate.claim === 'string' ? candidate.claim.trim() : '';
            const claimEvidenceIds = Array.isArray(candidate.evidenceIds)
              ? [...new Set(
                  candidate.evidenceIds.filter(
                    (id): id is string =>
                      typeof id === 'string' &&
                      allowedIds.has(id) &&
                      evidenceIds.includes(id),
                  ),
                )]
              : [];
            return claim && answer.includes(claim) && claimEvidenceIds.length > 0
              ? [{ claim, evidenceIds: claimEvidenceIds }]
              : [];
          })
        : []
      : undefined;

    const rawClaimCount = Array.isArray(raw.claims) ? raw.claims.length : -1;
    if (
      !answer ||
      evidenceIds.length === 0 ||
      (revisionClaimsRequired &&
        (!Array.isArray(raw.claims) ||
          !revisionClaims ||
          revisionClaims.length !== rawClaimCount))
    ) {
      throw new Error(
        'Answer revision returned incomplete claim mappings, an empty answer, or unknown evidence IDs',
      );
    }

    const selectedEvidence = evidence.filter((item) =>
      evidenceIds.includes(item.evidenceId),
    );
    const requiredEvidenceTypes = (state.route?.requiredEvidence ?? []).filter(
      (type) => type !== 'NONE' && type !== 'AUDIO',
    );
    if (
      requiredEvidenceTypes.some(
        (type) => !selectedEvidence.some((item) => item.evidenceType === type),
      )
    ) {
      return undefined;
    }
    if (state.retrievalPlan?.requiresReelCoverage === true) {
      const requiredReelIds = [
        ...new Set(
          state.retrievedChunks
            .map((chunk) => chunk.reelId)
            .filter((reelId): reelId is string => Boolean(reelId)),
        ),
      ];
      if (
        missingRequiredReelEvidencePairs(
          selectedEvidence,
          requiredReelIds,
          requiredEvidenceTypes,
        ).length > 0
      ) {
        return undefined;
      }
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
      ...(revisionClaims ? { claims: revisionClaims } : {}),
      generationEvidence: selectedEvidence,
      modelRole: 'ANSWER_REVISION',
      diagnostics,
    };
  }
}
