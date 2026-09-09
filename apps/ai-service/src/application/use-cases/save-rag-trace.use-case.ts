import type {
  RagChatWorkflowState,
  RagRetrievalPlan,
} from '@ai/domain/interfaces/rag-chat-workflow.interface';
import type { IRagTraceRepository } from '@ai/domain/interfaces/rag-trace.repository.interface';
import { Inject, Injectable, Logger } from '@nestjs/common';

@Injectable()
export class SaveRagTraceUseCase {
  private readonly logger = new Logger(SaveRagTraceUseCase.name);

  constructor(
    @Inject('IRagTraceRepository')
    private readonly ragTraceRepository: IRagTraceRepository,
  ) {}

  async execute(input: {
    state: RagChatWorkflowState;
    latencyMs: number;
    nodeTimings: Record<string, number>;
  }): Promise<void> {
    try {
      await this.ragTraceRepository.create({
        userId: input.state.userId,
        conversationId: input.state.conversationId,
        message: input.state.userMessage,

        intent: input.state.route?.intent,
        needsRetrieval: input.state.route?.needsRetrieval ?? false,

        retrievedChunkIds: input.state.retrievedChunks.map(
          (chunk) => chunk.chunkId,
        ),
        rerankedChunkIds: input.state.rerankedChunks.map(
          (chunk) => chunk.chunkId,
        ),
        citations: input.state.citations ?? [],

        answer: input.state.answer,
        verifierPassed: input.state.verification?.passed,
        verifierConfidence: input.state.verification?.confidence,
        verifierIssues: input.state.verification?.issues,

        latencyMs: input.latencyMs,
        nodeTimings: input.nodeTimings,
        workflowMetrics: {
          retrievalRetryCount: input.state.retrievalRetryCount,
          answerRetryCount: input.state.retryCount,
          citationRetryCount: input.state.citationRetryCount,
          citationEvidenceIds:
            input.state.citationCoverage?.diagnostics?.selectedEvidenceMappings?.map(
              (mapping) => mapping.evidenceId,
            ) ?? [],
          citationSelectedEvidenceIds:
            input.state.citationCoverage?.diagnostics?.selectedEvidenceIds ??
            [],
          deterministicSupportingEvidenceIds:
            input.state.citationCoverage?.diagnostics
              ?.deterministicSupportingEvidenceIds ?? [],
          citationEvidenceMappings:
            input.state.citationCoverage?.diagnostics
              ?.selectedEvidenceMappings ?? [],
          citationCoverageMode: input.state.citationCoverage?.mode,
          citationCoverage: input.state.citationCoverage?.coverage,
          factualClaimCount: input.state.citationCoverage?.factualClaimCount,
          supportedClaimCount:
            input.state.citationCoverage?.supportedClaimCount,
          diagnostics: {
            routeDecision: input.state.route
              ? {
                  intent: input.state.route.intent,
                  referenceTarget: input.state.route.referenceTarget,
                  reelQuestionType: input.state.route.reelQuestionType,
                  requiredEvidence: input.state.route.requiredEvidence,
                  needsRetrieval: input.state.route.needsRetrieval,
                  needsVerification: input.state.route.needsVerification,
                  recommendationActionType:
                    input.state.route.recommendationAction?.type,
                }
              : undefined,
            retrievalPlanActual: input.state.retrievalPlan
              ? this.toPersistedRetrievalPlan(input.state.retrievalPlan)
              : undefined,
            retrievalExecution: input.state.retrievalExecution,
            route: input.state.route?.diagnostics,
            retrievalPlan: input.state.retrievalPlan?.diagnostics,
            retrievalCounts: {
              retrieved: input.state.retrievedChunks.length,
              reranked: input.state.rerankedChunks.length,
            },
            contextSufficiency: input.state.contextSufficiency
              ? {
                  providerStatus:
                    input.state.contextSufficiency.diagnostics
                      ?.providerStatus ?? 'UNKNOWN',
                  decisionSource:
                    input.state.contextSufficiency.diagnostics
                      ?.decisionSource ?? 'UNKNOWN',
                  sufficient: input.state.contextSufficiency.sufficient,
                  confidence: input.state.contextSufficiency.confidence,
                  recommendedAction:
                    input.state.contextSufficiency.recommendedAction,
                  reason: input.state.contextSufficiency.reason,
                  userFacingReason:
                    input.state.contextSufficiency.userFacingReason,
                  availableEvidence:
                    input.state.contextSufficiency.availableEvidence,
                  missingEvidence:
                    input.state.contextSufficiency.missingEvidence,
                  supportedEvidenceIds:
                    input.state.contextSufficiency.supportedEvidenceIds ?? [],
                }
              : undefined,
            draftHistory: input.state.draftHistory,
            groundedRevision: input.state.groundedRevision,
            answerClaims: input.state.answerClaims?.slice(0, 12),
            answerCalls: input.state.answerDiagnostics,
            verification: input.state.verification?.diagnostics
              ? {
                  ...input.state.verification.diagnostics,
                  supportedClaimMappings:
                    input.state.verification.supportedClaimMappings ?? [],
                  contradictions: input.state.verification.contradictions ?? [],
                }
              : undefined,
            citationDiagnostics:
              input.state.citationDiagnostics ??
              input.state.citationCoverage?.diagnostics,
            citationAttempts: input.state.citationAttempts,
            finalization: this.finalizationDiagnostics(input.state),
            finalFailureSource: input.state.finalFailureSource,
            failure: input.state.failureDiagnostics,
          },
        },
      });
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.warn(`[RagTrace] save failed: ${message}`);
    }
  }

  private finalizationDiagnostics(state: RagChatWorkflowState) {
    const answerCalls = Array.isArray(state.answerDiagnostics)
      ? state.answerDiagnostics
      : [];
    const verificationDiagnostics = this.asRecord(
      state.verification?.diagnostics,
    );
    const verificationCalls = this.semanticCalls(verificationDiagnostics);
    const answerRevisionCalls = this.semanticCalls(
      state.groundedRevision?.diagnostics,
    );
    const citationAttempts = state.citationAttempts ?? [];
    const citationCall = citationAttempts.at(-1);
    const citationCalls = this.semanticCalls(citationCall);
    const verifierExecuted = state.verification !== undefined;
    const answerRevisionExecuted = Boolean(
      state.groundedRevision ||
      state.draftHistory.some(
        ({ source }) =>
          source === 'VERIFIER_REVISION' || source === 'CITATION_REVISION',
      ),
    );
    const verifierDecision: 'PASS' | 'FAIL' | 'NOT_EXECUTED' = !verifierExecuted
      ? 'NOT_EXECUTED'
      : state.verification?.passed
        ? 'PASS'
        : 'FAIL';

    return {
      draftAnswerExecuted: state.draftHistory.length > 0,
      draftAnswerProviderStatus: this.lastProviderStatus(answerCalls),
      verifierExecuted,
      verifierProviderStatus: this.lastProviderStatus(verificationCalls),
      verifierDecision,
      verifierEscalationExecuted: verificationCalls.some(
        (call) => call.modelRole === 'VERIFIER_ESCALATION',
      ),
      verifierEscalationProviderStatus: this.lastProviderStatus(
        verificationCalls.filter(
          (call) => call.modelRole === 'VERIFIER_ESCALATION',
        ),
      ),
      answerRevisionExecuted,
      answerRevisionProviderStatus:
        this.lastProviderStatus(answerRevisionCalls),
      citationExecuted: citationAttempts.length > 0,
      citationProviderStatus: this.lastProviderStatus(citationCalls),
      citationCoverageResult:
        typeof state.citationCoverage?.coverage === 'number'
          ? state.citationCoverage.coverage
          : undefined,
      citationRevisionExecuted:
        citationAttempts.length > 1 ||
        state.draftHistory.some(({ source }) => source === 'CITATION_REVISION'),
      finalSource:
        state.finalFailureSource === 'NONE'
          ? state.groundedRevision
            ? 'ANSWER_REVISION'
            : 'ANSWER'
          : 'FAILURE_FALLBACK',
      finalFailureSource: state.finalFailureSource,
    };
  }

  private semanticCalls(value: unknown): Array<Record<string, unknown>> {
    if (Array.isArray(value)) {
      return value.filter((call): call is Record<string, unknown> =>
        Boolean(call && typeof call === 'object'),
      );
    }
    const record = this.asRecord(value);
    return Array.isArray(record?.semanticCalls)
      ? record.semanticCalls.filter((call): call is Record<string, unknown> =>
          Boolean(call && typeof call === 'object'),
        )
      : [];
  }

  private lastProviderStatus(
    calls: Array<{ providerStatus?: unknown }>,
  ): number | string | undefined {
    const status = calls.at(-1)?.providerStatus;
    return typeof status === 'number' || typeof status === 'string'
      ? status
      : undefined;
  }

  private asRecord(value: unknown): Record<string, unknown> | undefined {
    return value && typeof value === 'object' && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : undefined;
  }

  private toPersistedRetrievalPlan(plan: RagRetrievalPlan) {
    return {
      mode: plan.mode,
      query: plan.query.slice(0, 500),
      rewrittenQuery: plan.rewrittenQuery?.slice(0, 500),
      queries: plan.queries?.slice(0, 3).map((query) => query.slice(0, 500)),
      searchLimit: plan.searchLimit,
      rerankLimit: plan.rerankLimit,
      shouldRerank: plan.shouldRerank,
      reason: plan.reason.slice(0, 240),
    };
  }
}
