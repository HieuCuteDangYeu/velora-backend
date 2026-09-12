import type { IAiApplicationConfig } from '@ai/domain/interfaces/ai-application-config.interface';
import type { RagChatWorkflowState } from '@ai/domain/interfaces/rag-chat-workflow.interface';
import type { GenerateStructuredObjectInput } from '@ai/domain/interfaces/structured-llm.service.interface';
import { VerifierAgentUseCase } from './verifier-agent.use-case';

describe('VerifierAgentUseCase', () => {
  const config = {
    model: jest.fn((role: string) =>
      role === 'VERIFIER'
        ? 'test/openai/gpt-oss-20b'
        : 'test/openai/gpt-oss-120b',
    ),
    timeoutMs: jest.fn(() => 8_000),
    maxCompletionTokens: jest.fn(() => 1_024),
    boolean: jest.fn(() => true),
    number: jest.fn((key: string) =>
      key === 'AI_VERIFIER_MAX_ATTEMPTS' ? 2 : 0.8,
    ),
  } as unknown as IAiApplicationConfig;

  const state = (input: {
    answer?: string;
    evidenceText?: string;
    needsVerification?: boolean;
    retryCount?: number;
  }): RagChatWorkflowState =>
    ({
      userMessage: 'Which novel relation is explicitly asserted?',
      answer: input.answer ?? 'The zorb is linked to the quasar.',
      route: { needsVerification: input.needsVerification ?? true },
      rerankedChunks: input.evidenceText
        ? [
            {
              evidenceType: 'TRANSCRIPT',
              evidenceText: input.evidenceText,
              chunkText: input.evidenceText,
              tags: [],
            },
          ]
        : [],
      retryCount: input.retryCount ?? 0,
      citationRetryCount: 0,
    }) as unknown as RagChatWorkflowState;

  const result = (overrides: Record<string, unknown> = {}) => ({
    passed: true,
    confidence: 0.95,
    issues: [],
    requiresRevision: false,
    revisedInstruction: '',
    contradictions: [],
    supportedClaimMappings: [
      { claim: 'The zorb is linked to the quasar.', evidenceIds: ['e0'] },
    ],
    ...overrides,
  });

  it('does not call the provider when verification is not required', async () => {
    const service = { generateObject: jest.fn() };
    const useCase = new VerifierAgentUseCase(service as never, config);

    await expect(
      useCase.execute(state({ needsVerification: false })),
    ).resolves.toMatchObject({
      passed: true,
      diagnostics: {
        providerStatus: 'NOT_CALLED',
        decisionSource: 'NOT_REQUIRED',
      },
    });
    expect(service.generateObject).not.toHaveBeenCalled();
  });

  it('accepts a supported semantic decision from the primary verifier', async () => {
    const service = { generateObject: jest.fn().mockResolvedValue(result()) };
    const useCase = new VerifierAgentUseCase(service as never, config);

    await expect(
      useCase.execute(
        state({ evidenceText: 'The zorb is linked to the quasar.' }),
      ),
    ).resolves.toMatchObject({
      passed: true,
      confidence: 0.95,
      supportedClaimMappings: [
        { claim: 'The zorb is linked to the quasar.', evidenceIds: ['e0'] },
      ],
      diagnostics: {
        decisionSource: 'LLM_PRIMARY',
        modelRole: 'VERIFIER',
        escalated: false,
        supportedClaimMappings: [
          { claim: 'The zorb is linked to the quasar.', evidenceIds: ['e0'] },
        ],
      },
    });
    expect(service.generateObject).toHaveBeenCalledWith(
      expect.objectContaining({
        model: 'test/openai/gpt-oss-20b',
        maxTokens: 1_024,
        timeoutMs: 8_000,
        temperature: 0,
      }),
    );
  });

  it('persists safe primary verifier call diagnostics', async () => {
    const service = {
      generateObject: jest
        .fn()
        .mockImplementation((input: GenerateStructuredObjectInput) => {
          input.onDiagnostics?.({
            modelRole: 'VERIFIER',
            model: 'test/openai/gpt-oss-120b',
            providerStatus: 200,
            latencyMs: 42,
            configuredTimeoutMs: 8_000,
            configuredMaxCompletionTokens: 1_024,
            attempt: 1,
            usage: { inputTokens: 10, outputTokens: 4, totalTokens: 14 },
            requestId: 'must-not-persist',
          });
          return Promise.resolve(result());
        }),
    };

    const verification = await new VerifierAgentUseCase(
      service as never,
      config,
    ).execute(state({ evidenceText: 'The zorb is linked to the quasar.' }));

    expect(verification.diagnostics?.semanticCalls).toEqual([
      expect.objectContaining({
        modelRole: 'VERIFIER',
        model: 'test/openai/gpt-oss-120b',
        providerStatus: 200,
        latencyMs: 42,
        usage: { inputTokens: 10, outputTokens: 4, totalTokens: 14 },
      }),
    ]);
    expect(JSON.stringify(verification)).not.toContain('must-not-persist');
  });

  it('persists safe diagnostics when verifier provider execution fails', async () => {
    const service = {
      generateObject: jest
        .fn()
        .mockImplementation((input: GenerateStructuredObjectInput) => {
          input.onDiagnostics?.({
            modelRole: 'VERIFIER',
            model: 'test/openai/gpt-oss-120b',
            providerStatus: 503,
            latencyMs: 25,
            configuredTimeoutMs: 8_000,
            configuredMaxCompletionTokens: 1_024,
            attempt: 1,
            errorCode: 'STRUCTURED_COMPLETION_PROVIDER_ERROR',
            providerCategory: 'TRANSIENT_PROVIDER_FAILURE',
          });
          return Promise.reject(new Error('provider unavailable'));
        }),
    };

    const noEscalationConfig: IAiApplicationConfig = {
      ...config,
      boolean: jest.fn(() => false),
    };
    const verification = await new VerifierAgentUseCase(
      service as never,
      noEscalationConfig,
    ).execute(state({ evidenceText: 'Potential evidence.' }));

    expect(verification).toMatchObject({
      passed: false,
      diagnostics: {
        providerStatus: 'ERROR',
        decisionSource: 'FAIL_CLOSED',
        semanticCalls: [
          expect.objectContaining({
            providerStatus: 503,
            errorCode: 'STRUCTURED_COMPLETION_PROVIDER_ERROR',
            providerCategory: 'TRANSIENT_PROVIDER_FAILURE',
          }),
        ],
      },
    });
  });

  it('escalates exactly once after a primary semantic rejection', async () => {
    const service = {
      generateObject: jest
        .fn()
        .mockResolvedValueOnce(
          result({
            passed: false,
            confidence: 0.9,
            requiresRevision: true,
            issues: ['Unsupported relation.'],
            supportedClaimMappings: [],
          }),
        )
        .mockResolvedValueOnce(result()),
    };
    const useCase = new VerifierAgentUseCase(service as never, config);

    await expect(
      useCase.execute(
        state({ evidenceText: 'The zorb is linked to the quasar.' }),
      ),
    ).resolves.toMatchObject({
      passed: true,
      diagnostics: {
        decisionSource: 'LLM_ESCALATION',
        modelRole: 'VERIFIER_ESCALATION',
        escalated: true,
        escalationReason: 'PRIMARY_REJECTED',
      },
    });
    expect(service.generateObject).toHaveBeenCalledTimes(2);
    expect(service.generateObject.mock.calls[0][0]).toEqual(
      expect.objectContaining({
        model: 'test/openai/gpt-oss-20b',
        maxTokens: 1_024,
      }),
    );
    expect(service.generateObject.mock.calls[1][0]).toEqual(
      expect.objectContaining({
        model: 'test/openai/gpt-oss-120b',
        maxTokens: 1_024,
      }),
    );
  });

  it('escalates exactly once after a transient primary provider failure', async () => {
    const timeout = Object.assign(new Error('primary timeout'), {
      code: 'STRUCTURED_COMPLETION_TIMEOUT',
    });
    const service = {
      generateObject: jest
        .fn()
        .mockRejectedValueOnce(timeout)
        .mockResolvedValueOnce(result()),
    };

    await expect(
      new VerifierAgentUseCase(service as never, config).execute(
        state({ evidenceText: 'The zorb is linked to the quasar.' }),
      ),
    ).resolves.toMatchObject({
      passed: true,
      diagnostics: {
        modelRole: 'VERIFIER_ESCALATION',
        escalationReason: 'PRIMARY_PROVIDER_FAILURE',
        escalated: true,
      },
    });
    expect(service.generateObject).toHaveBeenCalledTimes(2);
  });

  it('does not escalate a non-transient account-limited provider failure', async () => {
    const limited = Object.assign(new Error('account limited'), {
      code: 'STRUCTURED_COMPLETION_PROVIDER_ERROR',
      transient: false,
      providerCode: 3036,
    });
    const service = { generateObject: jest.fn().mockRejectedValue(limited) };

    await expect(
      new VerifierAgentUseCase(service as never, config).execute(
        state({ evidenceText: 'Potential evidence.' }),
      ),
    ).resolves.toMatchObject({
      passed: false,
      diagnostics: { decisionSource: 'FAIL_CLOSED' },
    });
    expect(service.generateObject).toHaveBeenCalledTimes(1);
  });

  it('does not escalate deterministic completion truncation', async () => {
    const truncated = Object.assign(
      new Error('structured completion truncated'),
      { code: 'STRUCTURED_COMPLETION_TRUNCATED' },
    );
    const service = { generateObject: jest.fn().mockRejectedValue(truncated) };

    await expect(
      new VerifierAgentUseCase(service as never, config).execute(
        state({ evidenceText: 'Potential evidence.' }),
      ),
    ).resolves.toMatchObject({
      passed: false,
      diagnostics: { decisionSource: 'FAIL_CLOSED' },
    });
    expect(service.generateObject).toHaveBeenCalledTimes(1);
  });

  it('escalates a low-confidence primary acceptance', async () => {
    const service = {
      generateObject: jest
        .fn()
        .mockResolvedValueOnce(result({ confidence: 0.79 }))
        .mockResolvedValueOnce(result()),
    };
    const useCase = new VerifierAgentUseCase(service as never, config);

    await expect(
      useCase.execute(
        state({ evidenceText: 'The zorb is linked to the quasar.' }),
      ),
    ).resolves.toMatchObject({
      diagnostics: {
        modelRole: 'VERIFIER_ESCALATION',
        escalationReason: 'LOW_CONFIDENCE',
      },
    });
    expect(service.generateObject).toHaveBeenCalledTimes(2);
  });

  it('escalates a revised answer even when the primary accepts it', async () => {
    const service = { generateObject: jest.fn().mockResolvedValue(result()) };
    const useCase = new VerifierAgentUseCase(service as never, config);

    await expect(
      useCase.execute(
        state({
          evidenceText: 'The zorb is linked to the quasar.',
          retryCount: 1,
        }),
      ),
    ).resolves.toMatchObject({
      diagnostics: {
        modelRole: 'VERIFIER_ESCALATION',
        escalationReason: 'REVISED_ANSWER',
      },
    });
    expect(service.generateObject).toHaveBeenCalledTimes(2);
  });

  it('fails a purported pass that reports a contradiction', async () => {
    const service = {
      generateObject: jest.fn().mockResolvedValue(
        result({
          passed: true,
          contradictions: ['The evidence asserts the opposite relation.'],
        }),
      ),
    };
    const noEscalationConfig = {
      ...config,
      boolean: jest.fn(() => false),
    } as unknown as IAiApplicationConfig;
    const useCase = new VerifierAgentUseCase(
      service as never,
      noEscalationConfig,
    );

    await expect(
      useCase.execute(state({ evidenceText: 'Authorized evidence.' })),
    ).resolves.toMatchObject({
      passed: false,
      issues: ['The evidence asserts the opposite relation.'],
    });
  });

  it('preserves a wrong-modality rejection', async () => {
    const service = {
      generateObject: jest.fn().mockResolvedValue(
        result({
          passed: false,
          issues: [
            'The visual claim is supported only by transcript evidence.',
          ],
          supportedClaimMappings: [],
        }),
      ),
    };
    const noEscalationConfig = {
      ...config,
      boolean: jest.fn(() => false),
    } as unknown as IAiApplicationConfig;
    const useCase = new VerifierAgentUseCase(
      service as never,
      noEscalationConfig,
    );

    await expect(
      useCase.execute(state({ evidenceText: 'Transcript-only evidence.' })),
    ).resolves.toMatchObject({
      passed: false,
      issues: ['The visual claim is supported only by transcript evidence.'],
    });
  });

  it('sends a bounded compact output schema', async () => {
    const service = { generateObject: jest.fn().mockResolvedValue(result()) };
    const useCase = new VerifierAgentUseCase(service as never, config);

    await useCase.execute(
      state({ evidenceText: 'The zorb is linked to the quasar.' }),
    );

    expect(service.generateObject).toHaveBeenCalledWith(
      expect.objectContaining({
        jsonSchema: expect.objectContaining({
          properties: expect.objectContaining({
            issues: expect.objectContaining({ maxItems: 8 }),
            contradictions: expect.objectContaining({ maxItems: 8 }),
            supportedClaimMappings: expect.objectContaining({ maxItems: 12 }),
          }),
        }),
      }),
    );
    expect(service.generateObject.mock.calls[0][0].systemPrompt).toContain(
      'Do not accept an answer merely because a claim points to an evidence ID',
    );
  });

  it('rejects provider mappings to evidence IDs that were not supplied', async () => {
    const service = {
      generateObject: jest.fn().mockResolvedValue(
        result({
          supportedClaimMappings: [
            { claim: 'Invented mapping.', evidenceIds: ['e99'] },
          ],
        }),
      ),
    };
    const noEscalationConfig = {
      ...config,
      boolean: jest.fn(() => false),
    } as unknown as IAiApplicationConfig;
    const useCase = new VerifierAgentUseCase(
      service as never,
      noEscalationConfig,
    );

    await expect(
      useCase.execute(state({ evidenceText: 'Authorized evidence.' })),
    ).resolves.toMatchObject({
      passed: false,
      issues: ['Verifier returned unknown evidence ID.'],
    });
  });

  it('preserves valid mappings while failing closed on a mixed unknown mapping', async () => {
    const service = {
      generateObject: jest.fn().mockResolvedValue(
        result({
          supportedClaimMappings: [
            { claim: 'Authorized mapping.', evidenceIds: ['e0'] },
            { claim: 'Invalid mapping.', evidenceIds: ['e99'] },
          ],
        }),
      ),
    };
    const noEscalationConfig = {
      ...config,
      boolean: jest.fn(() => false),
    } as unknown as IAiApplicationConfig;
    const useCase = new VerifierAgentUseCase(
      service as never,
      noEscalationConfig,
    );

    await expect(
      useCase.execute(state({ evidenceText: 'Authorized evidence.' })),
    ).resolves.toMatchObject({
      passed: false,
      supportedClaimMappings: [
        { claim: 'Authorized mapping.', evidenceIds: ['e0'] },
        { claim: 'Invalid mapping.', evidenceIds: [] },
      ],
      issues: ['Verifier returned unknown evidence ID.'],
    });
  });

  it('does not let exact overlap override a semantic rejection', async () => {
    const service = {
      generateObject: jest.fn().mockResolvedValue(
        result({
          passed: false,
          confidence: 1,
          requiresRevision: true,
          issues: ['The answer targets the wrong relation.'],
          supportedClaimMappings: [],
        }),
      ),
    };
    const noEscalationConfig = {
      ...config,
      boolean: jest.fn(() => false),
    } as unknown as IAiApplicationConfig;
    const useCase = new VerifierAgentUseCase(
      service as never,
      noEscalationConfig,
    );

    await expect(
      useCase.execute(
        state({
          answer: 'The zorb is linked to the quasar.',
          evidenceText: 'The zorb is linked to the quasar.',
        }),
      ),
    ).resolves.toMatchObject({
      passed: false,
      requiresRevision: true,
      diagnostics: { decisionSource: 'LLM_PRIMARY' },
    });
  });

  it('uses exact contiguous provenance only when the semantic provider fails', async () => {
    const service = {
      generateObject: jest.fn().mockRejectedValue(new Error('provider down')),
    };
    const useCase = new VerifierAgentUseCase(service as never, config);

    await expect(
      useCase.execute(
        state({
          answer: 'The zorb is linked to the quasar.',
          evidenceText: 'Before. The zorb is linked to the quasar. After.',
        }),
      ),
    ).resolves.toMatchObject({
      passed: true,
      diagnostics: { decisionSource: 'EXACT_PROVENANCE' },
    });
  });

  it('preserves exact ordered-source claims when the semantic provider fails', async () => {
    const service = {
      generateObject: jest.fn().mockRejectedValue(new Error('provider down')),
    };
    const useCase = new VerifierAgentUseCase(service as never, config);
    const answer = 'The first source window. The second source window.';

    await expect(
      useCase.execute({
        ...state({ answer, evidenceText: 'The first source window.' }),
        answerClaims: [{ claim: answer, evidenceIds: ['e0', 'e1'] }],
        rerankedChunks: [
          {
            evidenceType: 'TRANSCRIPT',
            evidenceText: 'The first source window.',
            chunkText: 'The first source window.',
            tags: [],
          },
          {
            evidenceType: 'TRANSCRIPT',
            evidenceText: 'The second source window.',
            chunkText: 'The second source window.',
            tags: [],
          },
        ],
      } as unknown as RagChatWorkflowState),
    ).resolves.toMatchObject({
      passed: true,
      diagnostics: { decisionSource: 'EXACT_PROVENANCE' },
      supportedClaimMappings: [{ claim: answer, evidenceIds: ['e0', 'e1'] }],
    });
  });

  it('fails closed on provider error without exact provenance', async () => {
    const service = {
      generateObject: jest.fn().mockRejectedValue(new Error('provider down')),
    };
    const useCase = new VerifierAgentUseCase(service as never, config);

    await expect(
      useCase.execute(
        state({
          answer: 'An unsupported semantic answer.',
          evidenceText: 'Different evidence.',
        }),
      ),
    ).resolves.toMatchObject({
      passed: false,
      confidence: 0,
      issues: ['Required semantic answer verification was unavailable.'],
      diagnostics: { decisionSource: 'FAIL_CLOSED' },
    });
  });
});
