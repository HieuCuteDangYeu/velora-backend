import type { IAiApplicationConfig } from '@ai/domain/interfaces/ai-application-config.interface';
import type { GenerateStructuredObjectInput } from '@ai/domain/interfaces/structured-llm.service.interface';
import {
  QueryRouterAgentUseCase,
  RouterUnavailableError,
  RouterSemanticInconsistencyError,
  shouldRetryPrimaryRouter,
} from './query-router-agent.use-case';

describe('QueryRouterAgentUseCase', () => {
  const config = {
    model: jest.fn(() => '@cf/test/router'),
    timeoutMs: jest.fn(() => 7_000),
    maxCompletionTokens: jest.fn(() => 384),
    get: jest.fn().mockReturnValue(undefined),
    number: jest.fn((_key: string, fallback: number) => fallback),
  } as unknown as IAiApplicationConfig;

  const primaryAttemptsConfig = (maxAttempts?: number) =>
    ({
      ...config,
      number: jest.fn((key: string, fallback: number) =>
        key === 'AI_ROUTER_PRIMARY_MAX_ATTEMPTS'
          ? (maxAttempts ?? fallback)
          : fallback,
      ),
    }) as unknown as IAiApplicationConfig;

  const routerDiagnostic = (attempt: number, overrides = {}) => ({
    modelRole: 'ROUTER',
    model: '@cf/test/router',
    providerStatus: 503 as const,
    latencyMs: 10,
    configuredTimeoutMs: 7_000,
    configuredMaxCompletionTokens: 384,
    attempt,
    errorCode: 'STRUCTURED_COMPLETION_PROVIDER_ERROR',
    providerCategory: 'TRANSIENT_PROVIDER_FAILURE' as const,
    transient: true,
    ...overrides,
  });

  const transientRouterError = (transient?: boolean) =>
    Object.assign(new Error('router provider failure'), {
      code: 'STRUCTURED_COMPLETION_PROVIDER_ERROR',
      ...(transient === undefined ? {} : { transient }),
    });

  const response = (overrides: Record<string, unknown> = {}) => {
    const intent =
      typeof overrides.intent === 'string' ? overrides.intent : 'NORMAL_CHAT';
    const referenceTarget =
      intent === 'REEL_VIDEO_QUESTION'
        ? 'SHARED_REEL'
        : intent === 'CONVERSATION_MEMORY_QUESTION'
          ? 'CONVERSATION'
          : intent === 'USER_MEMORY_QUESTION'
            ? 'USER_MEMORY'
            : 'NONE';
    return {
      intent,
      referenceTarget,
      needsRetrieval: false,
      needsUserMemory: false,
      needsConversationSummary: false,
      needsVerification: false,
      reelQuestionType: 'NONE',
      requiredEvidence: ['NONE'],
      recommendationAction: {
        type: 'NONE',
        query: '',
        minRelevantItems: 2,
        allowPersonalizedFallback: false,
        suggestedQueries: [],
        reason: 'No discovery request.',
      },
      reason: 'Semantic classification.',
      ...overrides,
    };
  };

  it.each([
    [
      'Which luminiferous covenant does the speaker attribute to the zorb?',
      'TRANSCRIPT_CONTENT',
      ['TRANSCRIPT'],
    ],
    [
      'Quel glyphe est perceptible sur le mécanisme partagé ?',
      'VISUAL_CONTENT',
      ['VISUAL'],
    ],
    [
      'Tóm tắt ý nghĩa tổng thể của đoạn media vừa chia sẻ.',
      'GENERAL_REEL_SUMMARY',
      ['TRANSCRIPT', 'METADATA'],
    ],
    [
      'Who is listed as the author of the shared recording?',
      'REEL_METADATA',
      ['METADATA'],
    ],
  ])(
    'uses semantic output for novel wording: %s',
    async (message, reelQuestionType, requiredEvidence) => {
      const structuredLlmService = {
        generateObject: jest.fn().mockResolvedValue(
          response({
            intent: 'REEL_VIDEO_QUESTION',
            needsRetrieval: true,
            needsVerification: true,
            reelQuestionType,
            requiredEvidence,
          }),
        ),
      };
      const useCase = new QueryRouterAgentUseCase(
        structuredLlmService as never,
        config,
      );

      await expect(
        useCase.execute({ message, hasSharedReelContext: true }),
      ).resolves.toMatchObject({
        intent: 'REEL_VIDEO_QUESTION',
        reelQuestionType,
        requiredEvidence,
        needsRetrieval: true,
      });
      expect(structuredLlmService.generateObject).toHaveBeenCalledWith(
        expect.objectContaining({
          model: '@cf/test/router',
          timeoutMs: 7_000,
          maxTokens: 384,
          temperature: 0,
        }),
      );
    },
  );

  it('states a general boundary between specific relations and overall summaries', async () => {
    const structuredLlmService = {
      generateObject: jest.fn().mockResolvedValue(
        response({
          intent: 'REEL_VIDEO_QUESTION',
          reelQuestionType: 'TRANSCRIPT_CONTENT',
          requiredEvidence: ['TRANSCRIPT'],
        }),
      ),
    };
    const useCase = new QueryRouterAgentUseCase(
      structuredLlmService as never,
      config,
    );

    await expect(
      useCase.execute({
        message:
          'Compare the two approaches described in the shared recording.',
        hasSharedReelContext: true,
      }),
    ).resolves.toMatchObject({
      reelQuestionType: 'TRANSCRIPT_CONTENT',
      requiredEvidence: ['TRANSCRIPT'],
    });

    const request = structuredLlmService.generateObject.mock.calls[0][0];
    expect(request.systemPrompt).toContain(
      'specific spoken or textual reel content',
    );
    expect(request.systemPrompt).toContain('not an overall summary request');
    expect(request.systemPrompt).toContain('comparative');
  });

  it('retains independent modality choices for an ambiguous reel request', async () => {
    const structuredLlmService = {
      generateObject: jest.fn().mockResolvedValue(
        response({
          intent: 'REEL_VIDEO_QUESTION',
          reelQuestionType: 'AMBIGUOUS_REEL_REFERENCE',
          requiredEvidence: ['TRANSCRIPT', 'VISUAL'],
        }),
      ),
    };
    const useCase = new QueryRouterAgentUseCase(
      structuredLlmService as never,
      config,
    );

    await expect(
      useCase.execute({
        message: 'What should I inspect in the shared recording?',
        hasSharedReelContext: true,
      }),
    ).resolves.toMatchObject({
      reelQuestionType: 'AMBIGUOUS_REEL_REFERENCE',
      requiredEvidence: ['TRANSCRIPT', 'VISUAL'],
    });
  });

  it('fails closed on an invalid semantic tuple without relying on fixture wording', async () => {
    const structuredLlmService = {
      generateObject: jest.fn().mockResolvedValue(
        response({
          intent: 'REEL_VIDEO_QUESTION',
          referenceTarget: 'NONE',
          reelQuestionType: 'TRANSCRIPT_CONTENT',
          requiredEvidence: ['TRANSCRIPT'],
        }),
      ),
    };

    await expect(
      new QueryRouterAgentUseCase(
        structuredLlmService as never,
        config,
      ).execute({
        message: 'A generic multilingual semantic request.',
        hasSharedReelContext: true,
      }),
    ).rejects.toMatchObject({
      code: 'ROUTER_UNAVAILABLE',
      causeCode: 'ROUTER_SEMANTIC_INCONSISTENT',
    });
  });

  it('keeps canonical enums language-invariant for a generic equivalent tuple', async () => {
    const structuredLlmService = {
      generateObject: jest.fn().mockResolvedValue(
        response({
          intent: 'REEL_VIDEO_QUESTION',
          reelQuestionType: 'TRANSCRIPT_CONTENT',
          requiredEvidence: ['TRANSCRIPT'],
        }),
      ),
    };

    await expect(
      new QueryRouterAgentUseCase(
        structuredLlmService as never,
        config,
      ).execute({
        message: 'Demande sémantique générique.',
        hasSharedReelContext: true,
      }),
    ).resolves.toMatchObject({
      intent: 'REEL_VIDEO_QUESTION',
      referenceTarget: 'SHARED_REEL',
      reelQuestionType: 'TRANSCRIPT_CONTENT',
      requiredEvidence: ['TRANSCRIPT'],
    });

    const request = structuredLlmService.generateObject.mock.calls[0][0];
    expect(request.systemPrompt).toContain('regardless of the language used');
    expect(request.systemPrompt).toContain('canonical enum values');
  });

  it('rejects contradictory evidence and discovery instead of silently rewriting them', async () => {
    const structuredLlmService = {
      generateObject: jest.fn().mockResolvedValue(
        response({
          intent: 'REEL_VIDEO_QUESTION',
          reelQuestionType: 'VISUAL_CONTENT',
          requiredEvidence: ['TRANSCRIPT', 'VISUAL', 'CONVERSATION_MEMORY'],
          recommendationAction: {
            type: 'RECOMMEND_REELS',
            query: 'unrelated',
            minRelevantItems: 8,
            allowPersonalizedFallback: true,
            suggestedQueries: [],
            reason: 'Incorrect provider action.',
          },
        }),
      ),
    };
    const useCase = new QueryRouterAgentUseCase(
      structuredLlmService as never,
      config,
    );

    await expect(
      useCase.execute({
        message: 'Inspect the shared medium.',
        hasSharedReelContext: true,
      }),
    ).rejects.toBeInstanceOf(RouterUnavailableError);
  });

  it.each([
    ['CONVERSATION_MEMORY_QUESTION', ['CONVERSATION_MEMORY']],
    ['USER_MEMORY_QUESTION', ['USER_MEMORY']],
  ])('rejects contradictory evidence for %s', async (intent) => {
    const structuredLlmService = {
      generateObject: jest.fn().mockResolvedValue(
        response({
          intent,
          requiredEvidence: ['TRANSCRIPT', 'USER_MEMORY'],
        }),
      ),
    };
    const useCase = new QueryRouterAgentUseCase(
      structuredLlmService as never,
      config,
    );

    await expect(
      useCase.execute({ message: 'Recall context.' }),
    ).rejects.toBeInstanceOf(RouterUnavailableError);
  });

  it('keeps unrelated chat normal even when reel context exists', async () => {
    const structuredLlmService = {
      generateObject: jest.fn().mockResolvedValue(response()),
    };
    const useCase = new QueryRouterAgentUseCase(
      structuredLlmService as never,
      config,
    );

    await expect(
      useCase.execute({
        message: 'Explain dependency injection.',
        hasSharedReelContext: true,
      }),
    ).resolves.toMatchObject({
      intent: 'NORMAL_CHAT',
      needsRetrieval: false,
      reelQuestionType: 'NONE',
    });
  });

  it('does not misclassify provider failure as normal chat', async () => {
    const useCase = new QueryRouterAgentUseCase(
      {
        generateObject: jest.fn().mockRejectedValue(new Error('provider down')),
      } as never,
      config,
    );

    await expect(
      useCase.execute({ message: 'Novel shared-media question.' }),
    ).rejects.toThrow('provider down');
  });

  it.each([
    ['NORMAL_CHAT', 'NONE', 'NONE', ['NONE'], [false, true, true, false]],
    [
      'REEL_VIDEO_QUESTION',
      'SHARED_REEL',
      'TRANSCRIPT_CONTENT',
      ['TRANSCRIPT'],
      [true, false, true, true],
    ],
    [
      'CONVERSATION_MEMORY_QUESTION',
      'CONVERSATION',
      'NONE',
      ['CONVERSATION_MEMORY'],
      [false, false, true, true],
    ],
    [
      'USER_MEMORY_QUESTION',
      'USER_MEMORY',
      'NONE',
      ['USER_MEMORY'],
      [false, true, false, true],
    ],
    [
      'TASK_ACTION_REQUEST',
      'NONE',
      'NONE',
      ['NONE'],
      [false, false, false, true],
    ],
  ])(
    'derives mechanical flags for %s without model booleans',
    async (
      intent,
      referenceTarget,
      reelQuestionType,
      requiredEvidence,
      flags,
    ) => {
      const raw = response({
        intent,
        referenceTarget,
        reelQuestionType,
        requiredEvidence,
      });
      for (const key of [
        'needsRetrieval',
        'needsUserMemory',
        'needsConversationSummary',
        'needsVerification',
      ])
        delete (raw as Record<string, unknown>)[key];
      const service = { generateObject: jest.fn().mockResolvedValue(raw) };
      const result = await new QueryRouterAgentUseCase(
        service as never,
        config,
      ).execute({
        message: 'A generic semantic request.',
        hasSharedReelContext: true,
      });
      expect([
        result.needsRetrieval,
        result.needsUserMemory,
        result.needsConversationSummary,
        result.needsVerification,
      ]).toEqual(flags);
      const input = service.generateObject.mock
        .calls[0][0] as GenerateStructuredObjectInput;
      expect(input.schemaVersion).toBe('router-semantic-v4');
      expect(input.jsonSchema.required).toEqual([
        'intent',
        'referenceTarget',
        'reelQuestionType',
        'requiredEvidence',
        'recommendationAction',
        'reason',
      ]);
    },
  );

  it.each(['RECOMMEND_REELS', 'SUGGEST_QUERIES'])(
    'keeps read-only discovery %s on normal chat',
    async (type) => {
      const raw = response({
        recommendationAction: {
          type,
          query: 'generic topic',
          allowPersonalizedFallback: false,
          suggestedQueries:
            type === 'SUGGEST_QUERIES' ? ['topic overview'] : [],
        },
      });
      const service = {
        generateObject: jest.fn().mockResolvedValue(raw),
      };
      await expect(
        new QueryRouterAgentUseCase(service as never, config).execute({
          message: 'A discovery request.',
          hasSharedReelContext: true,
        }),
      ).resolves.toMatchObject({
        intent: 'NORMAL_CHAT',
        referenceTarget: 'NONE',
        needsRetrieval: false,
        recommendationAction: { type },
      });
    },
  );

  it.each([
    { intent: 'NORMAL_CHAT', referenceTarget: 'SHARED_REEL' },
    {
      intent: 'TASK_ACTION_REQUEST',
      recommendationAction: {
        type: 'RECOMMEND_REELS',
        query: 'topic',
        allowPersonalizedFallback: false,
        suggestedQueries: [],
      },
    },
    { intent: 'NORMAL_CHAT', reelQuestionType: 'VISUAL_CONTENT' },
    { intent: 'NORMAL_CHAT', requiredEvidence: ['USER_MEMORY'] },
    { intent: 'unknown' },
  ])(
    'fails safely on semantic contradictions without fallback: %j',
    async (overrides) => {
      const service = {
        generateObject: jest.fn().mockResolvedValue(response(overrides)),
      };
      await expect(
        new QueryRouterAgentUseCase(service as never, config).execute({
          message: 'A generic request.',
          hasSharedReelContext: true,
        }),
      ).rejects.toMatchObject({
        code: 'ROUTER_UNAVAILABLE',
        causeCode: 'ROUTER_SEMANTIC_INCONSISTENT',
      });
      expect(service.generateObject).toHaveBeenCalledTimes(1);
    },
  );

  it('performs at most one semantic repair using the configured 60s fallback budget', async () => {
    const service = {
      generateObject: jest
        .fn()
        .mockResolvedValue(response({ referenceTarget: 'SHARED_REEL' })),
    };
    const bounded = {
      ...config,
      get: jest.fn((key: string) =>
        key === 'AI_ROUTER_FALLBACK_MODEL' ? '@cf/test/secondary' : undefined,
      ),
      number: jest.fn((key: string, fallback: number) =>
        key === 'AI_ROUTER_FALLBACK_TIMEOUT_MS'
          ? 60000
          : key === 'AI_ROUTER_FALLBACK_MAX_TOKENS'
            ? 2048
            : fallback,
      ),
    } as unknown as IAiApplicationConfig;
    await expect(
      new QueryRouterAgentUseCase(service as never, bounded).execute({
        message: 'Generic request.',
        hasSharedReelContext: true,
      }),
    ).rejects.toMatchObject({ code: 'ROUTER_UNAVAILABLE' });
    expect(service.generateObject).toHaveBeenCalledTimes(2);
    expect(service.generateObject.mock.calls[1][0]).toMatchObject({
      timeoutMs: 60000,
      maxTokens: 2048,
      attempt: 2,
    });
  });

  it('uses one configured fallback only after a transient primary failure', async () => {
    const transient = Object.assign(new Error('primary timeout'), {
      code: 'STRUCTURED_COMPLETION_TIMEOUT',
    });
    const service = {
      generateObject: jest
        .fn()
        .mockRejectedValueOnce(transient)
        .mockResolvedValueOnce(
          response({
            intent: 'REEL_VIDEO_QUESTION',
            needsRetrieval: true,
            needsVerification: true,
            reelQuestionType: 'TRANSCRIPT_CONTENT',
            requiredEvidence: ['TRANSCRIPT'],
          }),
        ),
    };
    const fallbackConfig = {
      ...config,
      get: jest.fn((key: string) =>
        key === 'AI_ROUTER_FALLBACK_MODEL'
          ? '@cf/openai/gpt-oss-20b'
          : undefined,
      ),
    } as unknown as IAiApplicationConfig;
    const useCase = new QueryRouterAgentUseCase(
      service as never,
      fallbackConfig,
    );

    await expect(
      useCase.execute({
        message: 'What does the shared synthetic reel explain?',
        hasSharedReelContext: true,
      }),
    ).resolves.toMatchObject({
      intent: 'REEL_VIDEO_QUESTION',
      diagnostics: {
        model: '@cf/openai/gpt-oss-20b',
        decisionSource: 'LLM_FALLBACK',
      },
    });
    expect(service.generateObject).toHaveBeenCalledTimes(2);
    expect(service.generateObject.mock.calls[1]?.[0]).toMatchObject({
      model: '@cf/openai/gpt-oss-20b',
      attempt: 2,
      timeoutMs: 30_000,
    });
  });

  it('does not fallback after a non-transient account limit', async () => {
    const limited = Object.assign(new Error('account limited'), {
      code: 'STRUCTURED_COMPLETION_PROVIDER_ERROR',
      transient: false,
      providerCode: 3036,
    });
    const service = { generateObject: jest.fn().mockRejectedValue(limited) };
    const fallbackConfig = {
      ...config,
      get: jest.fn((key: string) =>
        key === 'AI_ROUTER_FALLBACK_MODEL' ? '@cf/test/fallback' : undefined,
      ),
    } as unknown as IAiApplicationConfig;

    await expect(
      new QueryRouterAgentUseCase(service as never, fallbackConfig).execute({
        message: 'What did the shared clip say?',
      }),
    ).rejects.toBe(limited);
    expect(service.generateObject).toHaveBeenCalledTimes(1);
  });

  it('uses the secondary semantic router for an unresolved recent-share referent', async () => {
    const service = {
      generateObject: jest
        .fn()
        .mockResolvedValueOnce(response())
        .mockResolvedValueOnce(
          response({
            intent: 'REEL_VIDEO_QUESTION',
            referenceTarget: 'SHARED_REEL',
            needsRetrieval: true,
            needsVerification: true,
            reelQuestionType: 'TRANSCRIPT_CONTENT',
            requiredEvidence: ['TRANSCRIPT'],
          }),
        ),
    };
    const fallbackConfig = {
      ...config,
      get: jest.fn((key: string) =>
        key === 'AI_ROUTER_FALLBACK_MODEL' ? '@cf/test/secondary' : undefined,
      ),
    } as unknown as IAiApplicationConfig;

    await expect(
      new QueryRouterAgentUseCase(service as never, fallbackConfig).execute({
        message: 'How does the asserted relation follow?',
        hasSharedReelContext: true,
        referentContext: {
          conversationHasSharedReelContext: true,
          accessibleSharedReelCount: 2,
          recentShareEvent: true,
          turnsSinceRecentShare: 0,
          recentEventTypes: ['REEL_SHARE'],
        },
      }),
    ).resolves.toMatchObject({
      intent: 'REEL_VIDEO_QUESTION',
      referenceTarget: 'SHARED_REEL',
      diagnostics: {
        decisionSource: 'LLM_FALLBACK',
        fallbackReason: 'STRUCTURAL_REFERENT_AMBIGUITY',
      },
    });
    expect(service.generateObject).toHaveBeenCalledTimes(2);
  });

  it('does not force reel routing when both semantic routers resolve unrelated chat', async () => {
    const service = { generateObject: jest.fn().mockResolvedValue(response()) };
    const fallbackConfig = {
      ...config,
      get: jest.fn((key: string) =>
        key === 'AI_ROUTER_FALLBACK_MODEL' ? '@cf/test/secondary' : undefined,
      ),
    } as unknown as IAiApplicationConfig;

    await expect(
      new QueryRouterAgentUseCase(service as never, fallbackConfig).execute({
        message: 'Design a generic dependency boundary.',
        hasSharedReelContext: true,
        referentContext: {
          conversationHasSharedReelContext: true,
          accessibleSharedReelCount: 1,
          recentShareEvent: true,
          turnsSinceRecentShare: 0,
          recentEventTypes: ['REEL_SHARE'],
        },
      }),
    ).resolves.toMatchObject({
      intent: 'NORMAL_CHAT',
      referenceTarget: 'NONE',
    });
    expect(service.generateObject).toHaveBeenCalledTimes(2);
  });

  it('retries only explicitly transient structured provider errors', () => {
    expect(shouldRetryPrimaryRouter(transientRouterError(true))).toBe(true);
    expect(shouldRetryPrimaryRouter(transientRouterError(false))).toBe(false);
    expect(shouldRetryPrimaryRouter(transientRouterError())).toBe(false);
    expect(
      shouldRetryPrimaryRouter(
        Object.assign(new Error('timeout'), {
          code: 'STRUCTURED_COMPLETION_TIMEOUT',
          transient: true,
        }),
      ),
    ).toBe(false);
  });

  it('does not retry when the first Router attempt succeeds', async () => {
    const requests: GenerateStructuredObjectInput[] = [];
    const service = {
      generateObject: jest
        .fn()
        .mockImplementation((input: GenerateStructuredObjectInput) => {
          requests.push(input);
          input.onDiagnostics?.({
            ...routerDiagnostic(1),
            providerStatus: 200,
            providerCategory: undefined,
            transient: undefined,
          });
          return Promise.resolve(response());
        }),
    };

    await expect(
      new QueryRouterAgentUseCase(
        service as never,
        primaryAttemptsConfig(2),
      ).execute({ message: 'Normal chat.' }),
    ).resolves.toMatchObject({ intent: 'NORMAL_CHAT' });
    expect(service.generateObject).toHaveBeenCalledTimes(1);
    expect(requests[0].attempt).toBe(1);
  });

  it('retries the same Router model once after an explicit transient error', async () => {
    const first = transientRouterError(true);
    const requests: GenerateStructuredObjectInput[] = [];
    const service = {
      generateObject: jest
        .fn()
        .mockImplementationOnce((input: GenerateStructuredObjectInput) => {
          requests.push(input);
          input.onDiagnostics?.(routerDiagnostic(1));
          return Promise.reject(first);
        })
        .mockImplementationOnce((input: GenerateStructuredObjectInput) => {
          requests.push(input);
          input.onDiagnostics?.({
            ...routerDiagnostic(2),
            providerStatus: 200,
            providerCategory: undefined,
            transient: undefined,
          });
          return Promise.resolve(response());
        }),
    };

    const result = await new QueryRouterAgentUseCase(
      service as never,
      primaryAttemptsConfig(2),
    ).execute({ message: 'Normal chat.' });

    expect(result.intent).toBe('NORMAL_CHAT');
    expect(service.generateObject).toHaveBeenCalledTimes(2);
    expect(requests.map((input) => input.model)).toEqual([
      '@cf/test/router',
      '@cf/test/router',
    ]);
    expect(
      result.diagnostics?.semanticCalls?.map((call) => call.attempt),
    ).toEqual([1, 2]);
  });

  it('returns RouterUnavailableError after two explicit transient failures', async () => {
    const service = {
      generateObject: jest
        .fn()
        .mockImplementation((input: GenerateStructuredObjectInput) => {
          input.onDiagnostics?.(routerDiagnostic(input.attempt ?? 1));
          return Promise.reject(transientRouterError(true));
        }),
    };

    await expect(
      new QueryRouterAgentUseCase(
        service as never,
        primaryAttemptsConfig(2),
      ).execute({ message: 'Normal chat.' }),
    ).rejects.toMatchObject({
      code: 'ROUTER_UNAVAILABLE',
      semanticCalls: [
        expect.objectContaining({ attempt: 1 }),
        expect.objectContaining({ attempt: 2 }),
      ],
    });
    expect(service.generateObject).toHaveBeenCalledTimes(2);
  });

  it.each([
    ['non-transient provider error', transientRouterError(false)],
    ['unknown transient state', transientRouterError(undefined)],
    [
      'account limited',
      Object.assign(new Error('account limited'), {
        code: 'STRUCTURED_COMPLETION_PROVIDER_ERROR',
        providerCode: 3036,
        transient: false,
      }),
    ],
    [
      'schema failure',
      Object.assign(new Error('schema failure'), {
        code: 'STRUCTURED_COMPLETION_SCHEMA_INVALID',
      }),
    ],
    [
      'Router timeout',
      Object.assign(new Error('timeout'), {
        code: 'STRUCTURED_COMPLETION_TIMEOUT',
        transient: true,
      }),
    ],
  ])('does not primary-retry %s', async (_name, error: Error) => {
    const service = {
      generateObject: jest.fn().mockRejectedValue(error),
    };

    await expect(
      new QueryRouterAgentUseCase(
        service as never,
        primaryAttemptsConfig(2),
      ).execute({ message: 'Normal chat.' }),
    ).rejects.toBeDefined();
    expect(service.generateObject).toHaveBeenCalledTimes(1);
  });

  it('numbers an alternate fallback after two primary attempts', async () => {
    const requests: GenerateStructuredObjectInput[] = [];
    const service = {
      generateObject: jest
        .fn()
        .mockImplementationOnce((input: GenerateStructuredObjectInput) => {
          requests.push(input);
          input.onDiagnostics?.(routerDiagnostic(1));
          return Promise.reject(transientRouterError(true));
        })
        .mockImplementationOnce((input: GenerateStructuredObjectInput) => {
          requests.push(input);
          input.onDiagnostics?.(routerDiagnostic(2));
          return Promise.reject(transientRouterError(true));
        })
        .mockImplementationOnce((input: GenerateStructuredObjectInput) => {
          requests.push(input);
          input.onDiagnostics?.({
            ...routerDiagnostic(3),
            model: '@cf/test/fallback',
            providerStatus: 200,
            providerCategory: undefined,
            transient: undefined,
          });
          return Promise.resolve(response());
        }),
    };
    const fallbackConfig = {
      ...primaryAttemptsConfig(2),
      get: jest.fn((key: string) =>
        key === 'AI_ROUTER_FALLBACK_MODEL' ? '@cf/test/fallback' : undefined,
      ),
    } as unknown as IAiApplicationConfig;

    await expect(
      new QueryRouterAgentUseCase(service as never, fallbackConfig).execute({
        message: 'Normal chat.',
      }),
    ).resolves.toMatchObject({ intent: 'NORMAL_CHAT' });
    expect(service.generateObject).toHaveBeenCalledTimes(3);
    expect(requests.map((input) => input.attempt)).toEqual([1, 2, 3]);
  });

  it('does not retry semantic inconsistency', async () => {
    const service = {
      generateObject: jest
        .fn()
        .mockRejectedValue(
          new RouterSemanticInconsistencyError('INVALID_INTENT'),
        ),
    };

    await expect(
      new QueryRouterAgentUseCase(
        service as never,
        primaryAttemptsConfig(2),
      ).execute({ message: 'Normal chat.' }),
    ).rejects.toMatchObject({ code: 'ROUTER_UNAVAILABLE' });
    expect(service.generateObject).toHaveBeenCalledTimes(1);
  });

  it('keeps the default primary attempt count at one', async () => {
    const service = {
      generateObject: jest.fn().mockRejectedValue(transientRouterError(true)),
    };

    await expect(
      new QueryRouterAgentUseCase(service as never, config).execute({
        message: 'Normal chat.',
      }),
    ).rejects.toMatchObject({ code: 'ROUTER_UNAVAILABLE' });
    expect(service.generateObject).toHaveBeenCalledTimes(1);
  });

  it('returns typed unavailable after bounded transient failure', async () => {
    const transient = Object.assign(new Error('provider unavailable'), {
      code: 'STRUCTURED_COMPLETION_PROVIDER_ERROR',
    });
    const diagnostics = {
      model: '@cf/test/router',
      providerStatus: 503 as const,
      latencyMs: 10,
      configuredTimeoutMs: 1_000,
      configuredMaxCompletionTokens: 100,
      attempt: 1,
      errorCode: 'STRUCTURED_COMPLETION_PROVIDER_ERROR',
      transient: true,
    };
    const useCase = new QueryRouterAgentUseCase(
      {
        generateObject: jest
          .fn()
          .mockImplementation((input: GenerateStructuredObjectInput) => {
            input.onDiagnostics?.(diagnostics);
            throw transient;
          }),
      } as never,
      config,
    );

    const failure = useCase.execute({
      message: 'Novel shared-media question.',
    });
    await expect(failure).rejects.toBeInstanceOf(RouterUnavailableError);
    await expect(failure).rejects.toMatchObject({
      causeCode: 'STRUCTURED_COMPLETION_PROVIDER_ERROR',
      semanticCalls: [diagnostics],
    });
  });

  it.each([
    {
      name: 'invalid intent',
      overrides: { intent: 'NOT_A_CANONICAL_INTENT' },
      input: { hasSharedReelContext: true },
      type: 'INVALID_INTENT',
    },
    {
      name: 'invalid reference target',
      overrides: { referenceTarget: 'NOT_A_CANONICAL_TARGET' },
      input: { hasSharedReelContext: true },
      type: 'INVALID_REFERENCE_TARGET',
    },
    {
      name: 'intent/reference mismatch',
      overrides: {
        intent: 'REEL_VIDEO_QUESTION',
        referenceTarget: 'NONE',
        reelQuestionType: 'TRANSCRIPT_CONTENT',
        requiredEvidence: ['TRANSCRIPT'],
      },
      input: { hasSharedReelContext: true },
      type: 'INTENT_REFERENCE_MISMATCH',
      details: {
        actualIntent: 'REEL_VIDEO_QUESTION',
        actualReferenceTarget: 'NONE',
        expectedReferenceTarget: 'SHARED_REEL',
      },
    },
    {
      name: 'shared reel without accessible context',
      overrides: {
        intent: 'REEL_VIDEO_QUESTION',
        referenceTarget: 'SHARED_REEL',
        reelQuestionType: 'TRANSCRIPT_CONTENT',
        requiredEvidence: ['TRANSCRIPT'],
      },
      input: { hasSharedReelContext: false },
      type: 'SHARED_REEL_CONTEXT_UNAVAILABLE',
    },
    {
      name: 'conversation intent with shared-reel reference',
      overrides: {
        intent: 'CONVERSATION_MEMORY_QUESTION',
        referenceTarget: 'SHARED_REEL',
        reelQuestionType: 'NONE',
        requiredEvidence: ['CONVERSATION_MEMORY'],
      },
      input: { hasSharedReelContext: true },
      type: 'INTENT_REFERENCE_MISMATCH',
      details: {
        actualIntent: 'CONVERSATION_MEMORY_QUESTION',
        actualReferenceTarget: 'SHARED_REEL',
        expectedReferenceTarget: 'CONVERSATION',
      },
    },
    {
      name: 'reel intent with no reel question type',
      overrides: {
        intent: 'REEL_VIDEO_QUESTION',
        referenceTarget: 'SHARED_REEL',
        reelQuestionType: 'NONE',
        requiredEvidence: ['TRANSCRIPT'],
      },
      input: { hasSharedReelContext: true },
      type: 'INTENT_REEL_TYPE_MISMATCH',
      details: {
        actualIntent: 'REEL_VIDEO_QUESTION',
        actualReelQuestionType: 'NONE',
      },
    },
    {
      name: 'intent/reel-question-type mismatch',
      overrides: {
        intent: 'NORMAL_CHAT',
        referenceTarget: 'NONE',
        reelQuestionType: 'TRANSCRIPT_CONTENT',
        requiredEvidence: ['TRANSCRIPT'],
      },
      input: { hasSharedReelContext: true },
      type: 'INTENT_REEL_TYPE_MISMATCH',
      details: {
        actualIntent: 'NORMAL_CHAT',
        actualReelQuestionType: 'TRANSCRIPT_CONTENT',
        expectedReelQuestionType: 'NONE',
      },
    },
    {
      name: 'required-evidence mismatch',
      overrides: {
        intent: 'REEL_VIDEO_QUESTION',
        referenceTarget: 'SHARED_REEL',
        reelQuestionType: 'TRANSCRIPT_CONTENT',
        requiredEvidence: ['VISUAL'],
      },
      input: { hasSharedReelContext: true },
      type: 'REQUIRED_EVIDENCE_MISMATCH',
      details: {
        actualIntent: 'REEL_VIDEO_QUESTION',
        actualReelQuestionType: 'TRANSCRIPT_CONTENT',
        actualEvidence: ['VISUAL'],
        expectedEvidence: ['TRANSCRIPT'],
      },
    },
    {
      name: 'invalid recommendation action',
      overrides: {
        recommendationAction: {
          type: 'NOT_A_RECOMMENDATION',
          query: '',
          allowPersonalizedFallback: false,
          suggestedQueries: [],
        },
      },
      input: { hasSharedReelContext: true },
      type: 'INVALID_RECOMMENDATION_ACTION',
    },
    {
      name: 'recommendation action on non-normal intent',
      overrides: {
        intent: 'REEL_VIDEO_QUESTION',
        referenceTarget: 'SHARED_REEL',
        reelQuestionType: 'TRANSCRIPT_CONTENT',
        requiredEvidence: ['TRANSCRIPT'],
        recommendationAction: {
          type: 'RECOMMEND_REELS',
          query: 'sensitive query',
          allowPersonalizedFallback: false,
          suggestedQueries: [],
        },
      },
      input: { hasSharedReelContext: true },
      type: 'RECOMMENDATION_INTENT_MISMATCH',
      details: {
        actualIntent: 'REEL_VIDEO_QUESTION',
        recommendationActionType: 'RECOMMEND_REELS',
      },
    },
    {
      name: 'NONE recommendation with payload',
      overrides: {
        recommendationAction: {
          type: 'NONE',
          query: 'sensitive query',
          allowPersonalizedFallback: false,
          suggestedQueries: [],
        },
      },
      input: { hasSharedReelContext: true },
      type: 'RECOMMENDATION_PAYLOAD_MISMATCH',
      details: { recommendationActionType: 'NONE' },
    },
  ])(
    'reports a safe semantic inconsistency subtype for $name',
    async ({ overrides, input, type, details }) => {
      const secret =
        'untrusted-router-reason-sensitive-query-reel-123-request-id';
      const service = {
        generateObject: jest
          .fn()
          .mockResolvedValue(response({ ...overrides, reason: secret })),
      };

      let error: unknown;
      try {
        await new QueryRouterAgentUseCase(service as never, config).execute({
          message: 'A generic semantic request.',
          ...input,
        });
      } catch (caught) {
        error = caught;
      }

      expect(error).toMatchObject({
        code: 'ROUTER_UNAVAILABLE',
        causeCode: 'ROUTER_SEMANTIC_INCONSISTENT',
        semanticInconsistencyType: type,
        ...(details ? { semanticInconsistencyDetails: details } : {}),
      });
      expect(JSON.stringify(error)).not.toContain(secret);
      expect(JSON.stringify(error)).not.toContain('requestId');
      expect(JSON.stringify(error)).not.toContain('reel-123');
      expect(JSON.stringify(error)).not.toContain('sensitive query');
      expect(JSON.stringify(error)).not.toContain('reason');
      expect(service.generateObject).toHaveBeenCalledTimes(1);
    },
  );

  it('bounds direct query and history inputs before routing', async () => {
    const service = {
      generateObject: jest.fn().mockResolvedValue(response()),
    };

    await new QueryRouterAgentUseCase(service as never, config).execute({
      message: `question ${'x '.repeat(2_000)} query-tail`,
      recentHistory: `history ${'y '.repeat(2_000)} history-tail`,
    });

    const request = service.generateObject.mock.calls[0][0];
    expect(request.userPrompt.length).toBeLessThan(3_500);
    expect(request.userPrompt).not.toContain('query-tail');
    expect(request.userPrompt).not.toContain('history-tail');
  });
});
