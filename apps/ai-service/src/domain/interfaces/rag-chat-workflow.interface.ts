import type {
  AiRagCitation,
  AiRecommendedReel,
} from '@common/ai/dtos/ask-question-response.dto';
import type { AiChatMemoryContext } from '@common/ai/interfaces/chat-memory-context.interface';
import type { ConversationMemoryContext } from '@common/ai/interfaces/conversation-memory.interface';
import type { RelevantUserMemoriesContext } from '@common/ai/interfaces/user-memory.interface';
import type {
  StructuredLlmCallDiagnostics,
  StructuredProviderFailureCategory,
} from './structured-llm.service.interface';
import type { ReelContextSearchResult } from '@common/content/interfaces/reel-context-search-result.interface';

export type RagChatIntent =
  | 'NORMAL_CHAT'
  | 'REEL_VIDEO_QUESTION'
  | 'CONVERSATION_MEMORY_QUESTION'
  | 'USER_MEMORY_QUESTION'
  | 'TASK_ACTION_REQUEST';

export type RagReelQuestionType =
  | 'NONE'
  | 'TRANSCRIPT_CONTENT'
  | 'VISUAL_CONTENT'
  | 'GENERAL_REEL_SUMMARY'
  | 'REEL_METADATA'
  | 'AMBIGUOUS_REEL_REFERENCE';

export type RagRequiredEvidence =
  | 'NONE'
  | 'TRANSCRIPT'
  | 'VISUAL'
  | 'AUDIO'
  | 'METADATA'
  | 'CONVERSATION_MEMORY'
  | 'USER_MEMORY';

export type RagReferenceTarget =
  | 'NONE'
  | 'SHARED_REEL'
  | 'CONVERSATION'
  | 'USER_MEMORY';

export type RagRouterSemanticInconsistencyType =
  | 'INVALID_INTENT'
  | 'INVALID_REFERENCE_TARGET'
  | 'INTENT_REFERENCE_MISMATCH'
  | 'SHARED_REEL_CONTEXT_UNAVAILABLE'
  | 'INTENT_REEL_TYPE_MISMATCH'
  | 'REQUIRED_EVIDENCE_MISMATCH'
  | 'INVALID_RECOMMENDATION_ACTION'
  | 'RECOMMENDATION_INTENT_MISMATCH'
  | 'RECOMMENDATION_PAYLOAD_MISMATCH';

export interface RagRouterSemanticInconsistencyDetails {
  actualIntent?: RagChatIntent;
  actualReferenceTarget?: RagReferenceTarget;
  expectedReferenceTarget?: RagReferenceTarget;
  actualReelQuestionType?: RagReelQuestionType;
  expectedReelQuestionType?: RagReelQuestionType;
  actualEvidence?: RagRequiredEvidence[];
  expectedEvidence?: RagRequiredEvidence[];
  recommendationActionType?: RagRecommendationAction['type'];
}

export interface RagRouterReferentContext {
  conversationHasSharedReelContext: boolean;
  accessibleSharedReelCount: number;
  recentShareEvent: boolean;
  turnsSinceRecentShare?: number;
  recentEventTypes: Array<'TEXT' | 'REEL_SHARE'>;
}

export type RagRecommendationAction =
  | {
      type: 'NONE';
      reason: string;
    }
  | {
      type: 'RECOMMEND_REELS';
      query?: string;
      minRelevantItems: number;
      allowPersonalizedFallback: boolean;
      reason: string;
    }
  | {
      type: 'SUGGEST_QUERIES';
      query?: string;
      suggestedQueries: string[];
      reason: string;
    };

export interface RagChatRouteDecision {
  intent: RagChatIntent;
  referenceTarget: RagReferenceTarget;
  needsRetrieval: boolean;
  needsUserMemory: boolean;
  needsConversationSummary: boolean;
  needsVerification: boolean;

  reelQuestionType: RagReelQuestionType;
  requiredEvidence: RagRequiredEvidence[];

  recommendationAction: RagRecommendationAction;

  reason: string;
  diagnostics?: {
    modelRole: 'ROUTER';
    model?: string;
    providerStatus: 'SUCCESS' | 'ERROR' | 'NOT_CALLED';
    decisionSource: 'LLM' | 'LLM_FALLBACK' | 'FAIL_SAFE' | 'STRUCTURAL';
    semanticCalls?: StructuredLlmCallDiagnostics[];
    fallbackReason?: string;
  };
}

export type RagRetrievalMode = 'NONE' | 'REEL_VECTOR' | 'REEL_HYBRID';

export interface RagRetrievalPlan {
  mode: RagRetrievalMode;
  query: string;
  rewrittenQuery?: string;
  queries?: string[];
  searchLimit: number;
  rerankLimit: number;
  shouldRerank: boolean;
  reason: string;
  diagnostics?: {
    modelRole: 'RETRIEVAL_PLANNER';
    model?: string;
    providerStatus: 'SUCCESS' | 'ERROR' | 'NOT_CALLED';
    decisionSource: 'LLM' | 'FAIL_CLOSED' | 'NOT_REQUIRED';
    semanticCalls?: RagStructuredCallFailureDiagnostic[];
  };
}

export type RagRetrievalPlanActual = Pick<
  RagRetrievalPlan,
  | 'mode'
  | 'query'
  | 'rewrittenQuery'
  | 'queries'
  | 'searchLimit'
  | 'rerankLimit'
  | 'shouldRerank'
  | 'reason'
>;

export type RagRetrievalFailureStage =
  | 'ACCESS_RESOLUTION'
  | 'EMBEDDING'
  | 'SEMANTIC_SEARCH'
  | 'HYDRATION'
  | 'RERANK';

export interface RagRetrievalQueryDiagnostics {
  queryOrdinal: number;
  mode: Exclude<RagRetrievalMode, 'NONE'>;
  includeTranscript: boolean;
  includeVisual: boolean;
  semanticCandidateCount: number;
  hydratedCandidateCount: number;
  returnedChunkCount: number;
}

export interface RagRetrievalExecutionDiagnostics {
  accessibleReelCount: number;
  accessibleReelIds: string[];
  accessibleReelIdsTruncated?: boolean;
  queryCount: number;
  queries: RagRetrievalQueryDiagnostics[];
  retrievedCount: number;
  rerankedCount: number;
  failedStage?: RagRetrievalFailureStage;
  errorName?: string;
  errorCode?: string;
  providerCategory?: StructuredProviderFailureCategory;
}

export interface RagMemorySelection {
  includeRecentHistory: boolean;
  includeConversationSummary: boolean;
  includeUserMemory: boolean;
  includeRetrievedChunks: boolean;
  reason: string;
}

export interface RagVerificationResult {
  passed: boolean;
  confidence: number;
  issues: string[];
  requiresRevision: boolean;
  revisedInstruction?: string;
  supportedClaimMappings?: RagSupportedClaimMapping[];
  contradictions?: string[];
  diagnostics?: RagVerificationDiagnostics;
}

export interface RagSupportedClaimMapping {
  claim: string;
  evidenceIds: string[];
}

export interface RagVerificationDiagnostics {
  providerStatus: 'NOT_CALLED' | 'SUCCESS' | 'ERROR';
  decisionSource:
    | 'NOT_REQUIRED'
    | 'LLM_PRIMARY'
    | 'LLM_ESCALATION'
    | 'EXACT_PROVENANCE'
    | 'FAIL_CLOSED';
  modelRole?: 'VERIFIER' | 'VERIFIER_ESCALATION';
  model?: string;
  escalated?: boolean;
  escalationReason?: string;
  providerPassed?: boolean;
  finalPassed: boolean;
  confidence: number;
  issues: string[];
  requiresRevision: boolean;
  revisedInstruction?: string;
  supportedClaimMappings?: RagSupportedClaimMapping[];
  contradictions?: string[];
  semanticCalls?: RagStructuredCallFailureDiagnostic[];
  exactProvenance: {
    supported: boolean;
    supportingEvidenceIndexes: number[];
  };
}

export interface RagContextSufficiencyResult {
  sufficient: boolean;
  confidence: number;

  availableEvidence: RagRequiredEvidence[];
  missingEvidence: RagRequiredEvidence[];
  /** Prompt-local evidence IDs that directly support answering the exact question. */
  supportedEvidenceIds?: string[];

  reason: string;
  userFacingReason?: string;

  recommendedAction: 'ANSWER' | 'REFUSE_NO_CONTEXT' | 'REWRITE_AND_RETRY';
  diagnostics?: RagContextSufficiencyDiagnostics;
}

export interface RagContextSufficiencyDiagnostics {
  providerStatus: 'NOT_CALLED' | 'SUCCESS' | 'ERROR';
  decisionSource:
    | 'DETERMINISTIC_NO_CONTEXT'
    | 'DETERMINISTIC_REQUIRED_MODALITY'
    | 'LLM'
    | 'FAIL_CLOSED'
    | 'UNKNOWN';
  modelRole?: 'CONTEXT_SUFFICIENCY';
  model?: string;
}

export interface RagCitationCoverageResult {
  mode: 'LLM' | 'DETERMINISTIC' | 'FALLBACK' | 'NOT_REQUIRED';
  coverage: number;
  factualClaimCount: number;
  supportedClaimCount: number;
  unsupportedClaims: string[];
  diagnostics?: RagCitationDiagnostics;
}

export interface RagCitationDiagnostics {
  decisionSource: 'NOT_REQUIRED' | 'LLM' | 'DETERMINISTIC' | 'FALLBACK';
  selectedEvidenceIds: string[];
  deterministicSupportingEvidenceIds: string[];
  /** Explicit mapping from prompt-local attribution IDs to canonical index IDs. */
  selectedEvidenceMappings?: RagCitationEvidenceMapping[];
  modelRole?: 'CITATION_ATTRIBUTION';
  model?: string;
  providerStatus?: 'SUCCESS' | 'ERROR' | 'NOT_CALLED';
  semanticCalls?: RagStructuredCallFailureDiagnostic[];
  errorCode?: string;
  providerCategory?: StructuredProviderFailureCategory;
}

export interface RagCitationEvidenceMapping {
  citationIndex: number;
  selectedEvidenceId: string;
  evidenceId: string;
}

export interface RagCitationAttemptDiagnostics {
  attempt: number;
  decisionSource: RagCitationDiagnostics['decisionSource'];
  coverage: number;
  selectedEvidenceIds: string[];
  selectedEvidenceMappings: RagCitationEvidenceMapping[];
  deterministicSupportingEvidenceIds: string[];
  providerStatus?: RagCitationDiagnostics['providerStatus'];
  model?: string;
  semanticCalls?: RagStructuredCallFailureDiagnostic[];
  errorCode?: string;
  providerCategory?: StructuredProviderFailureCategory;
}

export interface RagPersistedRouteDecision {
  intent: RagChatIntent;
  referenceTarget: RagReferenceTarget;
  reelQuestionType: RagReelQuestionType;
  requiredEvidence: RagRequiredEvidence[];
  needsRetrieval: boolean;
  needsVerification: boolean;
  recommendationActionType?: RagRecommendationAction['type'];
}

export interface RagDraftHistoryEntry {
  revision: number;
  source:
    | 'INITIAL'
    | 'VERIFIER_REVISION'
    | 'GROUNDED_VERIFIER_REVISION'
    | 'CITATION_REVISION';
  answer: string;
}

export interface RagAnswerClaim {
  claim: string;
  evidenceIds: string[];
}

export type RagCitation = AiRagCitation;

export interface RagChatWorkflowInput {
  message: string;
  userId: string;
  conversationId: string;
  memory?: AiChatMemoryContext;
}

export interface RagChatWorkflowResult {
  answer: string;
  citations?: RagCitation[];
  recommendedReels?: AiRecommendedReel[];
  suggestedQueries?: string[];
}

export type RagStructuredCallFailureDiagnostic = Omit<
  StructuredLlmCallDiagnostics,
  'requestId'
>;

export interface RagWorkflowFailureDiagnostics {
  failedNode: string;
  errorName: string;
  errorCode?: string;
  causeCode?: string;
  semanticInconsistencyType?: RagRouterSemanticInconsistencyType;
  semanticInconsistencyDetails?: RagRouterSemanticInconsistencyDetails;
  semanticCalls?: RagStructuredCallFailureDiagnostic[];
}

export interface RagChatWorkflowState {
  userId: string;
  conversationId: string;
  userMessage: string;
  memory?: AiChatMemoryContext;

  accessibleReelIds?: string[];
  hasSharedReelContext?: boolean;

  route?: RagChatRouteDecision;
  retrievalPlan?: RagRetrievalPlan;
  retrievalRepairQuery?: string;

  retrievedChunks: ReelContextSearchResult[];
  rerankedChunks: ReelContextSearchResult[];
  retrievalReady?: boolean;

  recommendedReels?: AiRecommendedReel[];
  suggestedQueries?: string[];

  contextSufficiency?: RagContextSufficiencyResult;

  conversationMemory?: ConversationMemoryContext;
  userMemories?: RelevantUserMemoriesContext;
  memorySelection?: RagMemorySelection;
  memoryReady?: boolean;

  answer?: string;
  answerClaims?: RagAnswerClaim[];
  answerDiagnostics?: StructuredLlmCallDiagnostics[];
  verification?: RagVerificationResult;
  citations?: RagCitation[];
  citationCoverage?: RagCitationCoverageResult;
  citationDiagnostics?: RagCitationDiagnostics;
  groundedRevision?: {
    evidenceIds: string[];
    modelRole: 'ANSWER_REVISION';
    diagnostics?: StructuredLlmCallDiagnostics[];
  };
  draftHistory: RagDraftHistoryEntry[];
  draftRevision: number;
  citationAttempts: RagCitationAttemptDiagnostics[];
  nextDraftSource: RagDraftHistoryEntry['source'];
  finalFailureSource:
    | 'NONE'
    | 'NO_CONTEXT'
    | 'VERIFIER'
    | 'CITATION'
    | 'PROVIDER_ERROR'
    | 'WORKFLOW'
    | 'UNKNOWN';
  failureDiagnostics?: RagWorkflowFailureDiagnostics;

  retryCount: number;
  retrievalRetryCount: number;
  citationRetryCount: number;
  retrievalExecution?: RagRetrievalExecutionDiagnostics;
}

export interface IRagChatWorkflow {
  execute(input: RagChatWorkflowInput): Promise<RagChatWorkflowResult>;
}
