import type { RagChatWorkflowState } from '@ai/domain/interfaces/rag-chat-workflow.interface';
import { SaveRagTraceUseCase } from './save-rag-trace.use-case';

describe('SaveRagTraceUseCase', () => {
  it('persists bounded graph diagnostics under existing workflow metrics', async () => {
    const create = jest.fn().mockResolvedValue(undefined);
    const useCase = new SaveRagTraceUseCase({ create });
    const state = {
      userId: 'u',
      conversationId: 'c',
      userMessage: 'question',
      retrievedChunks: [],
      rerankedChunks: [],
      citations: [],
      retryCount: 1,
      retrievalRetryCount: 2,
      citationRetryCount: 1,
      draftHistory: [{ revision: 0, source: 'INITIAL', answer: 'answer' }],
      citationAttempts: [
        {
          attempt: 0,
          decisionSource: 'LLM',
          coverage: 1,
          selectedEvidenceIds: ['e0'],
          selectedEvidenceMappings: [
            {
              citationIndex: 0,
              selectedEvidenceId: 'e0',
              evidenceId: 'reel:r1:chunk:0',
            },
          ],
          deterministicSupportingEvidenceIds: [],
          providerStatus: 200,
          model: 'test/test/citation',
          semanticCalls: [
            {
              modelRole: 'CITATION_ATTRIBUTION',
              model: 'test/test/citation',
              providerStatus: 200,
              latencyMs: 10,
              configuredTimeoutMs: 12_000,
              configuredMaxCompletionTokens: 768,
              attempt: 1,
            },
          ],
        },
      ],
      nextDraftSource: 'INITIAL',
      finalFailureSource: 'NO_CONTEXT',
      answerDiagnostics: [
        {
          modelRole: 'ANSWER',
          model: 'test/openai/gpt-oss-120b',
          providerStatus: 200,
          latencyMs: 12,
          configuredTimeoutMs: 45_000,
          configuredMaxCompletionTokens: 1_536,
          attempt: 1,
        },
      ],
      failureDiagnostics: {
        failedNode: 'queryRouterNode',
        errorName: 'RouterUnavailableError',
        errorCode: 'ROUTER_UNAVAILABLE',
        causeCode: 'ROUTER_SEMANTIC_INCONSISTENT',
        semanticCalls: [
          {
            model: 'test/test/router',
            providerStatus: 200,
            latencyMs: 10,
            configuredTimeoutMs: 30_000,
            configuredMaxCompletionTokens: 512,
            attempt: 1,
          },
        ],
      },
      route: {
        intent: 'REEL_VIDEO_QUESTION',
        referenceTarget: 'SHARED_REEL',
        needsRetrieval: true,
        needsUserMemory: false,
        needsConversationSummary: false,
        needsVerification: true,
        reelQuestionType: 'TRANSCRIPT_CONTENT',
        requiredEvidence: ['TRANSCRIPT'],
        recommendationAction: {
          type: 'NONE',
          reason: 'No recommendation needed.',
        },
        reason: 'The question asks about shared reel transcript content.',
        diagnostics: {
          modelRole: 'ROUTER',
          model: 'test/test/router',
          providerStatus: 'SUCCESS',
          decisionSource: 'LLM',
        },
      },
      retrievalPlan: {
        mode: 'REEL_HYBRID',
        query: 'spoken project',
        rewrittenQuery: 'spoken project',
        queries: ['spoken project', 'project name'],
        searchLimit: 8,
        rerankLimit: 5,
        shouldRerank: true,
        reason: 'Focused transcript search.',
        diagnostics: {
          modelRole: 'RETRIEVAL_PLANNER',
          model: 'test/test/planner',
          providerStatus: 'SUCCESS',
          decisionSource: 'LLM',
          semanticCalls: [
            {
              modelRole: 'RETRIEVAL_PLANNER',
              model: 'test/test/planner',
              providerStatus: 200,
              latencyMs: 10,
              configuredTimeoutMs: 8_000,
              configuredMaxCompletionTokens: 512,
              attempt: 1,
            },
          ],
        },
      },
      retrievalExecution: {
        accessibleReelCount: 1,
        accessibleReelIds: ['reel:r1'],
        queryCount: 2,
        queries: [
          {
            queryOrdinal: 1,
            mode: 'REEL_HYBRID',
            includeTranscript: true,
            includeVisual: false,
            semanticCandidateCount: 2,
            hydratedCandidateCount: 2,
            returnedChunkCount: 2,
          },
          {
            queryOrdinal: 2,
            mode: 'REEL_HYBRID',
            includeTranscript: true,
            includeVisual: false,
            semanticCandidateCount: 1,
            hydratedCandidateCount: 1,
            returnedChunkCount: 1,
          },
        ],
        retrievedCount: 2,
        rerankedCount: 1,
      },
      answerClaims: [{ claim: 'answer', evidenceIds: ['e0'] }],
      contextSufficiency: {
        sufficient: true,
        confidence: 1,
        availableEvidence: ['TRANSCRIPT'],
        missingEvidence: [],
        reason: 'supported',
        recommendedAction: 'ANSWER',
        supportedEvidenceIds: ['e0'],
        diagnostics: {
          providerStatus: 'NOT_CALLED',
          decisionSource: 'LLM',
          modelRole: 'CONTEXT_SUFFICIENCY',
          model: 'test/test/sufficiency',
        },
      },
      citationCoverage: {
        mode: 'LLM',
        coverage: 1,
        factualClaimCount: 1,
        supportedClaimCount: 1,
        unsupportedClaims: [],
        diagnostics: {
          decisionSource: 'LLM',
          selectedEvidenceIds: ['e0'],
          deterministicSupportingEvidenceIds: [],
          selectedEvidenceMappings: [
            {
              citationIndex: 0,
              selectedEvidenceId: 'e0',
              evidenceId: 'reel:r1:chunk:0',
            },
          ],
          semanticCalls: [
            {
              modelRole: 'CITATION_ATTRIBUTION',
              model: 'test/test/citation',
              providerStatus: 200,
              latencyMs: 10,
              configuredTimeoutMs: 12_000,
              configuredMaxCompletionTokens: 768,
              attempt: 1,
            },
          ],
        },
      },
      verification: {
        passed: true,
        confidence: 1,
        issues: [],
        requiresRevision: false,
        supportedClaimMappings: [{ claim: 'answer', evidenceIds: ['e0'] }],
        contradictions: [],
        diagnostics: {
          providerStatus: 'ERROR',
          decisionSource: 'EXACT_PROVENANCE',
          finalPassed: true,
          confidence: 1,
          issues: [],
          requiresRevision: false,
          exactProvenance: {
            supported: true,
            supportingEvidenceIndexes: [0],
          },
        },
      },
    } as unknown as RagChatWorkflowState;

    await useCase.execute({
      state,
      latencyMs: 5,
      nodeTimings: { draftAnswerNode: 1 },
    });
    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({
        workflowMetrics: expect.objectContaining({
          retrievalRetryCount: 2,
          answerRetryCount: 1,
          citationRetryCount: 1,
          citationEvidenceIds: ['reel:r1:chunk:0'],
          citationSelectedEvidenceIds: ['e0'],
          deterministicSupportingEvidenceIds: [],
          citationEvidenceMappings: [
            {
              citationIndex: 0,
              selectedEvidenceId: 'e0',
              evidenceId: 'reel:r1:chunk:0',
            },
          ],
          diagnostics: expect.objectContaining({
            draftHistory: state.draftHistory,
            finalFailureSource: 'NO_CONTEXT',
            failure: state.failureDiagnostics,
            citationAttempts: state.citationAttempts,
            citationDiagnostics: state.citationCoverage?.diagnostics,
            answerCalls: state.answerDiagnostics,
            retrievalPlanActual: {
              mode: 'REEL_HYBRID',
              query: 'spoken project',
              rewrittenQuery: 'spoken project',
              queries: ['spoken project', 'project name'],
              searchLimit: 8,
              rerankLimit: 5,
              shouldRerank: true,
              reason: 'Focused transcript search.',
            },
            retrievalExecution: state.retrievalExecution,
            routeDecision: {
              intent: 'REEL_VIDEO_QUESTION',
              referenceTarget: 'SHARED_REEL',
              reelQuestionType: 'TRANSCRIPT_CONTENT',
              requiredEvidence: ['TRANSCRIPT'],
              needsRetrieval: true,
              needsVerification: true,
              recommendationActionType: 'NONE',
            },
            route: state.route?.diagnostics,
            retrievalPlan: state.retrievalPlan?.diagnostics,
            retrievalCounts: { retrieved: 0, reranked: 0 },
            answerClaims: state.answerClaims,
            contextSufficiency: expect.objectContaining({
              supportedEvidenceIds: ['e0'],
            }),
            verification: expect.objectContaining({
              supportedClaimMappings: [
                { claim: 'answer', evidenceIds: ['e0'] },
              ],
              contradictions: [],
            }),
            finalization: expect.objectContaining({
              draftAnswerExecuted: true,
              verifierExecuted: true,
              verifierDecision: 'PASS',
              citationExecuted: true,
              citationProviderStatus: 200,
              finalSource: 'FAILURE_FALLBACK',
              finalFailureSource: 'NO_CONTEXT',
            }),
          }),
        }),
      }),
    );
  });

  it('bounds actual retrieval-plan text in persisted diagnostics', async () => {
    const create = jest.fn().mockResolvedValue(undefined);
    const useCase = new SaveRagTraceUseCase({ create });
    await useCase.execute({
      state: {
        userId: 'u',
        conversationId: 'c',
        userMessage: 'question',
        retrievedChunks: [],
        rerankedChunks: [],
        retryCount: 0,
        retrievalRetryCount: 0,
        citationRetryCount: 0,
        draftHistory: [],
        draftRevision: 0,
        citationAttempts: [],
        nextDraftSource: 'INITIAL',
        finalFailureSource: 'NONE',
        retrievalPlan: {
          mode: 'REEL_HYBRID',
          query: 'q'.repeat(1_000),
          rewrittenQuery: 'w'.repeat(1_000),
          queries: ['a'.repeat(1_000), 'b'.repeat(1_000), 'c'.repeat(1_000)],
          searchLimit: 8,
          rerankLimit: 5,
          shouldRerank: true,
          reason: 'r'.repeat(500),
        },
      },
      latencyMs: 1,
      nodeTimings: {},
    });

    const actual =
      create.mock.calls[0][0].workflowMetrics.diagnostics.retrievalPlanActual;
    expect(actual.query).toHaveLength(500);
    expect(actual.rewrittenQuery).toHaveLength(500);
    expect(actual.queries).toEqual([
      'a'.repeat(500),
      'b'.repeat(500),
      'c'.repeat(500),
    ]);
    expect(actual.reason).toHaveLength(240);
  });
});
