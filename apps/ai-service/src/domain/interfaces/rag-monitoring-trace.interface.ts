import type {
  RagCitation,
  RagGenerationEvidence,
  RagCitationDiagnostics,
  RagCitationEvidenceMapping,
  RagAnswerFallbackReason,
  RagContextToolExecutionDiagnostics,
  RagFinalizationMode,
  RagPersistedRouteDecision,
  RagRetrievalExecutionDiagnostics,
  RagRetrievalPlanActual,
  RagWorkflowFailureDiagnostics,
} from '@ai/domain/interfaces/rag-chat-workflow.interface';

export interface RagWorkflowTraceMetrics {
  retrievalRetryCount: number;
  answerRetryCount: number;
  citationRetryCount: number;
  /** Canonical index IDs selected for the final public citations. */
  citationEvidenceIds?: string[];
  /** Prompt-local IDs used by the citation attribution call. */
  citationSelectedEvidenceIds?: string[];
  deterministicSupportingEvidenceIds?: string[];
  citationEvidenceMappings?: RagCitationEvidenceMapping[];
  citationCoverageMode?: 'LLM' | 'DETERMINISTIC' | 'FALLBACK' | 'NOT_REQUIRED';
  citationCoverage?: number;
  factualClaimCount?: number;
  supportedClaimCount?: number;
  diagnostics?: {
    routeDecision?: RagPersistedRouteDecision;
    retrievalPlanActual?: RagRetrievalPlanActual;
    retrievalExecution?: RagRetrievalExecutionDiagnostics;
    contextToolExecution?: RagContextToolExecutionDiagnostics;
    contextSufficiency?: unknown;
    route?: unknown;
    retrievalPlan?: unknown;
    retrievalCounts?: { retrieved: number; reranked: number };
    draftHistory?: unknown[];
    groundedRevision?: unknown;
    answerClaims?: unknown[];
    answerCalls?: unknown[];
    verification?: unknown;
    citationDiagnostics?: RagCitationDiagnostics;
    citationAttempts?: unknown[];
    finalization?: {
      answerGenerationStatus:
        | 'ANSWER_GENERATION_SUCCESS'
        | 'EXTRACTIVE_FALLBACK_USED'
        | 'NOT_EXECUTED';
      groundingVerification: 'GROUNDING_VERIFIED' | 'FAILED' | 'NOT_EXECUTED';
      synthesizedAnswerPreserved: boolean;
      extractiveFallbackUsed: boolean;
      finalizationMode: RagFinalizationMode;
      fallbackReason?: RagAnswerFallbackReason;
      draftAnswerExecuted: boolean;
      draftAnswerProviderStatus?: number | string;
      verifierExecuted: boolean;
      verifierProviderStatus?: number | string;
      verifierDecision: 'PASS' | 'FAIL' | 'NOT_EXECUTED';
      verifierEscalationExecuted: boolean;
      verifierEscalationProviderStatus?: number | string;
      answerRevisionExecuted: boolean;
      answerRevisionProviderStatus?: number | string;
      citationExecuted: boolean;
      citationProviderStatus?: number | string;
      citationCoverageResult?: number;
      citationRevisionExecuted: boolean;
      finalSource: string;
      finalFailureSource: string;
    };
    finalFailureSource?: string;
    failure?: RagWorkflowFailureDiagnostics;
    productionExecutionId?: string;
    langfuseTraceId?: string;
    generationEvidenceIds?: string[];
    generationEvidence?: RagGenerationEvidence[];
    evaluationCapture?: { release?: string; contextCaptured: boolean };
  };
}

export interface RagMonitoringSnapshot {
  userId: string;
  conversationId: string;
  message: string;
  intent?: string;
  needsRetrieval: boolean;
  retrievedChunkIds: string[];
  rerankedChunkIds: string[];
  citations: RagCitation[];
  answer?: string;
  verifierPassed?: boolean;
  verifierConfidence?: number;
  verifierIssues?: string[];
  latencyMs: number;
  nodeTimings: Record<string, number>;
  workflowMetrics: RagWorkflowTraceMetrics;
}
