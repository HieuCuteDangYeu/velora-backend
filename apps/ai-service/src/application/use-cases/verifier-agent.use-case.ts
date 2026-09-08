import type { IAiApplicationConfig } from '@ai/domain/interfaces/ai-application-config.interface';
import type {
  RagChatWorkflowState,
  RagVerificationResult,
  RagSupportedClaimMapping,
} from '@ai/domain/interfaces/rag-chat-workflow.interface';
import type {
  IStructuredLlmService,
  StructuredLlmJsonSchema,
} from '@ai/domain/interfaces/structured-llm.service.interface';
import { Inject, Injectable, Logger } from '@nestjs/common';
import {
  boundClaimMappings,
  boundEvidence,
  boundPromptText,
  readRagPromptBounds,
} from '@ai/domain/services/rag-prompt-bounds';
import { assessExactEvidenceProvenance } from './exact-evidence-provenance';

interface RawVerificationResult {
  passed?: unknown;
  confidence?: unknown;
  issues?: unknown;
  requiresRevision?: unknown;
  revisedInstruction?: unknown;
  contradictions?: unknown;
  supportedClaimMappings?: unknown;
}

@Injectable()
export class VerifierAgentUseCase {
  private readonly logger = new Logger(VerifierAgentUseCase.name);

  constructor(
    @Inject('IStructuredLlmService')
    private readonly structuredLlmService: IStructuredLlmService,
    @Inject('IAiApplicationConfig')
    private readonly config: IAiApplicationConfig,
  ) {}

  async execute(state: RagChatWorkflowState): Promise<RagVerificationResult> {
    if (!state.route?.needsVerification) {
      return {
        passed: true,
        confidence: 1,
        issues: [],
        requiresRevision: false,
        supportedClaimMappings: [],
        contradictions: [],
        diagnostics: {
          providerStatus: 'NOT_CALLED',
          decisionSource: 'NOT_REQUIRED',
          finalPassed: true,
          confidence: 1,
          issues: [],
          requiresRevision: false,
          escalated: false,
          exactProvenance: this.exactProvenance(state),
        },
      };
    }

    const maxAttempts = Math.round(
      this.config.number('AI_VERIFIER_MAX_ATTEMPTS', 2, 1, 2),
    );
    const escalationEnabled =
      maxAttempts >= 2 &&
      this.config.boolean('AI_VERIFIER_ESCALATION_ENABLED', true);

    let primary: RagVerificationResult;
    try {
      primary = await this.verifyWithRole(state, 'VERIFIER');
    } catch (primaryError: unknown) {
      if (escalationEnabled && this.isTransientProviderFailure(primaryError)) {
        try {
          const escalated = await this.verifyWithRole(
            state,
            'VERIFIER_ESCALATION',
          );
          return this.withDiagnostics(escalated, {
            role: 'VERIFIER_ESCALATION',
            source: 'LLM_ESCALATION',
            escalated: true,
            escalationReason: 'PRIMARY_PROVIDER_FAILURE',
            state,
          });
        } catch (escalationError: unknown) {
          return this.providerFailureResult(escalationError, state);
        }
      }
      return this.providerFailureResult(primaryError, state);
    }

    try {
      const escalationReason = this.escalationReason(primary, state);

      if (escalationReason && escalationEnabled) {
        const escalated = await this.verifyWithRole(
          state,
          'VERIFIER_ESCALATION',
        );
        return this.withDiagnostics(escalated, {
          role: 'VERIFIER_ESCALATION',
          source: 'LLM_ESCALATION',
          escalated: true,
          escalationReason,
          state,
        });
      }

      return this.withDiagnostics(primary, {
        role: 'VERIFIER',
        source: 'LLM_PRIMARY',
        escalated: false,
        state,
      });
    } catch (error: unknown) {
      return this.providerFailureResult(error, state);
    }
  }

  private isTransientProviderFailure(error: unknown): boolean {
    if (!error || typeof error !== 'object' || !('code' in error)) return false;
    if (
      error.code !== 'STRUCTURED_COMPLETION_TIMEOUT' &&
      error.code !== 'STRUCTURED_COMPLETION_PROVIDER_ERROR'
    ) {
      return false;
    }
    return !('transient' in error) || error.transient !== false;
  }

  private providerFailureResult(
    error: unknown,
    state: RagChatWorkflowState,
  ): RagVerificationResult {
    const message = error instanceof Error ? error.message : String(error);
    this.logger.warn(
      `[VerifierAgent] semantic verification failed: ${message}`,
    );

    const exactProvenance = this.exactProvenance(state);
    if (exactProvenance.supported) {
      return {
        passed: true,
        confidence: 1,
        issues: [
          'Semantic verifier unavailable; answer accepted only as an exact source span.',
        ],
        requiresRevision: false,
        supportedClaimMappings: [],
        contradictions: [],
        diagnostics: {
          providerStatus: 'ERROR',
          decisionSource: 'EXACT_PROVENANCE',
          finalPassed: true,
          confidence: 1,
          issues: [],
          requiresRevision: false,
          escalated: false,
          exactProvenance,
        },
      };
    }

    return {
      passed: false,
      confidence: 0,
      issues: ['Required semantic answer verification was unavailable.'],
      requiresRevision: false,
      supportedClaimMappings: [],
      contradictions: [],
      diagnostics: {
        providerStatus: 'ERROR',
        decisionSource: 'FAIL_CLOSED',
        finalPassed: false,
        confidence: 0,
        issues: ['Required semantic answer verification was unavailable.'],
        requiresRevision: false,
        escalated: false,
        exactProvenance,
      },
    };
  }

  private async verifyWithRole(
    state: RagChatWorkflowState,
    role: 'VERIFIER' | 'VERIFIER_ESCALATION',
  ): Promise<RagVerificationResult> {
    const raw =
      await this.structuredLlmService.generateObject<RawVerificationResult>({
        systemPrompt: this.buildSystemPrompt(),
        userPrompt: this.buildUserPrompt(state),
        jsonSchema: this.getJsonSchema(),
        maxTokens: this.config.maxCompletionTokens(role),
        modelRole: role,
        temperature: 0,
        model: this.config.model(role),
        timeoutMs: this.config.timeoutMs(role),
      });
    return this.normalize(raw, state);
  }

  private escalationReason(
    result: RagVerificationResult,
    state: RagChatWorkflowState,
  ): string | undefined {
    const threshold = this.config.number(
      'AI_VERIFIER_ESCALATION_CONFIDENCE_THRESHOLD',
      0.8,
      0,
      1,
    );
    if (!result.passed) return 'PRIMARY_REJECTED';
    if (result.confidence < threshold) return 'LOW_CONFIDENCE';
    if (state.retryCount > 0 || state.citationRetryCount > 0)
      return 'REVISED_ANSWER';
    return undefined;
  }

  private withDiagnostics(
    result: RagVerificationResult,
    input: {
      role: 'VERIFIER' | 'VERIFIER_ESCALATION';
      source: 'LLM_PRIMARY' | 'LLM_ESCALATION';
      escalated: boolean;
      escalationReason?: string;
      state: RagChatWorkflowState;
    },
  ): RagVerificationResult {
    return {
      ...result,
      diagnostics: {
        providerStatus: 'SUCCESS',
        decisionSource: input.source,
        modelRole: input.role,
        model: this.config.model(input.role),
        escalated: input.escalated,
        escalationReason: input.escalationReason,
        providerPassed: result.passed,
        finalPassed: result.passed,
        confidence: result.confidence,
        issues: result.issues,
        requiresRevision: result.requiresRevision,
        revisedInstruction: result.revisedInstruction,
        supportedClaimMappings: result.supportedClaimMappings ?? [],
        contradictions: result.contradictions ?? [],
        exactProvenance: this.exactProvenance(input.state),
      },
    };
  }

  private buildSystemPrompt(): string {
    return `
You are the semantic verifier for a production reel RAG answer.

Check every factual claim against the authorized evidence and requested relation/modality. Reject unsupported additions, contradictions, substitutions, and visual claims inferred between sampled frames.

Return only compact JSON matching the schema. Keep issues, contradictions, claims, and any revision instruction brief. Use only evidence IDs; do not repeat evidence text, rewrite the answer, invent IDs, or expose reasoning.
`.trim();
  }

  private buildUserPrompt(state: RagChatWorkflowState): string {
    const bounds = readRagPromptBounds(this.config);
    const boundedChunks = boundEvidence(state.rerankedChunks ?? [], bounds);
    const proposedClaims = boundClaimMappings(state.answerClaims ?? [], bounds);
    return JSON.stringify({
      question: boundPromptText(state.userMessage, bounds.maxUserMessageChars),
      requiredEvidence: state.route?.requiredEvidence ?? [],
      answer: boundPromptText(state.answer ?? '', bounds.maxAnswerChars),
      proposedClaims,
      evidence: boundedChunks.map((chunk, index) => ({
        evidenceId: `e${index}`,
        reelId: chunk.reelId,
        evidenceType: chunk.evidenceType ?? 'TRANSCRIPT',
        title: chunk.title,
        startTime: chunk.startTime,
        endTime: chunk.endTime,
        evidenceText:
          chunk.evidenceText?.trim() ||
          (chunk.evidenceType === 'METADATA'
            ? chunk.chunkText.trim()
            : undefined),
      })),
    });
  }

  private getJsonSchema(): StructuredLlmJsonSchema {
    return {
      type: 'object',
      additionalProperties: false,
      required: [
        'passed',
        'confidence',
        'issues',
        'requiresRevision',
        'revisedInstruction',
        'contradictions',
        'supportedClaimMappings',
      ],
      properties: {
        passed: { type: 'boolean' },
        confidence: { type: 'number', minimum: 0, maximum: 1 },
        issues: {
          type: 'array',
          maxItems: 8,
          items: { type: 'string', maxLength: 300 },
        },
        requiresRevision: { type: 'boolean' },
        revisedInstruction: { type: 'string', maxLength: 500 },
        contradictions: {
          type: 'array',
          maxItems: 8,
          items: { type: 'string', maxLength: 300 },
        },
        supportedClaimMappings: {
          type: 'array',
          maxItems: 12,
          items: {
            type: 'object',
            additionalProperties: false,
            required: ['claim', 'evidenceIds'],
            properties: {
              claim: { type: 'string', maxLength: 500 },
              evidenceIds: {
                type: 'array',
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
    raw: RawVerificationResult,
    state: RagChatWorkflowState,
  ): RagVerificationResult {
    const bounds = readRagPromptBounds(this.config);
    const allowedIds = new Set(
      boundEvidence(state.rerankedChunks ?? [], bounds).map(
        (_chunk, index) => `e${index}`,
      ),
    );
    const rawMappings = Array.isArray(raw.supportedClaimMappings)
      ? raw.supportedClaimMappings
      : [];
    let hasUnknownEvidenceId = false;
    const supportedClaimMappings: RagSupportedClaimMapping[] = [];
    for (const mapping of rawMappings) {
      if (!mapping || typeof mapping !== 'object') {
        hasUnknownEvidenceId = true;
        continue;
      }
      const candidate = mapping as Record<string, unknown>;
      const claim = candidate['claim'];
      const ids = candidate['evidenceIds'];
      if (typeof claim !== 'string' || !claim.trim() || !Array.isArray(ids)) {
        hasUnknownEvidenceId = true;
        continue;
      }
      const normalizedIds = [
        ...new Set(
          ids.filter(
            (id): id is string => typeof id === 'string' && allowedIds.has(id),
          ),
        ),
      ];
      if (normalizedIds.length !== ids.length) hasUnknownEvidenceId = true;
      supportedClaimMappings.push({
        claim: claim.trim(),
        evidenceIds: normalizedIds,
      });
    }
    const issues = Array.isArray(raw.issues)
      ? raw.issues.filter((item): item is string => typeof item === 'string')
      : [];
    const contradictions = Array.isArray(raw.contradictions)
      ? raw.contradictions.filter(
          (item): item is string =>
            typeof item === 'string' && item.trim().length > 0,
        )
      : [];
    issues.push(...contradictions);
    if (hasUnknownEvidenceId)
      issues.push('Verifier returned unknown evidence ID.');
    const confidence =
      typeof raw.confidence === 'number' && Number.isFinite(raw.confidence)
        ? Math.min(Math.max(raw.confidence, 0), 1)
        : 0;
    const passed =
      raw.passed === true &&
      !hasUnknownEvidenceId &&
      contradictions.length === 0;

    return {
      passed,
      confidence,
      issues,
      requiresRevision:
        typeof raw.requiresRevision === 'boolean'
          ? raw.requiresRevision
          : !passed,
      revisedInstruction:
        typeof raw.revisedInstruction === 'string' &&
        raw.revisedInstruction.trim()
          ? raw.revisedInstruction.trim()
          : undefined,
      supportedClaimMappings,
      contradictions,
    };
  }

  private exactProvenance(state: RagChatWorkflowState) {
    return assessExactEvidenceProvenance({
      answer: state.answer ?? '',
      candidates: (state.rerankedChunks ?? []).map((chunk) => ({
        evidenceType: chunk.evidenceType ?? 'TRANSCRIPT',
        evidenceText: chunk.evidenceText?.trim() || '',
      })),
    });
  }
}
