import type { RagChatWorkflowState } from '@ai/domain/interfaces/rag-chat-workflow.interface';
import type { RagCitationAssessment } from '@ai/application/use-cases/build-rag-citations.use-case';
import { CreateNoContextAnswerUseCase } from '@ai/application/use-cases/create-no-context-answer.use-case';
import { DraftAnswerGenerationError } from '@ai/application/use-cases/generate-draft-answer.use-case';
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
    ) => Promise<Partial<RagChatWorkflowState>>;
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
    routesAfterQueryRouter: (state: RagChatWorkflowState) => string[];
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

  it('routes context acquisition through the unified tool agent when enabled', () => {
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
      {
        get: jest.fn((key: string) =>
          key === 'RAG_CONTEXT_TOOL_AGENT_ENABLED' ? 'true' : undefined,
        ),
      } as never,
      undefined as never,
      undefined,
      undefined,
      undefined,
      {} as never,
    ) as unknown as {
      routesAfterQueryRouter: (state: RagChatWorkflowState) => string[];
      buildGraph: (timings: Record<string, number>) => unknown;
    };

    const destinations = workflow.routesAfterQueryRouter(
      state({
        route: {
          intent: 'REEL_VIDEO_QUESTION',
          recommendationAction: { type: 'NONE', reason: 'none' },
          needsRetrieval: true,
        },
      }),
    );

    expect(destinations).toContain('contextToolAgentNode');
    expect(destinations).not.toContain('retrievalPlannerNode');
    expect(destinations).not.toContain('memorySelectorNode');
    expect(workflow.buildGraph({})).toBeDefined();
  });

  it('records context-agent executions as Langfuse tool observations', async () => {
    const observations: Array<{ name: string; type: string }> = [];
    const langfuseTracing = {
      observe: jest.fn(
        async (
          name: string,
          operation: () => Promise<unknown>,
          _input: unknown,
          type: string,
        ) => {
          observations.push({ name, type });
          return operation();
        },
      ),
    };
    const contextToolAgentUseCase = {
      execute: jest.fn(
        async (
          _input: unknown,
          options: {
            observeTool?: (
              toolName: string,
              operation: () => Promise<unknown>,
            ) => Promise<unknown>;
          },
        ) => {
          await options.observeTool?.('search_reel_content', () =>
            Promise.resolve({ retrievedChunks: [] }),
          );
          return { retrievedChunks: [], rerankedChunks: [] };
        },
      ),
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
      undefined as never,
      undefined as never,
      { get: jest.fn() } as never,
      undefined as never,
      undefined,
      undefined,
      langfuseTracing as never,
      contextToolAgentUseCase as never,
    ) as unknown as {
      createContextToolAgentNode: (
        timings: Record<string, number>,
      ) => (state: RagChatWorkflowState) => Promise<unknown>;
    };

    const node = workflow.createContextToolAgentNode({});
    await node(
      state({
        route: { intent: 'REEL_VIDEO_QUESTION', needsRetrieval: true } as never,
      }),
    );

    expect(observations).toContainEqual({
      name: 'tool.search_reel_content',
      type: 'tool',
    });
  });

  it('routes an ambiguous Reel referent directly to clarification without retrieval', () => {
    expect(
      routeAfterVerifier.routesAfterQueryRouter(
        state({
          route: {
            intent: 'REEL_VIDEO_QUESTION',
            referenceTarget: 'SHARED_REEL',
            needsRetrieval: true,
            needsUserMemory: false,
            needsConversationSummary: false,
            needsVerification: true,
            reelQuestionType: 'AMBIGUOUS_REEL_REFERENCE',
            requiredEvidence: ['TRANSCRIPT', 'VISUAL'],
            recommendationAction: { type: 'NONE', reason: 'none' },
            reason: 'The requested Reel is unclear.',
          },
        }),
      ),
    ).toEqual(['noContextAnswerNode']);
  });

  it('routes structured recommendation actions without free-form answer generation', () => {
    expect(
      routeAfterVerifier.routesAfterQueryRouter(
        state({
          route: {
            intent: 'NORMAL_CHAT',
            referenceTarget: 'NONE',
            needsRetrieval: false,
            needsUserMemory: false,
            needsConversationSummary: false,
            needsVerification: false,
            reelQuestionType: 'NONE',
            requiredEvidence: ['NONE'],
            recommendationAction: {
              type: 'RECOMMEND_REELS',
              query: 'dogs',
              minRelevantItems: 1,
              allowPersonalizedFallback: false,
              reason: 'The user requested dog Reels.',
            },
            reason: 'Recommendation request.',
          },
        }),
      ),
    ).toEqual(['reelRecommendationNode']);
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

  it('routes provider-error context results with typed evidence through grounding gates', () => {
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
    ).toBe('markRetrievalReadyNode');
  });

  it('keeps missing-modality context failures on the refusal path', () => {
    expect(
      routeAfterVerifier.routeAfterContextSufficiency(
        state({
          route: { requiredEvidence: ['TRANSCRIPT'] },
          contextSufficiency: {
            sufficient: false,
            confidence: 1,
            availableEvidence: [],
            missingEvidence: ['TRANSCRIPT'],
            reason: 'Missing transcript.',
            recommendedAction: 'REFUSE_NO_CONTEXT',
            diagnostics: {
              providerStatus: 'NOT_CALLED',
              decisionSource: 'DETERMINISTIC_REQUIRED_MODALITY',
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

  it('routes a grounded answer-quality failure to answer revision', () => {
    expect(
      routeAfterVerifier.routeAfterVerifier(
        state({
          verification: {
            passed: true,
            confidence: 0.95,
            issues: [],
            answerQualityPassed: false,
            answerQualityIssues: ['Answer is indirect.'],
            requiresRevision: true,
          },
        }),
      ),
    ).toBe('prepareAnswerRevisionNode');
  });

  it('keeps a grounded answer after answer-quality revision capacity is exhausted', () => {
    expect(
      routeAfterVerifier.routeAfterVerifier(
        state({
          retryCount: 1,
          verification: {
            passed: true,
            confidence: 0.95,
            issues: [],
            answerQualityPassed: false,
            answerQualityIssues: ['Answer is indirect.'],
            requiresRevision: true,
          },
        }),
      ),
    ).toBe('citationNode');
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

  it('sets an explicit terminal failure source rather than parsing the refusal text', async () => {
    const terminal = routeAfterVerifier.createVerificationFailureNode();
    await expect(terminal(state())).resolves.toMatchObject({
      finalFailureSource: 'VERIFIER',
    });
    await expect(
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
    ).resolves.toMatchObject({ finalFailureSource: 'CITATION' });
  });

  it('tries an exact evidence fallback after citation coverage exhausts and keeps failing closed if citations still miss the threshold', async () => {
    const fallback = {
      answer: 'Episode One: The speaker says hello.',
      claims: [
        { claim: 'Episode One: The speaker says hello.', evidenceIds: ['e0'] },
      ],
      generationEvidence: [
        {
          evidenceId: 'e0',
          sourceId: 'chunk-one',
          reelId: 'reel-one',
          evidenceType: 'TRANSCRIPT',
          title: 'Episode One',
          evidenceText: 'The speaker says hello.',
        },
      ],
      finalizationMode: 'EXTRACTIVE_EVIDENCE_FALLBACK',
      fallbackReason: 'UNUSABLE_SYNTHESIS',
    };
    const citation = {
      sourceType: 'REEL',
      reelId: 'reel-one',
      evidenceType: 'TRANSCRIPT',
      title: 'Episode One',
      startTime: 0,
      endTime: 2,
      quote: 'The speaker says hello.',
    };
    const assessment = {
      citations: [citation],
      coverage: {
        mode: 'DETERMINISTIC',
        coverage: 1,
        factualClaimCount: 1,
        supportedClaimCount: 1,
        unsupportedClaims: [],
        diagnostics: {
          providerStatus: 'SUCCESS',
          decisionSource: 'DETERMINISTIC',
          selectedEvidenceIds: ['e0'],
          deterministicSupportingEvidenceIds: ['e0'],
          selectedEvidenceMappings: [
            {
              citationIndex: 0,
              selectedEvidenceId: 'e0',
              evidenceId: 'chunk-one',
            },
          ],
        },
      },
    };
    const lowAssessment = {
      citations: [],
      coverage: {
        mode: 'DETERMINISTIC',
        coverage: 0,
        factualClaimCount: 1,
        supportedClaimCount: 0,
        unsupportedClaims: ['unsupported'],
        diagnostics: { providerStatus: 'SUCCESS' },
      },
    };
    const generateDraftAnswer = {
      buildExtractiveFallback: jest.fn().mockReturnValue(fallback),
    };
    const buildRagCitations = {
      execute: jest
        .fn()
        .mockResolvedValueOnce(assessment)
        .mockResolvedValueOnce(lowAssessment),
    };
    const workflow = new LangGraphRagChatWorkflowAdapter(
      undefined as never,
      undefined as never,
      undefined as never,
      undefined as never,
      undefined as never,
      undefined as never,
      undefined as never,
      generateDraftAnswer as never,
      undefined as never,
      undefined as never,
      undefined as never,
      buildRagCitations as never,
      undefined as never,
      { get: jest.fn() } as never,
      undefined as never,
    ) as unknown as {
      createVerificationFailureNode: () => (
        state: RagChatWorkflowState,
      ) => Promise<Partial<RagChatWorkflowState>>;
    };
    const failureNode = workflow.createVerificationFailureNode();
    const failedCitationState = state({
      route: {
        intent: 'REEL_VIDEO_QUESTION',
        reelQuestionType: 'TRANSCRIPT_CONTENT',
        requiredEvidence: ['TRANSCRIPT'],
      },
      contextSufficiency: {
        sufficient: true,
        supportedEvidenceIds: ['e0'],
        missingEvidence: [],
      },
      answerGenerationMode: 'SYNTHESIZED',
      verification: {
        passed: true,
        confidence: 1,
        issues: [],
        requiresRevision: false,
        diagnostics: {
          providerStatus: 'SUCCESS',
          decisionSource: 'LLM_PRIMARY',
          finalPassed: true,
          confidence: 1,
          issues: [],
          requiresRevision: false,
          escalated: false,
        },
      },
      citationCoverage: {
        mode: 'LLM',
        coverage: 0.857,
        factualClaimCount: 7,
        supportedClaimCount: 6,
        unsupportedClaims: ['unsupported'],
      },
      citationRetryCount: 1,
    });

    await expect(failureNode(failedCitationState)).resolves.toMatchObject({
      answer: fallback.answer,
      answerGenerationMode: 'EXTRACTIVE_EVIDENCE_FALLBACK',
      citations: [citation],
      citationCoverage: { coverage: 1 },
      finalFailureSource: 'NONE',
    });
    expect(generateDraftAnswer.buildExtractiveFallback).toHaveBeenCalledTimes(
      1,
    );

    const rejected = await failureNode(failedCitationState);
    expect(rejected).toMatchObject({
      citations: [],
      finalFailureSource: 'CITATION',
      citationCoverage: { coverage: 0.857 },
    });
  });

  it('uses the task-action limitation after an exhausted task-action verification failure', async () => {
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
      new CreateNoContextAnswerUseCase(),
      undefined as never,
      undefined as never,
      { get: jest.fn() } as never,
      undefined as never,
    ) as unknown as {
      createVerificationFailureNode: (
        nodeTimings: Record<string, number>,
      ) => (
        state: RagChatWorkflowState,
      ) => Promise<Partial<RagChatWorkflowState>>;
    };

    const terminal = workflow.createVerificationFailureNode({});
    await expect(
      terminal(
        state({
          userMessage: 'Send an email to my colleague.',
          route: {
            intent: 'TASK_ACTION_REQUEST',
            toolPlan: { allowedTools: [], requiredTools: [] },
          },
          contextSufficiency: { sufficient: true } as never,
          verification: {
            passed: false,
            confidence: 0,
            issues: ['Unexecuted action.'],
            requiresRevision: true,
          },
        }),
      ),
    ).resolves.toMatchObject({
      answer: expect.stringMatching(/no email has been sent/i),
      finalFailureSource: 'VERIFIER',
    });
  });

  it.each([
    [
      'provider outage',
      {
        passed: false,
        confidence: 0,
        issues: ['Required semantic answer verification was unavailable.'],
        requiresRevision: false,
        diagnostics: {
          providerStatus: 'ERROR',
          decisionSource: 'FAIL_CLOSED',
          finalPassed: false,
          confidence: 0,
          issues: ['Required semantic answer verification was unavailable.'],
          requiresRevision: false,
          exactProvenance: {
            supported: false,
            supportingEvidenceIndexes: [],
          },
        },
      },
    ],
    [
      'unexplained semantic false negative',
      {
        passed: false,
        confidence: 0.65,
        issues: [],
        requiresRevision: true,
        supportedClaimMappings: [
          { claim: 'One CD is not even one GB.', evidenceIds: ['e0'] },
        ],
        contradictions: [],
        diagnostics: {
          providerStatus: 'SUCCESS',
          decisionSource: 'LLM_ESCALATION',
          providerPassed: false,
          finalPassed: false,
          confidence: 0.65,
          issues: [],
          requiresRevision: true,
          supportedClaimMappings: [
            { claim: 'One CD is not even one GB.', evidenceIds: ['e0'] },
          ],
          contradictions: [],
          exactProvenance: {
            supported: false,
            supportingEvidenceIndexes: [],
          },
        },
      },
    ],
  ])(
    'recovers a verifier %s with an authorized extractive fallback',
    async (_scenario, verification) => {
      const fallback = {
        answer: 'this one is said to be blue',
        claims: [
          {
            claim: 'this one is said to be blue',
            evidenceIds: ['e0'],
          },
        ],
        modelRole: 'ANSWER' as const,
        diagnostics: [],
        finalizationMode: 'EXTRACTIVE_TRANSCRIPT_FALLBACK' as const,
        fallbackReason: 'UNUSABLE_SYNTHESIS' as const,
      };
      const generateDraftAnswer = {
        buildExtractiveFallback: jest.fn().mockReturnValue(fallback),
      };
      const buildCitations = {
        execute: jest.fn().mockResolvedValue({
          citations: [{ reelId: 'reel-1', evidenceId: 'chunk-1' }],
          coverage: {
            mode: 'FALLBACK',
            coverage: 1,
            factualClaimCount: 1,
            supportedClaimCount: 1,
            unsupportedClaims: [],
          },
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
        generateDraftAnswer as never,
        undefined as never,
        undefined as never,
        undefined as never,
        buildCitations as never,
        undefined as never,
        { get: jest.fn() } as never,
        undefined as never,
      ) as unknown as {
        createVerificationFailureNode: () => (
          state: RagChatWorkflowState,
        ) => Promise<Partial<RagChatWorkflowState>>;
      };

      const terminal = workflow.createVerificationFailureNode();
      const result = await terminal(
        state({
          route: {
            intent: 'REEL_VIDEO_QUESTION',
            requiredEvidence: ['TRANSCRIPT'],
          },
          verification,
        }),
      );

      expect(generateDraftAnswer.buildExtractiveFallback).toHaveBeenCalledWith(
        expect.any(Object),
        'UNUSABLE_SYNTHESIS',
      );
      expect(buildCitations.execute).toHaveBeenCalledTimes(1);
      expect(result).toMatchObject({
        answer: 'this one is said to be blue',
        answerGenerationMode: 'EXTRACTIVE_TRANSCRIPT_FALLBACK',
        verification: {
          passed: true,
          diagnostics: { decisionSource: 'EXACT_PROVENANCE' },
        },
        finalFailureSource: 'NONE',
      });
    },
  );

  it('recovers an unexplained verifier rejection when the current answer already has extractive provenance', async () => {
    const fallback = {
      answer: 'This one is said to be blue.',
      claims: [
        {
          claim: 'This one is said to be blue.',
          evidenceIds: ['e0'],
        },
      ],
      modelRole: 'ANSWER' as const,
      diagnostics: [],
      finalizationMode: 'EXTRACTIVE_TRANSCRIPT_FALLBACK' as const,
      fallbackReason: 'UNUSABLE_SYNTHESIS' as const,
    };
    const generateDraftAnswer = {
      buildExtractiveFallback: jest.fn().mockReturnValue(fallback),
    };
    const buildCitations = {
      execute: jest.fn().mockResolvedValue({
        citations: [{ reelId: 'reel-1', evidenceId: 'chunk-1' }],
        coverage: {
          mode: 'FALLBACK',
          coverage: 1,
          factualClaimCount: 1,
          supportedClaimCount: 1,
          unsupportedClaims: [],
        },
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
      generateDraftAnswer as never,
      undefined as never,
      undefined as never,
      undefined as never,
      buildCitations as never,
      undefined as never,
      { get: jest.fn() } as never,
      undefined as never,
    ) as unknown as {
      createVerificationFailureNode: () => (
        state: RagChatWorkflowState,
      ) => Promise<Partial<RagChatWorkflowState>>;
    };

    const result = await workflow.createVerificationFailureNode()(
      state({
        route: {
          intent: 'REEL_VIDEO_QUESTION',
          requiredEvidence: ['TRANSCRIPT'],
        },
        answer: 'This one is said to be blue.',
        answerGenerationMode: 'EXTRACTIVE_TRANSCRIPT_FALLBACK',
        answerClaims: [
          {
            claim: 'This one is said to be blue.',
            evidenceIds: ['e0'],
          },
        ],
        verification: {
          passed: false,
          confidence: 0.2,
          issues: [],
          contradictions: [],
          supportedClaimMappings: [],
          requiresRevision: true,
          diagnostics: {
            providerStatus: 'SUCCESS',
            decisionSource: 'LLM_ESCALATION',
            finalPassed: false,
            confidence: 0.2,
            issues: [],
            contradictions: [],
            supportedClaimMappings: [],
            requiresRevision: true,
            exactProvenance: {
              supported: false,
              supportingEvidenceIndexes: [],
            },
          },
        },
      }),
    );

    expect(generateDraftAnswer.buildExtractiveFallback).toHaveBeenCalledTimes(
      1,
    );
    expect(result).toMatchObject({
      answer: 'This one is said to be blue.',
      finalFailureSource: 'NONE',
      verification: {
        passed: true,
        diagnostics: { decisionSource: 'EXACT_PROVENANCE' },
      },
    });
  });

  it.each([undefined, 'UNUSABLE_SYNTHESIS'] as const)(
    'retains citation diagnostics for fallback %s',
    async (answerFallbackReason) => {
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

      const result = await workflow.createCitationNode({})({
        ...state(),
        answerFallbackReason,
      });
      expect(buildCitations.execute).toHaveBeenCalledTimes(1);

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
    },
  );
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
    createReelRecommendationNode: (
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
          finalizationMode: 'SYNTHESIZED',
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
    expect(result.answerGenerationMode).toBe('SYNTHESIZED');
  });

  it('clears a prior terminal failure after a revised answer succeeds', async () => {
    const workflow = makeWorkflow('Recovered answer.');
    const result = await workflow.createDraftAnswerNode({})({
      ...base(),
      finalFailureSource: 'WORKFLOW',
      nextDraftSource: 'VERIFIER_REVISION',
      verification: {
        passed: false,
        confidence: 0,
        issues: ['Revise this answer.'],
        requiresRevision: true,
      },
    });

    expect(result).toMatchObject({
      answer: 'Recovered answer.',
      finalFailureSource: 'NONE',
    });
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

  it('delegates first-complete-sentence revisions to the candidate selector', async () => {
    const groundedRevision = {
      executeWithProvenance: jest.fn().mockResolvedValue(undefined),
    };
    const draft = {
      execute: jest.fn().mockResolvedValue({
        answer: 'Get away from me.',
        claims: [{ claim: 'Get away from me.', evidenceIds: ['e0'] }],
        modelRole: 'ANSWER',
        diagnostics: [],
        generationEvidence: [],
        finalizationMode: 'SYNTHESIZED',
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
      userMessage:
        'Quote the first complete sentence in the indexed transcript segment spanning 9.52-62.28 seconds.',
      route: {
        intent: 'REEL_VIDEO_QUESTION',
        requiredEvidence: ['TRANSCRIPT'],
      } as never,
      nextDraftSource: 'VERIFIER_REVISION',
      verification: {
        passed: false,
        confidence: 0,
        issues: ['The previous sentence was incomplete.'],
        requiresRevision: true,
      },
    });

    expect(groundedRevision.executeWithProvenance).toHaveBeenCalledTimes(1);
    expect(draft.execute).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({
      answer: 'Get away from me.',
      draftHistory: [
        expect.objectContaining({
          source: 'VERIFIER_REVISION',
          answer: 'Get away from me.',
        }),
      ],
    });
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

  it('falls back to draft generation when grounded verifier revision throws an error', async () => {
    const groundedRevision = {
      executeWithProvenance: jest
        .fn()
        .mockRejectedValue(new Error('Groq 429 rate limit exceeded')),
    };
    const draft = {
      execute: jest.fn().mockResolvedValue({
        answer: 'Draft answer fallback.',
        claims: [],
        modelRole: 'ANSWER',
        diagnostics: [],
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
      nextDraftSource: 'VERIFIER_REVISION',
      verification: {
        passed: false,
        confidence: 0,
        issues: ['Requires revision.'],
        requiresRevision: true,
      },
    });

    expect(result).toMatchObject({
      answer: 'Draft answer fallback.',
    });
    expect(groundedRevision.executeWithProvenance).toHaveBeenCalledTimes(1);
    expect(draft.execute).toHaveBeenCalledTimes(1);
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

  it('renders recommendation prose only from returned Reel titles', async () => {
    const reels = [
      {
        id: 'reel-dog-1',
        userId: 'creator-1',
        mediaKey: 'media-1',
        title: 'Dogs at the park',
        description: 'Feature claims should not be invented from titles.',
        tags: ['dogs'],
        status: 'COMPLETED',
        visibility: 'public',
        createdAt: '2026-01-01T00:00:00.000Z',
      },
    ];
    const contentService = {
      searchPublicReels: jest.fn().mockResolvedValue(reels),
      getRecommendedReels: jest.fn(),
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
      undefined as never,
      undefined as never,
      { get: jest.fn() } as never,
      contentService as never,
    ) as unknown as DiagnosticWorkflow;
    const result = await workflow.createReelRecommendationNode({})({
      ...base(),
      route: {
        intent: 'NORMAL_CHAT',
        referenceTarget: 'NONE',
        needsRetrieval: false,
        needsUserMemory: false,
        needsConversationSummary: false,
        needsVerification: false,
        reelQuestionType: 'NONE',
        requiredEvidence: ['NONE'],
        recommendationAction: {
          type: 'RECOMMEND_REELS',
          query: 'dogs',
          minRelevantItems: 1,
          allowPersonalizedFallback: false,
          reason: 'The user requested dog Reels.',
        },
        reason: 'Recommendation request.',
      },
    });

    expect(result.answer).toBe(
      'Here are accessible Reels that may match:\n- Dogs at the park',
    );
    expect(result.answer).not.toContain('sign language');
    expect(result.recommendedReels).toEqual(reels);
    expect(contentService.searchPublicReels).toHaveBeenCalledWith({
      query: 'dogs',
      viewerId: 'u',
      limit: 8,
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
  it.each(['ROUTER_SEMANTIC_INCONSISTENT', 'GROQ_KEY_POOL_EXHAUSTED'])(
    'preserves %s rather than inventing a transcript route',
    async (causeCode) => {
      const save = { execute: jest.fn().mockResolvedValue(undefined) };
      const queryRouterError = Object.assign(
        new Error('Semantic router is temporarily unavailable'),
        {
          name: 'RouterUnavailableError',
          code: 'ROUTER_UNAVAILABLE',
          causeCode,
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
        undefined,
        {
          withRoot: (
            _metadata: unknown,
            operation: (root: unknown) => Promise<unknown>,
          ) => operation({ traceId: 'trace-1' }),
          observe: (_name: unknown, operation: () => Promise<unknown>) =>
            operation(),
          recordSemanticCalls: jest.fn(),
          setRootOutput: jest.fn(),
        } as never,
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
              causeCode,
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
    },
  );

  it('falls back to no-context answer when draft answer generation throws an error', async () => {
    const generateDraftAnswer = {
      execute: jest
        .fn()
        .mockRejectedValue(
          new Error('Answer model returned an evidence-dependent refusal'),
        ),
    };
    const createNoContextAnswer = {
      execute: jest
        .fn()
        .mockReturnValue(
          'I do not have enough shared reel metadata to answer that reliably.',
        ),
    };
    const workflow = new LangGraphRagChatWorkflowAdapter(
      undefined as never,
      undefined as never,
      undefined as never,
      undefined as never,
      undefined as never,
      undefined as never,
      undefined as never,
      generateDraftAnswer as never,
      undefined as never,
      undefined as never,
      createNoContextAnswer as never,
      undefined as never,
      undefined as never,
      { get: jest.fn() } as never,
      undefined as never,
    ) as unknown as {
      createDraftAnswerNode: (
        timings: Record<string, number>,
      ) => (
        state: RagChatWorkflowState,
      ) => Promise<Partial<RagChatWorkflowState>>;
    };

    const node = workflow.createDraftAnswerNode({});
    const mockState = {
      userId: 'user-1',
      conversationId: 'conversation-1',
      userMessage: 'What title is assigned to this Reel?',
      route: {
        intent: 'REEL_VIDEO_QUESTION' as const,
        reelQuestionType: 'REEL_METADATA' as const,
        requiredEvidence: ['METADATA' as const],
      },
      retrievedChunks: [],
      rerankedChunks: [],
      retryCount: 0,
      retrievalRetryCount: 0,
      citationRetryCount: 0,
      citationAttempts: [],
      draftHistory: [],
      draftRevision: 0,
      nextDraftSource: 'INITIAL' as const,
    } as unknown as RagChatWorkflowState;

    const result = await node(mockState);

    expect(result).toMatchObject({
      answer:
        'I do not have enough shared reel metadata to answer that reliably.',
      answerGenerationMode: 'FAILURE_FALLBACK',
      answerFallbackReason: 'UNUSABLE_SYNTHESIS',
      citations: [],
      citationCoverage: { mode: 'NOT_REQUIRED' },
      verification: { passed: true },
      finalFailureSource: 'WORKFLOW',
    });
    expect(createNoContextAnswer.execute).toHaveBeenCalled();
  });

  it('retains successfully supplied evidence when answer-contract validation fails', async () => {
    const generationEvidence = [
      {
        evidenceId: 'e0',
        sourceId: 'transcript-1',
        reelId: 'reel-1',
        evidenceType: 'TRANSCRIPT' as const,
        evidenceText: 'The speaker says hello.',
      },
    ];
    const generateDraftAnswer = {
      execute: jest
        .fn()
        .mockRejectedValue(
          new DraftAnswerGenerationError(
            new Error('required evidence coverage failed'),
            [{ modelRole: 'ANSWER', providerStatus: 200 } as never],
            'UNUSABLE_SYNTHESIS',
            generationEvidence,
          ),
        ),
    };
    const createNoContextAnswer = {
      executeAfterAnswerGenerationFailure: jest
        .fn()
        .mockReturnValue(
          'I could not form a reliable answer from the available shared Reel evidence.',
        ),
    };
    const workflow = new LangGraphRagChatWorkflowAdapter(
      undefined as never,
      undefined as never,
      undefined as never,
      undefined as never,
      undefined as never,
      undefined as never,
      undefined as never,
      generateDraftAnswer as never,
      undefined as never,
      undefined as never,
      createNoContextAnswer as never,
      undefined as never,
      undefined as never,
      { get: jest.fn() } as never,
      undefined as never,
    ) as unknown as {
      createDraftAnswerNode: (
        timings: Record<string, number>,
      ) => (
        state: RagChatWorkflowState,
      ) => Promise<Partial<RagChatWorkflowState>>;
    };

    const node = workflow.createDraftAnswerNode({});
    const result = await node({
      userId: 'user-1',
      conversationId: 'conversation-1',
      userMessage: 'What is said in the shared Reel?',
      route: { intent: 'REEL_VIDEO_QUESTION' },
      retrievedChunks: [],
      rerankedChunks: [],
      retryCount: 0,
      retrievalRetryCount: 0,
      citationRetryCount: 0,
      citationAttempts: [],
      draftHistory: [],
      draftRevision: 0,
      nextDraftSource: 'INITIAL',
    } as unknown as RagChatWorkflowState);

    expect(result.generationEvidence).toEqual(generationEvidence);
    expect(
      createNoContextAnswer.executeAfterAnswerGenerationFailure,
    ).toHaveBeenCalled();
  });
});

describe('LangGraphRagChatWorkflowAdapter monitoring isolation', () => {
  function monitoredWorkflow(capture: () => unknown) {
    const snapshot = { execute: jest.fn(capture) };
    const output = jest.fn();
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
      snapshot as never,
      { get: jest.fn() } as never,
      undefined as never,
      undefined,
      undefined,
      {
        withRoot: (
          _metadata: unknown,
          operation: (root: unknown) => Promise<unknown>,
        ) => operation({ traceId: 'langfuse-trace-1' }),
        setRootOutput: output,
        recordSemanticCalls: jest.fn(),
      } as never,
    );
    const invoke = jest.fn((state: RagChatWorkflowState) =>
      Promise.resolve({
        ...state,
        answer: 'answer',
        finalFailureSource: 'NONE',
      }),
    );
    jest
      .spyOn(workflow as never, 'buildGraph')
      .mockReturnValue({ invoke } as never);
    return { workflow, snapshot, output, invoke };
  }

  it('captures a single correlated snapshot without changing the public response', async () => {
    const { workflow, snapshot, output } = monitoredWorkflow(() => ({
      diagnostic: true,
    }));
    await expect(
      workflow.execute({
        userId: 'u',
        conversationId: 'c',
        message: 'question',
      }),
    ).resolves.toEqual({
      answer: 'answer',
      citations: [],
      recommendedReels: [],
      suggestedQueries: [],
    });
    expect(snapshot.execute).toHaveBeenCalledTimes(1);
    expect(snapshot.execute).toHaveBeenCalledWith(
      expect.objectContaining({
        langfuseTraceId: 'langfuse-trace-1',
        productionExecutionId: expect.any(String),
      }),
    );
    expect(output).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ outcome: 'SUCCEEDED' }),
      'answer',
      { diagnostic: true },
    );
  });

  it('keeps the result and original workflow error when monitoring fails', async () => {
    const { workflow, invoke } = monitoredWorkflow(() => {
      throw new Error('monitoring unavailable');
    });
    await expect(
      workflow.execute({
        userId: 'u',
        conversationId: 'c',
        message: 'question',
      }),
    ).resolves.toMatchObject({ answer: 'answer' });
    const original = Object.assign(new Error('workflow failed'), {
      code: 'PROVIDER_FAILURE',
    });
    invoke.mockRejectedValueOnce(original);
    await expect(
      workflow.execute({
        userId: 'u',
        conversationId: 'c',
        message: 'question',
      }),
    ).rejects.toBe(original);
  });
});
