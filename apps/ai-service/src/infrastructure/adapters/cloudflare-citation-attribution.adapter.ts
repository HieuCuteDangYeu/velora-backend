import {
  CitationAttributionProviderError,
  type CitationAttributionCandidate,
  type CitationAttributionResult,
  type CitationAttributionSelection,
  type CitationClaimAssessment,
  type ICitationAttributionService,
} from '@ai/domain/interfaces/citation-attribution.service.interface';
import type { RagStructuredCallFailureDiagnostic } from '@ai/domain/interfaces/rag-chat-workflow.interface';
import type { IStructuredLlmService } from '@ai/domain/interfaces/structured-llm.service.interface';
import type { IAiApplicationConfig } from '@ai/domain/interfaces/ai-application-config.interface';
import { Inject, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  boundClaimMappings,
  boundPromptText,
  boundTextItems,
  readRagPromptBounds,
} from '@ai/domain/services/rag-prompt-bounds';

interface RawClaimAssessment {
  claim?: unknown;
  supported?: unknown;
  evidenceIds?: unknown;
  confidence?: unknown;
}

interface RawCitationAttributionResult {
  claims?: unknown;
}

@Injectable()
export class CloudflareCitationAttributionAdapter implements ICitationAttributionService {
  constructor(
    @Inject('IStructuredLlmService')
    private readonly structuredLlmService: IStructuredLlmService,
    private readonly configService: ConfigService,
    @Inject('IAiApplicationConfig')
    private readonly config: IAiApplicationConfig,
  ) {}

  async attribute(input: {
    question: string;
    answer: string;
    proposedClaims?: Array<{ claim: string; evidenceIds: string[] }>;
    candidates: CitationAttributionCandidate[];
    maxCitations: number;
  }): Promise<CitationAttributionResult> {
    if (!input.answer.trim() || input.candidates.length === 0) {
      return this.emptyResult();
    }

    const model = this.config.model('CITATION_ATTRIBUTION');
    const minConfidence = this.number(
      'AI_RAG_CITATION_MIN_CONFIDENCE',
      0.65,
      0,
      1,
    );
    const bounds = readRagPromptBounds(this.config);
    const maxCandidates = Math.round(
      this.number(
        'AI_RAG_CITATION_CANDIDATE_LIMIT',
        bounds.maxEvidenceItems,
        1,
        20,
      ),
    );
    const timeoutMs = this.config.timeoutMs('CITATION_ATTRIBUTION');
    const candidates = boundTextItems(
      input.candidates.slice(0, maxCandidates),
      (candidate) => candidate.evidenceText,
      (candidate, evidenceText) => ({ ...candidate, evidenceText }),
      bounds.maxEvidenceItems,
      bounds.maxEvidenceTextChars,
      bounds.maxEvidenceTotalChars,
    ).map((candidate) => ({
      ...candidate,
      title: candidate.title
        ? boundPromptText(candidate.title, bounds.maxEvidenceTitleChars)
        : candidate.title,
    }));

    const semanticCalls: RagStructuredCallFailureDiagnostic[] = [];
    let result: RawCitationAttributionResult;
    try {
      result =
        await this.structuredLlmService.generateObject<RawCitationAttributionResult>(
          {
            model,
            systemPrompt: this.systemPrompt(),
            userPrompt: this.userPrompt({ ...input, candidates }),
            jsonSchema: {
              type: 'object',
              properties: {
                claims: {
                  type: 'array',
                  maxItems: 12,
                  items: {
                    type: 'object',
                    properties: {
                      claim: { type: 'string', maxLength: 500 },
                      supported: { type: 'boolean' },
                      evidenceIds: {
                        type: 'array',
                        items: { type: 'string', maxLength: 64 },
                        maxItems: 3,
                      },
                      confidence: { type: 'number', minimum: 0, maximum: 1 },
                    },
                    required: [
                      'claim',
                      'supported',
                      'evidenceIds',
                      'confidence',
                    ],
                    additionalProperties: false,
                  },
                },
              },
              required: ['claims'],
              additionalProperties: false,
            },
            maxTokens: this.config.maxCompletionTokens('CITATION_ATTRIBUTION'),
            modelRole: 'CITATION_ATTRIBUTION',
            temperature: 0,
            timeoutMs,
            onDiagnostics: (diagnostics) => {
              const safeDiagnostics = { ...diagnostics };
              delete safeDiagnostics.requestId;
              semanticCalls.push(safeDiagnostics);
            },
          },
        );
    } catch {
      throw new CitationAttributionProviderError(semanticCalls);
    }

    const allowedIds = new Set(
      candidates.map((candidate) => candidate.evidenceId),
    );
    const rawClaims = Array.isArray(result.claims)
      ? (result.claims as RawClaimAssessment[])
      : [];
    const claims: CitationClaimAssessment[] = [];
    const evidenceConfidence = new Map<string, number>();

    for (const raw of rawClaims) {
      const claim = typeof raw?.claim === 'string' ? raw.claim.trim() : '';
      if (!claim) continue;

      const confidence = this.clampConfidence(raw.confidence);
      const rawEvidenceIds = Array.isArray(raw.evidenceIds)
        ? raw.evidenceIds
            .filter((value): value is string => typeof value === 'string')
            .map((value) => value.trim())
        : [];
      const hasUnknownEvidenceId = rawEvidenceIds.some(
        (value) => !allowedIds.has(value),
      );
      const evidenceIds = [...new Set(rawEvidenceIds)].slice(0, 3);
      const supported =
        raw.supported === true &&
        confidence >= minConfidence &&
        evidenceIds.length > 0 &&
        !hasUnknownEvidenceId;

      claims.push({
        claim,
        supported,
        evidenceIds: supported ? evidenceIds : [],
        confidence,
      });

      if (!supported) continue;
      for (const evidenceId of evidenceIds) {
        evidenceConfidence.set(
          evidenceId,
          Math.max(evidenceConfidence.get(evidenceId) ?? 0, confidence),
        );
      }
    }

    const selections: CitationAttributionSelection[] = [
      ...evidenceConfidence.entries(),
    ]
      .sort((left, right) => right[1] - left[1])
      .slice(0, input.maxCitations)
      .map(([evidenceId, confidence]) => ({ evidenceId, confidence }));
    const factualClaimCount = claims.length;
    const supportedClaimCount = claims.filter(
      (claim) => claim.supported,
    ).length;

    return {
      selections,
      claims,
      factualClaimCount,
      supportedClaimCount,
      coverage:
        factualClaimCount === 0 ? 1 : supportedClaimCount / factualClaimCount,
      diagnostics: {
        modelRole: 'CITATION_ATTRIBUTION',
        model,
        providerStatus: 'SUCCESS',
        ...(semanticCalls.length > 0 ? { semanticCalls } : {}),
      },
    };
  }

  private emptyResult(): CitationAttributionResult {
    return {
      selections: [],
      claims: [],
      factualClaimCount: 0,
      supportedClaimCount: 0,
      coverage: 1,
    };
  }

  private systemPrompt(): string {
    return [
      'You are a claim-level citation verifier for a video RAG system.',
      'Your task is NOT to answer the question and NOT to rewrite evidence.',
      'Extract only externally checkable factual claims made in the final answer.',
      'For each factual claim, decide whether the supplied evidence directly supports that exact claim.',
      'Return the smallest set of supplied evidence IDs that directly supports each supported claim.',
      'Do not mark a claim supported merely because evidence is topically related.',
      'TRANSCRIPT evidence supports only what is stated in the transcript.',
      'VISUAL evidence supports only what is visible in the sampled frame at its timestamp; never infer events between sampled frames.',
      'METADATA evidence supports only reel metadata.',
      'If the final answer is a refusal, generic conversational response, or contains no factual claims requiring reel evidence, return an empty claims array.',
      'Never invent an evidence ID. Return only IDs exactly as supplied.',
      'If a factual claim has no direct support, include the claim with supported=false and evidenceIds=[].',
      'Confidence is how certain you are about the support judgment, from 0 to 1.',
    ].join(' ');
  }

  private userPrompt(input: {
    question: string;
    answer: string;
    proposedClaims?: Array<{ claim: string; evidenceIds: string[] }>;
    candidates: CitationAttributionCandidate[];
    maxCitations: number;
  }): string {
    const bounds = readRagPromptBounds(this.config);
    const evidence = input.candidates
      .map((candidate) =>
        [
          `EVIDENCE_ID: ${candidate.evidenceId}`,
          `TYPE: ${candidate.evidenceType}`,
          `REEL_ID: ${candidate.reelId}`,
          candidate.title ? `TITLE: ${candidate.title}` : '',
          typeof candidate.startTime === 'number'
            ? `START_TIME: ${candidate.startTime}`
            : '',
          typeof candidate.endTime === 'number'
            ? `END_TIME: ${candidate.endTime}`
            : '',
          `EVIDENCE: ${candidate.evidenceText}`,
        ]
          .filter(Boolean)
          .join('\n'),
      )
      .join('\n\n---\n\n');

    return [
      `QUESTION:\n${boundPromptText(input.question, bounds.maxUserMessageChars)}`,
      `FINAL ANSWER:\n${boundPromptText(input.answer, bounds.maxAnswerChars)}`,
      `ANSWER MODEL PROPOSED CLAIM MAPPINGS (untrusted; verify independently):\n${JSON.stringify(boundClaimMappings(input.proposedClaims ?? [], bounds))}`,
      `MAX FINAL CITATIONS: ${input.maxCitations}`,
      `CANDIDATE EVIDENCE:\n${evidence}`,
    ].join('\n\n');
  }

  private clampConfidence(value: unknown): number {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? Math.min(1, Math.max(0, parsed)) : 0;
  }

  private number(
    key: string,
    fallback: number,
    min: number,
    max: number,
  ): number {
    const parsed = Number(this.configService.get<string>(key) ?? fallback);
    return Number.isFinite(parsed)
      ? Math.min(max, Math.max(min, parsed))
      : fallback;
  }
}
