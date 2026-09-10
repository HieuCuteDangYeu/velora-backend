import type { RagChatWorkflowState } from '@ai/domain/interfaces/rag-chat-workflow.interface';
import type { RagCitationAssessment } from '@ai/application/use-cases/build-rag-citations.use-case';
import { LangGraphRagChatWorkflowAdapter } from './langgraph-rag-chat-workflow.adapter';

describe('LangGraphRagChatWorkflowAdapter routing', () => {
  const workflow = new LangGraphRagChatWorkflowAdapter(
    undefined as never,
    undefined as never,
    undefined as never,
    undefined as never,
    undefined as never,
    undefined as never,
    undefined as never,
    undefined as never,
    undefined as never,
    undefined as never,
    undefined as never,
    undefined as never,
    undefined as never,
    { get: jest.fn() } as never,
    undefined as never,
  );
  const routeAfterVerifier = workflow as unknown as {
    routeAfterVerifier: (state: RagChatWorkflowState) => string;
    routeAfterContextSufficiency: (state: RagChatWorkflowState) => string;
    routeAfterCitationCoverage: (state: RagChatWorkflowState) => string;
    createPrepareAnswerRevisionNode: () => (
      state: RagChatWorkflowState,
    ) => Partial<RagChatWorkflowState>;
    createPrepareCitationRevisionNode: () => (
      state: RagChatWorkflowState,
    ) => Partial<RagChatWorkflowState>;
    createVerificationFailureNode: () => (
      state: RagChatWorkflowState,
    ) => Partial<RagChatWorkflowState>;
    createCitationNode: (
      nodeTimings: Record<string, number>,
    ) => (
      state: RagChatWorkflowState,
    ) => Promise<Partial<RagChatWorkflowState>>;
    buildRouterReferentContext: (state: RagChatWorkflowState) => {
      conversationHasSharedReelContext: boolean;
      accessibleSharedReelCount: number;
      recentShareEvent: boolean;
      turnsSinceRecentShare?: number;
      recentEventTypes: string[];
    };
    formatRecentHistory: (state: RagChatWorkflowState) => string;
  };
  const state = (overrides: Partial<RagChatWorkflowState> = {}) =>
    ({
      userId: 'user-1',
      conversationId: 'conversation-1',
      userMessage: 'What is the answer?',
      retrievedChunks: [],
      rerankedChunks: [],
      retryCount: 0,
      retrievalRetryCount: 0,
      citationRetryCount: 0,
      citationAttempts: [],
      ...overrides,
    }) as RagChatWorkflowState;

  it('routes a verified answer to citation attribution', () => {
    expect(
      routeAfterVerifier.routeAfterVerifier(
        state({
          verification: {
            passed: true,
            confidence: 1,
            issues: [],
            requiresRevision: false,
          },
        }),
      ),
    ).toBe('citationNode');
  });

  it('routes successful semantic context negatives through answer verification', () => {
    expect(
      routeAfterVerifier.routeAfterContextSufficiency(
        state({
          route: { requiredEvidence: ['TRANSCRIPT'] },
          rerankedChunks: [
            {
              evidenceType: 'TRANSCRIPT',
              evidenceText: 'Typed transcript evidence.',
              chunkText: 'Typed transcript evidence.',
              tags: [],
            },
          ],
          contextSufficiency: {
            sufficient: false,
            confidence: 0.2,
            availableEvidence: ['TRANSCRIPT'],
            missingEvidence: ['TRANSCRIPT'],
            reason: 'Semantic negative.',
            recommendedAction: 'REFUSE_NO_CONTEXT',
            diagnostics: { providerStatus: 'SUCCESS', decisionSource: 'LLM' },
          },
        }),
      ),
    ).toBe('markRetrievalReadyNode');
  });

  it('keeps provider-error context failures on the refusal path', () => {
    expect(
      routeAfterVerifier.routeAfterContextSufficiency(
        state({
          route: { requiredEvidence: ['TRANSCRIPT'] },
          contextSufficiency: {
            sufficient: false,
            confidence: 0,
            availableEvidence: ['TRANSCRIPT'],
            missingEvidence: ['TRANSCRIPT'],
            reason: 'Provider unavailable.',
            recommendedAction: 'REFUSE_NO_CONTEXT',
            diagnostics: {
              providerStatus: 'ERROR',
              decisionSource: 'FAIL_CLOSED',
            },
          },
        }),
      ),
    ).toBe('noContextAnswerNode');
  });

  it('derives a bounded recent-share signal from structural memory metadata', () => {
    expect(
      routeAfterVerifier.buildRouterReferentContext(
        state({
          hasSharedReelContext: true,
          accessibleReelIds: ['private-reel-id'],
          memory: {
            recentMessages: [
              {
                role: 'user',
                content: '[Shared reel] Generic title',
                createdAt: '2026-01-01T00:00:00.000Z',
                eventType: 'REEL_SHARE',
              },
              {
                role: 'user',
                content: 'What is it about?',
                createdAt: '2026-01-01T00:00:01.000Z',
                eventType: 'TEXT',
              },
            ],
          },
        }),
      ),
    ).toEqual({
      conversationHasSharedReelContext: true,
      accessibleSharedReelCount: 1,
      recentShareEvent: true,
      turnsSinceRecentShare: 1,
      recentEventTypes: ['REEL_SHARE', 'TEXT'],
    });
  });

  it('does not infer a recent share from legacy free-form history alone', () => {
    expect(
      routeAfterVerifier.buildRouterReferentContext(
        state({
          hasSharedReelContext: true,
          accessibleReelIds: ['private-reel-id'],
          memory: {
            recentMessages: [
              {
                role: 'user',
                content: '[Shared reel] Legacy title',
                createdAt: '2026-01-01T00:00:00.000Z',
              },
            ],
          },
        }),
      ),
    ).toMatchObject({ recentShareEvent: false, recentEventTypes: [] });
  });

  it('formats a realistic reel question and assistant answer follow-up coherently', () => {
    const followUpState = state({
      hasSharedReelContext: true,
      accessibleReelIds: ['private-reel-id'],
      memory: {
        recentMessages: [
          {
            role: 'user',
            content: '[Shared recording] orbital lattice',
            createdAt: '2026-01-01T00:00:00.000Z',
            eventType: 'REEL_SHARE',
          },
          {
            role: 'user',
            content: 'Which structure does the presenter introduce first?',
            createdAt: '2026-01-01T00:00:01.000Z',
            eventType: 'TEXT',
          },
          {
            role: 'assistant',
            content: 'The presenter introduces the outer lattice.',
            createdAt: '2026-01-01T00:00:02.000Z',
            eventType: 'TEXT',
          },
        ],
      },
    });

    expect(routeAfterVerifier.formatRecentHistory(followUpState)).toBe(
      'USER: [Shared recording] orbital lattice\n' +
        'USER: Which structure does the presenter introduce first?\n' +
        'ASSISTANT: The presenter introduces the outer lattice.',
    );
    expect(
      routeAfterVerifier.buildRouterReferentContext(followUpState),
    ).toEqual({
      conversationHasSharedReelContext: true,
      accessibleSharedReelCount: 1,
      recentShareEvent: true,
      turnsSinceRecentShare: 2,
      recentEventTypes: ['REEL_SHARE', 'TEXT', 'TEXT'],
    });
  });

  it('keeps shared-reel context after the recent-share signal expires', () => {
    const delayedState = state({
      hasSharedReelContext: true,
      accessibleReelIds: ['private-reel-id'],
      memory: {
        recentMessages: [
          {
            role: 'user',
            content: '[Shared recording] orbital lattice',
            createdAt: '2026-01-01T00:00:00.000Z',
            eventType: 'REEL_SHARE',
          },
          ...Array.from({ length: 5 }, (_, index) => ({
            role: index % 2 === 0 ? ('user' as const) : ('assistant' as const),
            content: `Synthetic text event ${index + 1}.`,
            createdAt: `2026-01-01T00:00:0${index + 1}.000Z`,
            eventType: 'TEXT' as const,
          })),
        ],
      },
    });

    expect(routeAfterVerifier.buildRouterReferentContext(delayedState)).toEqual(
      {
        conversationHasSharedReelContext: true,
        accessibleSharedReelCount: 1,
        recentShareEvent: false,
        turnsSinceRecentShare: 5,
        recentEventTypes: [
          'REEL_SHARE',
          'TEXT',
          'TEXT',
          'TEXT',
          'TEXT',
          'TEXT',
        ],
      },
    );
  });

  it('routes a revisable verifier failure to answer revision', () => {
    expect(
      routeAfterVerifier.routeAfterVerifier(
        state({
          verification: {
            passed: false,
            confidence: 0,
            issues: [],
            requiresRevision: true,
          },
        }),
      ),
    ).toBe('prepareAnswerRevisionNode');
  });

  it('routes an exhausted verifier failure to the generic refusal', () => {
    expect(
      routeAfterVerifier.routeAfterVerifier(
        state({
          retryCount: 1,
          verification: {
            passed: false,
            confidence: 0,
            issues: [],
            requiresRevision: true,
          },
        }),
      ),
    ).toBe('verificationFailureNode');
  });

  it('routes a fully covered LLM attribution to the final answer', () => {
    expect(
      routeAfterVerifier.routeAfterCitationCoverage(
        state({
          citationCoverage: {
            mode: 'LLM',
            coverage: 1,
            factualClaimCount: 1,
            supportedClaimCount: 1,
            unsupportedClaims: [],
          },
        }),
      ),
    ).toBe('finalAnswerNode');
  });

  it('routes low LLM citation coverage to citation revision', () => {
    expect(
      routeAfterVerifier.routeAfterCitationCoverage(
        state({
          citationCoverage: {
            mode: 'LLM',
            coverage: 0,
            factualClaimCount: 1,
            supportedClaimCount: 0,
            unsupportedClaims: ['unsupported'],
          },
        }),
      ),
    ).toBe('prepareCitationRevisionNode');
  });

  it('routes exhausted low citation coverage to the generic refusal', () => {
    expect(
      routeAfterVerifier.routeAfterCitationCoverage(
        state({
          citationRetryCount: 1,
          citationCoverage: {
            mode: 'LLM',
            coverage: 0,
            factualClaimCount: 1,
            supportedClaimCount: 0,
            unsupportedClaims: ['unsupported'],
          },
        }),
      ),
    ).toBe('verificationFailureNode');
  });

  it('does not send a deterministically grounded compact transcript fact to refusal', () => {
    expect(
      routeAfterVerifier.routeAfterCitationCoverage(
        state({
          citationCoverage: {
            mode: 'DETERMINISTIC',
            coverage: 1,
            factualClaimCount: 1,
            supportedClaimCount: 1,
            unsupportedClaims: [],
          },
        }),
      ),
    ).toBe('finalAnswerNode');
  });

  it('labels verifier and citation revisions explicitly in graph state', () => {
    expect(
      routeAfterVerifier.createPrepareAnswerRevisionNode()(state()),
    ).toMatchObject({
      retryCount: 1,
      nextDraftSource: 'VERIFIER_REVISION',
    });
    expect(
      routeAfterVerifier.createPrepareCitationRevisionNode()(
        state({
          citationCoverage: {
            mode: 'LLM',
            coverage: 0,
            factualClaimCount: 1,
            supportedClaimCount: 0,
            unsupportedClaims: [],
          },
        }),
      ),
    ).toMatchObject({
      citationRetryCount: 1,
      nextDraftSource: 'CITATION_REVISION',
    });
  });

  it('sets an explicit terminal failure source rather than parsing the refusal text', () => {
    const terminal = routeAfterVerifier.createVerificationFailureNode();
    expect(terminal(state())).toMatchObject({ finalFailureSource: 'VERIFIER' });
    expect(
      terminal(
        state({
          citationCoverage: {
            mode: 'LLM',
            coverage: 0,
            factualClaimCount: 1,
            supportedClaimCount: 0,
            unsupportedClaims: [],
          },
        }),
      ),
    ).toMatchObject({ finalFailureSource: 'CITATION' });
  });

  it('retains per-attempt citation diagnostics before a later attempt overwrites coverage', async () => {
    const firstAssessment: RagCitationAssessment = {
      citations: [],
      coverage: {
        mode: 'FALLBACK',
        coverage: 0,
        factualClaimCount: 1,
        supportedClaimCount: 0,
        unsupportedClaims: [],
        diagnostics: {
          decisionSource: 'FALLBACK',
          selectedEvidenceIds: [],
          deterministicSupportingEvidenceIds: [],
          providerStatus: 'ERROR',
          modelRole: 'CITATION_ATTRIBUTION',
          semanticCalls: [
            {
              modelRole: 'CITATION_ATTRIBUTION',
              model: 'test/test/citation',
              providerStatus: 'TIMEOUT',
              latencyMs: 4_000,
              configuredTimeoutMs: 4_000,
              configuredMaxCompletionTokens: 768,
              attempt: 1,
              errorCode: 'STRUCTURED_COMPLETION_TIMEOUT',
            },
          ],
        },
      },
    };
    const buildCitations = {
      execute: jest.fn().mockResolvedValue(firstAssessment),
    };
    const workflow = new LangGraphRagChatWorkflowAdapter(
      undefined as never,
      undefined as never,
      undefined as never,
      undefined as never,
      undefined as never,
      undefined as never,
      undefined as never,
      undefined as never,
      undefined as never,
      undefined as never,
      undefined as never,
      buildCitations as never,
      undefined as never,
      { get: jest.fn() } as never,
      undefined as never,
    ) as unknown as {
      createCitationNode: (
        nodeTimings: Record<string, number>,
      ) => (
        state: RagChatWorkflowState,
      ) => Promise<Partial<RagChatWorkflowState>>;
    };

    const result = await workflow.createCitationNode({})(state());

    expect(result).toMatchObject({
      citationAttempts: [
        {
          attempt: 0,
          decisionSource: 'FALLBACK',
          coverage: 0,
          providerStatus: 'ERROR',
          semanticCalls: [
            expect.objectContaining({
              errorCode: 'STRUCTURED_COMPLETION_TIMEOUT',
            }),
          ],
        },
      ],
      citationDiagnostics: expect.objectContaining({
        providerStatus: 'ERROR',
      }),
    });
  });
});

describe('LangGraphRagChatWorkflowAdapter diagnostic nodes', () => {
  type DiagnosticNode = (
    state: RagChatWorkflowState,
  ) => Promise<Partial<RagChatWorkflowState>>;
  interface DiagnosticWorkflow {
    createDraftAnswerNode: (
      nodeTimings: Record<string, number>,
    ) => DiagnosticNode;
    createNoContextAnswerNode: (
      nodeTimings: Record<string, number>,
    ) => DiagnosticNode;
    createFinalAnswerNode: (
      nodeTimings: Record<string, number>,
    ) => DiagnosticNode;
  }

  const makeWorkflow = (answer = 'answer') =>
    new LangGraphRagChatWorkflowAdapter(
      undefined as never,
      undefined as never,
      undefined as never,
      undefined as never,
      undefined as never,
      undefined as never,
      undefined as never,
      {
        execute: jest.fn().mockResolvedValue({
          answer,
          claims: [],
          modelRole: 'ANSWER',
        }),
      } as never,
      undefined as never,
      { execute: jest.fn().mockResolvedValue('final') } as never,
      { execute: jest.fn().mockReturnValue('no context') } as never,
      undefined as never,
      undefined as never,
      { get: jest.fn() } as never,
      undefined as never,
    ) as unknown as DiagnosticWorkflow;
  const base = (): RagChatWorkflowState => ({
    userId: 'u',
    conversationId: 'c',
    userMessage: 'q',
    retrievedChunks: [],
    rerankedChunks: [],
    retryCount: 0,
    retrievalRetryCount: 0,
    citationRetryCount: 0,
    citations: [],
    draftHistory: [],
    draftRevision: 0,
    citationAttempts: [],
    nextDraftSource: 'INITIAL',
    finalFailureSource: 'UNKNOWN',
  });

  it('records an initial bounded draft generated by the production draft node', async () => {
    const workflow = makeWorkflow('x'.repeat(1_600));
    const result = await workflow.createDraftAnswerNode({})(base());
    expect(result.draftHistory).toEqual([
      { revision: 0, source: 'INITIAL', answer: 'x'.repeat(1_500) },
    ]);
  });

  it('uses a bounded grounded verifier revision before calling the draft LLM', async () => {
    const groundedRevision = {
      executeWithProvenance: jest.fn().mockResolvedValue({
        answer: 'One CD is not even one GB.',
        evidenceIds: ['e0'],
        modelRole: 'ANSWER_REVISION',
      }),
    };
    const workflow = new LangGraphRagChatWorkflowAdapter(
      undefined as never,
      undefined as never,
      undefined as never,
      undefined as never,
      undefined as never,
      undefined as never,
      undefined as never,
      { execute: jest.fn() } as never,
      undefined as never,
      undefined as never,
      undefined as never,
      undefined as never,
      undefined as never,
      { get: jest.fn() } as never,
      undefined as never,
      groundedRevision as never,
    ) as unknown as DiagnosticWorkflow;

    const result = await workflow.createDraftAnswerNode({})(
      base({
        nextDraftSource: 'VERIFIER_REVISION',
        verification: {
          passed: false,
          confidence: 1,
          issues: [],
          requiresRevision: true,
        },
      }),
    );

    expect(result).toMatchObject({
      answer: 'One CD is not even one GB.',
      draftHistory: [
        expect.objectContaining({ source: 'GROUNDED_VERIFIER_REVISION' }),
      ],
    });
    expect(groundedRevision.executeWithProvenance).toHaveBeenCalledTimes(1);
  });

  it('routes citation revisions through the grounded ANSWER_REVISION path', async () => {
    const groundedRevision = {
      executeWithProvenance: jest.fn().mockResolvedValue({
        answer: 'A grounded citation revision.',
        evidenceIds: ['e0'],
        modelRole: 'ANSWER_REVISION',
      }),
    };
    const draft = { execute: jest.fn() };
    const workflow = new LangGraphRagChatWorkflowAdapter(
      undefined as never,
      undefined as never,
      undefined as never,
      undefined as never,
      undefined as never,
      undefined as never,
      undefined as never,
      draft as never,
      undefined as never,
      undefined as never,
      undefined as never,
      undefined as never,
      undefined as never,
      { get: jest.fn() } as never,
      undefined as never,
      groundedRevision as never,
    ) as unknown as DiagnosticWorkflow;

    const result = await workflow.createDraftAnswerNode({})({
      ...base(),
      nextDraftSource: 'CITATION_REVISION',
      verification: {
        passed: false,
        confidence: 0,
        issues: ['Citation coverage failed.'],
        requiresRevision: true,
      },
    });

    expect(result).toMatchObject({
      answer: 'A grounded citation revision.',
      groundedRevision: { evidenceIds: ['e0'], modelRole: 'ANSWER_REVISION' },
      draftHistory: [
        expect.objectContaining({ source: 'GROUNDED_VERIFIER_REVISION' }),
      ],
    });
    expect(groundedRevision.executeWithProvenance).toHaveBeenCalledTimes(1);
    expect(draft.execute).not.toHaveBeenCalled();
  });

  it('bounds graph-generated draft history at configured revision capacity', async () => {
    const workflow = makeWorkflow();
    const draft = workflow.createDraftAnswerNode({});
    let state = base();
    for (let revision = 0; revision < 4; revision += 1) {
      const result = await draft(state);
      state = { ...state, ...result, nextDraftSource: 'VERIFIER_REVISION' };
    }
    expect(state.draftHistory).toHaveLength(2);
    expect(state.draftHistory.map((entry) => entry.revision)).toEqual([2, 3]);
  });

  it('preserves terminal failure sources when final streaming runs', async () => {
    const workflow = makeWorkflow();
    const noContext = await workflow.createNoContextAnswerNode({})(base());
    expect(noContext.finalFailureSource).toBe('NO_CONTEXT');
    const final = await workflow.createFinalAnswerNode({})({
      ...base(),
      ...noContext,
    });
    expect(final).toMatchObject({
      answer: 'final',
      finalFailureSource: 'NO_CONTEXT',
    });
  });

  it.each(['VERIFIER', 'CITATION'] as const)(
    'preserves %s when final streaming runs',
    async (finalFailureSource) => {
      const workflow = makeWorkflow();
      await expect(
        workflow.createFinalAnswerNode({})({
          ...base(),
          finalFailureSource,
        }),
      ).resolves.toMatchObject({ finalFailureSource });
    },
  );

  it('marks a successful terminal answer as having no failure source', async () => {
    const workflow = makeWorkflow();
    await expect(
      workflow.createFinalAnswerNode({})(base()),
    ).resolves.toMatchObject({
      answer: 'final',
      finalFailureSource: 'NONE',
    });
  });
});

describe('LangGraphRagChatWorkflowAdapter failure diagnostics', () => {
  it('persists router diagnostics when graph execution fails before returning state', async () => {
    const save = { execute: jest.fn().mockResolvedValue(undefined) };
    const queryRouterError = Object.assign(
      new Error('Semantic router is temporarily unavailable'),
      {
        name: 'RouterUnavailableError',
        code: 'ROUTER_UNAVAILABLE',
        causeCode: 'ROUTER_SEMANTIC_INCONSISTENT',
        semanticInconsistencyType: 'REQUIRED_EVIDENCE_MISMATCH',
        semanticInconsistencyDetails: {
          actualIntent: 'REEL_VIDEO_QUESTION',
          actualReelQuestionType: 'TRANSCRIPT_CONTENT',
          actualEvidence: ['TRANSCRIPT'],
          expectedEvidence: ['TRANSCRIPT'],
          query: 'must-not-persist',
          reelId: 'must-not-persist',
        },
        semanticCalls: [
          {
            modelRole: 'ROUTER',
            model: 'test/test/router',
            providerStatus: 200,
            latencyMs: 12,
            configuredTimeoutMs: 30_000,
            configuredMaxCompletionTokens: 512,
            finishReason: 'stop',
            endpointContract: 'CHAT_JSON_SCHEMA',
            responseContentType: 'string',
            contentPresent: true,
            toolCallsPresent: false,
            attempt: 1,
            requestId: 'must-not-persist',
          },
        ],
      },
    );
    const workflow = new LangGraphRagChatWorkflowAdapter(
      { execute: jest.fn().mockRejectedValue(queryRouterError) } as never,
      undefined as never,
      undefined as never,
      undefined as never,
      undefined as never,
      undefined as never,
      undefined as never,
      undefined as never,
      undefined as never,
      undefined as never,
      undefined as never,
      undefined as never,
      save as never,
      { get: jest.fn() } as never,
      {
        resolveReelContextAccess: jest.fn().mockResolvedValue(['reel-1']),
      } as never,
      undefined,
    );

    await expect(
      workflow.execute({
        userId: 'user-1',
        conversationId: 'conversation-1',
        message: 'question',
      }),
    ).rejects.toMatchObject({ code: 'ROUTER_UNAVAILABLE' });

    expect(save.execute).toHaveBeenCalledWith(
      expect.objectContaining({
        state: expect.objectContaining({
          finalFailureSource: 'PROVIDER_ERROR',
          failureDiagnostics: expect.objectContaining({
            failedNode: 'queryRouterNode',
            errorName: 'RouterUnavailableError',
            errorCode: 'ROUTER_UNAVAILABLE',
            causeCode: 'ROUTER_SEMANTIC_INCONSISTENT',
            semanticInconsistencyType: 'REQUIRED_EVIDENCE_MISMATCH',
            semanticInconsistencyDetails: {
              actualIntent: 'REEL_VIDEO_QUESTION',
              actualReelQuestionType: 'TRANSCRIPT_CONTENT',
              actualEvidence: ['TRANSCRIPT'],
              expectedEvidence: ['TRANSCRIPT'],
            },
            semanticCalls: [
              expect.objectContaining({
                model: 'test/test/router',
                providerStatus: 200,
                endpointContract: 'CHAT_JSON_SCHEMA',
              }),
            ],
          }),
        }),
      }),
    );

    const savedState = save.execute.mock.calls[0][0].state;
    expect(savedState.failureDiagnostics.semanticCalls[0]).not.toHaveProperty(
      'requestId',
    );
    expect(
      savedState.failureDiagnostics.semanticInconsistencyDetails,
    ).not.toHaveProperty('query');
    expect(
      savedState.failureDiagnostics.semanticInconsistencyDetails,
    ).not.toHaveProperty('reelId');
  });
});
