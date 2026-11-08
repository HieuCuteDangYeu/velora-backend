import type { IAiApplicationConfig } from '@ai/domain/interfaces/ai-application-config.interface';
import type { RagChatWorkflowState } from '@ai/domain/interfaces/rag-chat-workflow.interface';
import {
  MULTI_REEL_TRANSCRIPT_COMPARISON_MAX_CHARS,
  TRANSCRIPT_SEGMENT_SUMMARY_MAX_CHARS,
} from '@ai/domain/services/rag-answer-contract';
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
      route: {
        intent: 'REEL_VIDEO_QUESTION',
        needsVerification: input.needsVerification ?? true,
        reelQuestionType: 'TRANSCRIPT_CONTENT',
        transcriptRequestKind: 'NONE',
        requiredEvidence: ['TRANSCRIPT'],
      },
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
    failureClass: 'NONE',
    issues: [],
    answerQualityPassed: true,
    answerQualityIssues: [],
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

  it('exactly verifies a fully source-matched extractive first-segment comparison without a provider', async () => {
    const firstText = 'Alice leaves the station after sunrise.';
    const secondText = 'Bob enters the courthouse before noon.';
    const firstClaim = `Episode One: ${firstText}`;
    const secondClaim = `Episode Two: ${secondText}`;
    const chunks = [
      {
        chunkId: 'chunk-one',
        reelId: 'reel-one',
        title: 'Episode One',
        evidenceType: 'TRANSCRIPT',
        startTime: 0,
        endTime: 10,
        evidenceText: firstText,
        chunkText: firstText,
        tags: [],
      },
      {
        chunkId: 'chunk-two',
        reelId: 'reel-two',
        title: 'Episode Two',
        evidenceType: 'TRANSCRIPT',
        startTime: 0,
        endTime: 10,
        evidenceText: secondText,
        chunkText: secondText,
        tags: [],
      },
    ];
    const comparisonState = {
      ...state({
        answer: `${firstClaim}\n\n${secondClaim}`,
        evidenceText: firstText,
      }),
      userMessage:
        'Compare the first indexed transcript segments of Episode One and Episode Two. Attribute each statement to its own clip.',
      route: {
        intent: 'REEL_VIDEO_QUESTION',
        needsVerification: true,
        reelQuestionType: 'TRANSCRIPT_CONTENT',
        requiredEvidence: ['TRANSCRIPT'],
      },
      retrievalPlan: {
        sourceOrder: 'ASC',
        searchLimit: 1,
        requiresReelCoverage: true,
        mode: 'REEL_HYBRID',
        query: 'Compare the first indexed transcript segments.',
        rerankLimit: 1,
        shouldRerank: false,
        reason: 'Use the earliest transcript from each Reel.',
      },
      accessibleReelIds: ['reel-one', 'reel-two'],
      retrievedChunks: chunks,
      rerankedChunks: chunks,
      contextSufficiency: {
        sufficient: true,
        confidence: 1,
        availableEvidence: ['TRANSCRIPT'],
        missingEvidence: [],
        supportedEvidenceIds: ['e0', 'e1'],
        reason: 'Both requested Reel transcripts are present.',
        recommendedAction: 'ANSWER',
      },
      answerGenerationMode: 'EXTRACTIVE_EVIDENCE_FALLBACK',
      answerClaims: [
        { claim: firstClaim, evidenceIds: ['e0'] },
        { claim: secondClaim, evidenceIds: ['e1'] },
      ],
      generationEvidence: [
        {
          evidenceId: 'e0',
          sourceId: 'chunk-one',
          reelId: 'reel-one',
          evidenceType: 'TRANSCRIPT',
          title: 'Episode One',
          startTime: 0,
          endTime: 10,
          evidenceText: firstText,
        },
        {
          evidenceId: 'e1',
          sourceId: 'chunk-two',
          reelId: 'reel-two',
          evidenceType: 'TRANSCRIPT',
          title: 'Episode Two',
          startTime: 0,
          endTime: 10,
          evidenceText: secondText,
        },
      ],
    } as unknown as RagChatWorkflowState;
    const service = { generateObject: jest.fn() };
    const useCase = new VerifierAgentUseCase(service as never, config);

    await expect(useCase.execute(comparisonState)).resolves.toMatchObject({
      passed: true,
      confidence: 1,
      answerQualityPassed: true,
      requiresRevision: false,
      supportedClaimMappings: [
        { claim: firstClaim, evidenceIds: ['e0'] },
        { claim: secondClaim, evidenceIds: ['e1'] },
      ],
      diagnostics: {
        providerStatus: 'NOT_CALLED',
        decisionSource: 'EXACT_PROVENANCE',
        finalPassed: true,
        exactProvenance: {
          supported: true,
          supportingEvidenceIndexes: [0, 1],
        },
      },
    });
    expect(service.generateObject).not.toHaveBeenCalled();

    await useCase.execute({
      ...comparisonState,
      answer: `${comparisonState.answer}\n\nAdditional unsupported claim.`,
    });
    expect(service.generateObject).toHaveBeenCalled();
  });

  it('repairs only unknown verifier IDs that match the generator claims and same authorized sources', async () => {
    const firstClaim = 'A person enters the room.';
    const secondClaim = 'The person says hello.';
    const answer = `${firstClaim} ${secondClaim}`;
    const input = {
      ...state({ answer, evidenceText: firstClaim }),
      userMessage: 'Summarize the two transcript statements.',
      route: {
        intent: 'REEL_VIDEO_QUESTION',
        needsVerification: true,
        reelQuestionType: 'TRANSCRIPT_CONTENT',
        requiredEvidence: ['TRANSCRIPT'],
      },
      rerankedChunks: [
        {
          chunkId: 'chunk-0',
          reelId: 'reel-1',
          evidenceType: 'TRANSCRIPT',
          evidenceText: firstClaim,
          chunkText: firstClaim,
          tags: [],
        },
        {
          chunkId: 'chunk-1',
          reelId: 'reel-1',
          evidenceType: 'TRANSCRIPT',
          evidenceText: secondClaim,
          chunkText: secondClaim,
          tags: [],
        },
      ],
      contextSufficiency: {
        sufficient: true,
        confidence: 1,
        availableEvidence: ['TRANSCRIPT'],
        missingEvidence: [],
        supportedEvidenceIds: ['e0', 'e1'],
        reason: 'Both transcript lines are present.',
        recommendedAction: 'ANSWER',
      },
      answerClaims: [
        { claim: firstClaim, evidenceIds: ['e0'] },
        { claim: secondClaim, evidenceIds: ['e1'] },
      ],
      generationEvidence: [
        {
          evidenceId: 'e0',
          sourceId: 'chunk-0',
          reelId: 'reel-1',
          evidenceType: 'TRANSCRIPT',
          evidenceText: firstClaim,
        },
        {
          evidenceId: 'e1',
          sourceId: 'chunk-1',
          reelId: 'reel-1',
          evidenceType: 'TRANSCRIPT',
          evidenceText: secondClaim,
        },
      ],
    } as unknown as RagChatWorkflowState;
    const service = {
      generateObject: jest.fn().mockResolvedValue(
        result({
          supportedClaimMappings: [
            { claim: firstClaim, evidenceIds: ['unknown-0'] },
            { claim: secondClaim, evidenceIds: ['unknown-1'] },
          ],
        }),
      ),
    };
    const useCase = new VerifierAgentUseCase(service as never, config);

    await expect(useCase.execute(input)).resolves.toMatchObject({
      passed: true,
      issues: [],
      supportedClaimMappings: [
        { claim: firstClaim, evidenceIds: ['e0'] },
        { claim: secondClaim, evidenceIds: ['e1'] },
      ],
      diagnostics: {
        decisionSource: 'LLM_PRIMARY',
        rawDecisionPassed: true,
        rawMappingCount: 2,
        trustedAnswerClaimIdRepairApplied: true,
      },
    });
    expect(service.generateObject).toHaveBeenCalledTimes(1);

    const noMappingService = {
      generateObject: jest
        .fn()
        .mockResolvedValue(result({ supportedClaimMappings: [] })),
    };
    const noMappingUseCase = new VerifierAgentUseCase(
      noMappingService as never,
      config,
    );
    await expect(noMappingUseCase.execute(input)).resolves.toMatchObject({
      passed: true,
      issues: [],
      supportedClaimMappings: [{ claim: answer, evidenceIds: ['e0', 'e1'] }],
      diagnostics: {
        decisionSource: 'EXACT_PROVENANCE',
        rawDecisionPassed: true,
        rawMappingCount: 0,
        trustedAnswerClaimIdRepairApplied: false,
      },
    });

    const noRepairService = {
      generateObject: jest.fn().mockResolvedValue(
        result({
          supportedClaimMappings: [
            { claim: firstClaim, evidenceIds: ['unknown-0'] },
            {
              claim: 'An unsupported extra statement.',
              evidenceIds: ['unknown-1'],
            },
          ],
        }),
      ),
    };
    const noEscalation = {
      ...config,
      boolean: jest.fn(() => false),
    } as unknown as IAiApplicationConfig;
    const failClosedUseCase = new VerifierAgentUseCase(
      noRepairService as never,
      noEscalation,
    );
    await expect(failClosedUseCase.execute(input)).resolves.toMatchObject({
      passed: false,
      issues: ['Verifier returned unknown evidence ID.'],
    });
  });

  it('uses complete generated source claims when a passing verifier omits claim mappings', async () => {
    const answer =
      'A man with gray hair and a black outfit is visible, wearing a silver cross necklace, a black coat, and a black shirt.';
    const evidenceText =
      'A man with gray hair and a black outfit, wearing a silver cross necklace. silver cross necklace black coat black shirt gray hair';
    const input = {
      ...state({ answer, evidenceText }),
      userMessage: 'Describe the visible details in the sampled frame.',
      route: {
        intent: 'REEL_VIDEO_QUESTION',
        needsVerification: true,
        reelQuestionType: 'VISUAL_CONTENT',
        requiredEvidence: ['VISUAL'],
      },
      rerankedChunks: [
        {
          chunkId: 'visual-source',
          reelId: 'reel-visual',
          title: 'Episode One',
          evidenceType: 'VISUAL',
          evidenceText,
          chunkText: evidenceText,
          tags: [],
        },
      ],
      contextSufficiency: {
        sufficient: true,
        confidence: 1,
        availableEvidence: ['VISUAL'],
        missingEvidence: [],
        supportedEvidenceIds: ['e0'],
        reason: 'Visual evidence is available.',
        recommendedAction: 'ANSWER',
      },
      answerClaims: [{ claim: answer, evidenceIds: ['e0'] }],
      generationEvidence: [
        {
          evidenceId: 'e0',
          sourceId: 'visual-source',
          reelId: 'reel-visual',
          evidenceType: 'VISUAL',
          evidenceText,
        },
      ],
    } as unknown as RagChatWorkflowState;
    const service = {
      generateObject: jest
        .fn()
        .mockResolvedValue(result({ supportedClaimMappings: [] })),
    };
    const useCase = new VerifierAgentUseCase(service as never, config);

    await expect(useCase.execute(input)).resolves.toMatchObject({
      passed: true,
      issues: [],
      supportedClaimMappings: [{ claim: answer, evidenceIds: ['e0'] }],
      diagnostics: {
        rawDecisionPassed: true,
        rawMappingCount: 0,
        trustedAnswerClaimIdRepairApplied: true,
      },
    });
  });

  it.each([
    "Sure, I'll send an email to your colleague.",
    "I've sent the email to your colleague.",
    'Your email has been sent.',
  ])(
    'fails closed when a task-action answer claims an unexecuted action',
    async (answer) => {
      const service = { generateObject: jest.fn() };
      const useCase = new VerifierAgentUseCase(service as never, config);
      const input = {
        ...state({ answer }),
        userMessage: 'Send an email to my colleague.',
        route: {
          intent: 'TASK_ACTION_REQUEST',
          needsVerification: true,
          requiredEvidence: ['NONE'],
          toolPlan: { allowedTools: [], requiredTools: [] },
        },
      } as unknown as RagChatWorkflowState;

      await expect(useCase.execute(input)).resolves.toMatchObject({
        passed: false,
        requiresRevision: true,
        diagnostics: {
          providerStatus: 'NOT_CALLED',
          decisionSource: 'FAIL_CLOSED',
          finalPassed: false,
          requiresRevision: true,
        },
      });
      expect(service.generateObject).not.toHaveBeenCalled();
    },
  );

  it.each([
    'I can’t send that email from here, so no email has been sent. Here’s a draft:\nSubject: Appointment confirmation\n\nYour appointment is scheduled as discussed.',
    'I’m unable to send emails, but you can compose a message like: “The reservation is confirmed.” Then send it through your email client.',
  ])(
    'semantically verifies an honest task-action limitation with a draft',
    async (answer) => {
      const service = {
        generateObject: jest
          .fn()
          .mockResolvedValue(result({ supportedClaimMappings: [] })),
      };
      const useCase = new VerifierAgentUseCase(service as never, config);
      const input = {
        ...state({ answer }),
        userMessage: 'Send an email to my colleague.',
        route: {
          intent: 'TASK_ACTION_REQUEST',
          needsVerification: true,
          requiredEvidence: ['NONE'],
          toolPlan: { allowedTools: [], requiredTools: [] },
        },
      } as unknown as RagChatWorkflowState;

      await expect(useCase.execute(input)).resolves.toMatchObject({
        passed: true,
        diagnostics: { providerStatus: 'SUCCESS' },
      });
      expect(service.generateObject).toHaveBeenCalledTimes(1);
    },
  );

  it('verifies a scoped conversation fact using memory evidence IDs', async () => {
    const service = {
      generateObject: jest.fn().mockResolvedValue(
        result({
          supportedClaimMappings: [
            { claim: 'Design review.', evidenceIds: ['m0'] },
          ],
        }),
      ),
    };
    const useCase = new VerifierAgentUseCase(service as never, config);
    const input = {
      ...state({ answer: 'Design review.' }),
      userId: 'alice',
      conversationId: 'current',
      userMessage: 'Which milestone did we agree on?',
      route: {
        intent: 'CONVERSATION_MEMORY_QUESTION',
        needsVerification: true,
        requiredEvidence: ['CONVERSATION_MEMORY'],
      },
      conversationMemory: {
        conversationId: 'current',
        summary: 'We agreed on design review.',
      },
    } as unknown as RagChatWorkflowState;
    await expect(useCase.execute(input)).resolves.toMatchObject({
      passed: true,
      supportedClaimMappings: [{ evidenceIds: ['m0'] }],
    });
    const prompt = JSON.parse(
      (service.generateObject.mock.calls[0][0] as GenerateStructuredObjectInput)
        .userPrompt,
    );
    expect(prompt.evidence).toContainEqual(
      expect.objectContaining({
        evidenceId: 'm0',
        evidenceType: 'CONVERSATION_MEMORY',
      }),
    );
  });

  it('repairs an unknown verifier ID from the exact scoped memory source', async () => {
    const memoryText = 'My preferred programming language is TypeScript.';
    const service = {
      generateObject: jest.fn().mockResolvedValue(
        result({
          supportedClaimMappings: [{ claim: memoryText, evidenceIds: ['e0'] }],
        }),
      ),
    };
    const useCase = new VerifierAgentUseCase(service as never, config);
    const input = {
      ...state({ answer: memoryText }),
      userId: 'alice',
      userMessage: 'What programming language do I currently prefer?',
      route: {
        intent: 'USER_MEMORY_QUESTION',
        needsVerification: true,
        requiredEvidence: ['USER_MEMORY'],
      },
      userMemories: {
        memories: [
          {
            id: 'memory-1',
            userId: 'alice',
            type: 'PREFERENCE',
            content: memoryText,
            confidence: 1,
          },
        ],
      },
      answerClaims: [{ claim: memoryText, evidenceIds: ['m0'] }],
      generationEvidence: [
        {
          evidenceId: 'm0',
          sourceId: 'user-memory:memory-1',
          evidenceType: 'USER_MEMORY',
          evidenceText: memoryText,
        },
      ],
    } as unknown as RagChatWorkflowState;

    await expect(useCase.execute(input)).resolves.toMatchObject({
      passed: true,
      supportedClaimMappings: [{ claim: memoryText, evidenceIds: ['m0'] }],
      diagnostics: { trustedAnswerClaimIdRepairApplied: true },
    });
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

  it('fails closed when the semantic verifier accepts the wrong directional quantity', async () => {
    const service = {
      generateObject: jest.fn().mockResolvedValue(
        result({
          supportedClaimMappings: [
            {
              claim: 'The number of bands can go as low as 2.',
              evidenceIds: ['e0'],
            },
          ],
        }),
      ),
    };
    const useCase = new VerifierAgentUseCase(service as never, config);
    const input = state({
      answer: 'The number of bands can go as low as 2.',
      evidenceText:
        'There are 2 controls on the panel. We can go down till like 12 bands and it is still okay.',
    });
    input.userMessage =
      'How low can the number of bands go while still being okay?';

    await expect(useCase.execute(input)).resolves.toMatchObject({
      passed: false,
      requiresRevision: true,
      issues: [
        'Answer model used a quantity unsupported by the requested relation',
      ],
    });
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
    };
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

  it('rejects an unsupported hallucinated claim even when it points at authorized evidence', async () => {
    const service = {
      generateObject: jest.fn().mockResolvedValue(
        result({
          passed: false,
          confidence: 0.91,
          requiresRevision: true,
          issues: ['The color claim is not supported by the transcript.'],
          supportedClaimMappings: [
            {
              claim: 'The zorb is linked to the quasar.',
              evidenceIds: ['e0'],
            },
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
      useCase.execute(
        state({
          answer: 'The zorb is linked to the quasar and glows green.',
          evidenceText: 'The zorb is linked to the quasar.',
        }),
      ),
    ).resolves.toMatchObject({
      passed: false,
      requiresRevision: true,
      issues: ['The color claim is not supported by the transcript.'],
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

  it('keeps grounding pass separate from a directness revision in trace diagnostics', async () => {
    const supportedClaim = 'The zorb is linked to the quasar.';
    const verboseAnswer = Array.from({ length: 40 }, () => supportedClaim).join(
      ' ',
    );
    const service = {
      generateObject: jest.fn().mockResolvedValue(
        result({
          supportedClaimMappings: [
            { claim: supportedClaim, evidenceIds: ['e0'] },
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
      useCase.execute(
        state({
          answer: verboseAnswer,
          evidenceText: supportedClaim,
        }),
      ),
    ).resolves.toMatchObject({
      passed: true,
      answerQualityPassed: false,
      requiresRevision: true,
      issues: [],
      answerQualityIssues: [expect.stringContaining('direct-answer budget')],
      revisedInstruction: expect.stringContaining('shortest complete answer'),
      supportedClaimMappings: [{ claim: supportedClaim, evidenceIds: ['e0'] }],
      diagnostics: {
        finalPassed: true,
        answerQualityPassed: false,
        answerQualityIssues: [expect.stringContaining('direct-answer budget')],
      },
    });
  });

  it('accepts independently mapped grounding when only answer quality failed', async () => {
    const claim = 'The zorb is linked to the quasar.';
    const input = state({ answer: claim, evidenceText: claim });
    input.rerankedChunks = [
      {
        chunkId: 'chunk-1',
        reelId: 'reel-1',
        evidenceType: 'TRANSCRIPT',
        evidenceText: claim,
        chunkText: claim,
        tags: [],
      },
    ];
    input.answerClaims = [{ claim, evidenceIds: ['e0'] }];
    input.generationEvidence = [
      {
        evidenceId: 'e0',
        sourceId: 'chunk-1',
        reelId: 'reel-1',
        evidenceType: 'TRANSCRIPT',
        evidenceText: claim,
      },
    ];
    const service = {
      generateObject: jest.fn().mockResolvedValue(
        result({
          passed: false,
          failureClass: 'ANSWER_QUALITY',
          issues: [],
          answerQualityPassed: false,
          answerQualityIssues: ['Paraphrase the direct source wording.'],
          requiresRevision: true,
          revisedInstruction: 'Paraphrase the direct source wording.',
          supportedClaimMappings: [{ claim, evidenceIds: ['e0'] }],
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

    const verification = await useCase.execute(input);
    const request = service.generateObject.mock.calls[0][0];

    expect(request.jsonSchema.required).toContain('supportedClaimMappings');
    expect(request.jsonSchema.required).toContain('failureClass');
    expect(request.jsonSchema.properties.supportedClaimMappings.minItems).toBe(
      0,
    );
    expect(verification).toMatchObject({
      passed: true,
      confidence: 0.95,
      answerQualityPassed: false,
      requiresRevision: true,
      supportedClaimMappings: [{ claim, evidenceIds: ['e0'] }],
      diagnostics: {
        finalPassed: true,
        rawDecisionPassed: false,
        failureClass: 'ANSWER_QUALITY',
        qualityOnlyGroundingAccepted: true,
      },
    });
  });

  it('keeps only verifier-approved mappings when a grounding claim fails', async () => {
    const supported = 'The zorb is linked to the quasar.';
    const unsupported = 'The zorb is red.';
    const input = state({
      answer: `${supported} ${unsupported}`,
      evidenceText: supported,
    });
    input.rerankedChunks = [
      {
        chunkId: 'chunk-1',
        reelId: 'reel-1',
        evidenceType: 'TRANSCRIPT',
        evidenceText: supported,
        chunkText: supported,
        tags: [],
      },
    ];
    input.answerClaims = [
      { claim: supported, evidenceIds: ['e0'] },
      { claim: unsupported, evidenceIds: ['e0'] },
    ];
    input.generationEvidence = [
      {
        evidenceId: 'e0',
        sourceId: 'chunk-1',
        reelId: 'reel-1',
        evidenceType: 'TRANSCRIPT',
        evidenceText: supported,
      },
    ];
    const service = {
      generateObject: jest.fn().mockResolvedValue(
        result({
          passed: false,
          failureClass: 'GROUNDING',
          issues: ['The evidence does not state that the zorb is red.'],
          answerQualityPassed: true,
          supportedClaimMappings: [
            { claim: supported, evidenceIds: ['e0'] },
          ],
        }),
      ),
    };
    const useCase = new VerifierAgentUseCase(service as never, {
      ...config,
      boolean: jest.fn(() => false),
    } as unknown as IAiApplicationConfig);

    await expect(useCase.execute(input)).resolves.toMatchObject({
      passed: false,
      supportedClaimMappings: [
        { claim: supported, evidenceIds: ['e0'] },
      ],
      diagnostics: { failureClass: 'GROUNDING' },
    });
    expect(
      service.generateObject.mock.calls[0][0].jsonSchema.properties
        .supportedClaimMappings.minItems,
    ).toBe(0);
    expect(service.generateObject.mock.calls[0][0].systemPrompt).toContain(
      'still include every supported claim in the mapping even when other claims fail',
    );
  });

  it('fails closed when a passing verifier omits factual claim mappings', async () => {
    const answer = 'The zorb is linked to an astronomical body.';
    const input = state({
      answer,
      evidenceText: 'A zorb is linked to a distant quasar.',
    });
    input.answerClaims = [{ claim: answer, evidenceIds: ['e0'] }];
    const service = {
      generateObject: jest.fn().mockResolvedValue(
        result({
          passed: true,
          supportedClaimMappings: [],
        }),
      ),
    };
    const useCase = new VerifierAgentUseCase(service as never, {
      ...config,
      boolean: jest.fn(() => false),
    } as unknown as IAiApplicationConfig);

    await expect(useCase.execute(input)).resolves.toMatchObject({
      passed: false,
      requiresRevision: true,
      issues: expect.arrayContaining([
        'Verifier omitted all supported answer claim mappings.',
      ]),
      diagnostics: { finalPassed: false },
    });
  });

  it('does not accept a style failure that also reports a grounding issue', async () => {
    const claim = 'The zorb is linked to the quasar.';
    const input = state({ answer: claim, evidenceText: claim });
    input.rerankedChunks = [
      {
        chunkId: 'chunk-1',
        reelId: 'reel-1',
        evidenceType: 'TRANSCRIPT',
        evidenceText: claim,
        chunkText: claim,
        tags: [],
      },
    ];
    input.answerClaims = [{ claim, evidenceIds: ['e0'] }];
    input.generationEvidence = [
      {
        evidenceId: 'e0',
        sourceId: 'chunk-1',
        reelId: 'reel-1',
        evidenceType: 'TRANSCRIPT',
        evidenceText: claim,
      },
    ];
    const service = {
      generateObject: jest.fn().mockResolvedValue(
        result({
          passed: false,
          failureClass: 'ANSWER_QUALITY',
          issues: ['A factual claim is unsupported.'],
          answerQualityPassed: false,
          answerQualityIssues: ['The answer is verbose.'],
          requiresRevision: true,
          supportedClaimMappings: [{ claim, evidenceIds: ['e0'] }],
        }),
      ),
    };
    const useCase = new VerifierAgentUseCase(
      service as never,
      {
        ...config,
        boolean: jest.fn(() => false),
      } as unknown as IAiApplicationConfig,
    );

    await expect(useCase.execute(input)).resolves.toMatchObject({
      passed: false,
      diagnostics: { qualityOnlyGroundingAccepted: false },
    });
  });

  it('uses the generation budget for complete first-segment comparison answers', async () => {
    const supportedClaim = 'The first segment is source-grounded.';
    const answer = `${supportedClaim} `.repeat(35).trim();
    const service = {
      generateObject: jest.fn().mockResolvedValue(
        result({
          supportedClaimMappings: [
            { claim: supportedClaim, evidenceIds: ['e0'] },
          ],
        }),
      ),
    };
    const noEscalationConfig = {
      ...config,
      boolean: jest.fn(() => false),
    };
    const useCase = new VerifierAgentUseCase(
      service as never,
      noEscalationConfig,
    );
    const input = state({ answer, evidenceText: supportedClaim });
    input.userMessage =
      'Compare the first indexed transcript segments of Episode One and Episode Two. Attribute each statement to its own clip.';
    input.retrievalPlan = { requiresReelCoverage: true } as never;
    input.rerankedChunks = [
      {
        chunkId: 'episode-one',
        reelId: 'episode-one',
        evidenceType: 'TRANSCRIPT',
        evidenceText: supportedClaim,
        chunkText: supportedClaim,
      },
      {
        chunkId: 'episode-two',
        reelId: 'episode-two',
        evidenceType: 'TRANSCRIPT',
        evidenceText: supportedClaim,
        chunkText: supportedClaim,
      },
    ] as never;
    input.retrievedChunks = input.rerankedChunks;

    await expect(useCase.execute(input)).resolves.toMatchObject({
      passed: true,
      answerQualityPassed: true,
      answerQualityIssues: [],
      requiresRevision: false,
    });
    expect(
      JSON.parse(String(service.generateObject.mock.calls[0][0].userPrompt)),
    ).toMatchObject({
      transcriptSegmentRequestKind: 'MULTI_REEL_COMPARISON',
      answerShape: 'SUMMARY',
      maxAnswerChars: MULTI_REEL_TRANSCRIPT_COMPARISON_MAX_CHARS,
    });
  });

  it('uses the expanded evidence budget for time-bounded summaries', async () => {
    const supportedClaim = 'The dog refuses to eat.';
    const answer = `${supportedClaim} `.repeat(30).trim();
    const service = {
      generateObject: jest.fn().mockResolvedValue(
        result({
          supportedClaimMappings: [
            { claim: supportedClaim, evidenceIds: ['e0'] },
          ],
        }),
      ),
    };
    const useCase = new VerifierAgentUseCase(service as never, {
      ...config,
      boolean: jest.fn(() => false),
    });
    const input = state({ answer, evidenceText: supportedClaim });
    input.userMessage =
      'Summarize what is said in the indexed transcript segment spanning 0–60 seconds.';
    input.retrievalPlan = {
      transcriptTimestampSec: 0,
      transcriptTimestampEndSec: 60,
    } as never;
    input.rerankedChunks = input.rerankedChunks.map((chunk) => ({
      ...chunk,
      startTime: 0,
      endTime: 60,
      evidenceText: `${supportedClaim} The guest is accepted into`,
      chunkText: `${supportedClaim} The guest is accepted into`,
    }));

    await expect(useCase.execute(input)).resolves.toMatchObject({
      passed: true,
      answerQualityPassed: true,
      answerQualityIssues: [],
      requiresRevision: false,
    });
    expect(
      JSON.parse(String(service.generateObject.mock.calls[0][0].userPrompt)),
    ).toMatchObject({
      transcriptSegmentRequestKind: 'SUMMARY',
      requestedTranscriptWindow: {
        startTime: 0,
        endTime: 60,
        exactRangeEvidenceIds: ['e0'],
        truncatedEvidenceIds: ['e0'],
      },
      answerShape: 'SUMMARY',
      maxAnswerChars: TRANSCRIPT_SEGMENT_SUMMARY_MAX_CHARS,
      answerQualityGuidance: expect.stringContaining(
        'one main point per sentence',
      ),
    });
    expect(service.generateObject.mock.calls[0][0].systemPrompt).toContain(
      'exactRangeEvidenceIds is nonempty',
    );
    expect(service.generateObject.mock.calls[0][0].systemPrompt).toContain(
      'read its complete excerpt before rejecting support',
    );
    expect(service.generateObject.mock.calls[0][0].systemPrompt).toContain(
      'Do not infer an unstated speaker, actor, recipient, target, or intent',
    );
  });

  it('checks multimodal summaries against section, timestamp, and visual-tag guidance', async () => {
    const service = {
      generateObject: jest.fn().mockResolvedValue(
        result({
          supportedClaimMappings: [
            { claim: 'Visible: A person waves.', evidenceIds: ['e1'] },
            { claim: 'Spoken: The dog refuses to eat.', evidenceIds: ['e0'] },
          ],
        }),
      ),
    };
    const useCase = new VerifierAgentUseCase(service as never, config);
    const input = state({
      answer: 'Visible: A person waves. Spoken: The dog refuses to eat.',
      evidenceText: 'The dog refuses to eat.',
    });
    input.userMessage =
      'Summarize what is said in the indexed transcript segment spanning 0–60 seconds and describe the sampled frame at 16 seconds.';
    input.route!.reelQuestionType = 'MULTIMODAL_CONTENT';
    input.route!.requiredEvidence = ['VISUAL', 'TRANSCRIPT'];
    input.rerankedChunks.push({
      ...input.rerankedChunks[0],
      evidenceType: 'VISUAL',
      evidenceText: 'A person waves.',
      chunkText: 'A person waves.',
    });
    input.retrievalPlan = {
      transcriptTimestampSec: 0,
      transcriptTimestampEndSec: 60,
    } as never;
    input.answerClaims = [
      { claim: 'Visible: A person waves.', evidenceIds: ['e1'] },
      { claim: 'Spoken: The dog refuses to eat.', evidenceIds: ['e0'] },
    ];

    await useCase.execute(input);

    const prompt = JSON.parse(
      String(service.generateObject.mock.calls[0][0].userPrompt),
    ) as { answerQualityGuidance: string };
    expect(prompt.answerQualityGuidance).toContain(
      'two sections labeled Visible and Spoken',
    );
    expect(prompt.answerQualityGuidance).toContain(
      'Do not repeat requested timestamps',
    );
    expect(prompt.answerQualityGuidance).toContain(
      'trailing keyword-only visual fragments',
    );
    expect(prompt.answerQualityGuidance).toContain(
      'cover the beginning, middle, and end in chronological order',
    );
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
          required: expect.not.arrayContaining(['contradictions']),
          properties: expect.objectContaining({
            issues: expect.objectContaining({ maxItems: 8 }),
            answerQualityIssues: expect.objectContaining({ maxItems: 4 }),
            contradictions: expect.objectContaining({ maxItems: 8 }),
            supportedClaimMappings: expect.objectContaining({ maxItems: 12 }),
          }),
        }),
      }),
    );
    expect(service.generateObject.mock.calls[0][0].systemPrompt).toContain(
      'Do not accept an answer merely because a claim points to an evidence ID',
    );
    expect(service.generateObject.mock.calls[0][0].systemPrompt).toContain(
      'answer quality separately from factual grounding',
    );
    expect(service.generateObject.mock.calls[0][0].userPrompt).toContain(
      '"answerShape":"EXPLANATION"',
    );
  });

  it('repairs an omitted verifier mapping only when the answer is an exact source span', async () => {
    const { supportedClaimMappings: _unused, ...raw } = result();
    void _unused;
    const service = { generateObject: jest.fn().mockResolvedValue(raw) };
    const useCase = new VerifierAgentUseCase(service as never, config);
    const answer = 'The zorb is linked to the quasar.';

    await expect(
      useCase.execute(
        state({
          answer,
          evidenceText: `Before. ${answer} After.`,
        }),
      ),
    ).resolves.toMatchObject({
      passed: true,
      supportedClaimMappings: [{ claim: answer, evidenceIds: ['e0'] }],
      diagnostics: {
        providerStatus: 'SUCCESS',
        decisionSource: 'EXACT_PROVENANCE',
      },
    });
    expect(
      service.generateObject.mock.calls[0][0].jsonSchema.required,
    ).not.toContain('supportedClaimMappings');
  });

  it('fails closed when an omitted verifier mapping has no exact source span', async () => {
    const { supportedClaimMappings: _unused, ...raw } = result();
    void _unused;
    const service = { generateObject: jest.fn().mockResolvedValue(raw) };
    const useCase = new VerifierAgentUseCase(service as never, config);

    await expect(
      useCase.execute(
        state({
          answer: 'The zorb caused the quasar.',
          evidenceText: 'The zorb is linked to the quasar.',
        }),
      ),
    ).resolves.toMatchObject({
      passed: false,
      requiresRevision: true,
      issues: [expect.stringContaining('unknown evidence ID')],
    });
  });

  it('keeps the full transcript segment available to the verifier', async () => {
    const segmentTail = 'The final turn changes the stated condition.';
    const input = state({
      evidenceText: `${'The speaker describes the plan. '.repeat(20)}${segmentTail}`,
    });
    input.userMessage = 'Summarize the speech transcript segment.';
    input.retrievalPlan = { sourceOrder: 'ASC' } as NonNullable<
      RagChatWorkflowState['retrievalPlan']
    >;
    const service = { generateObject: jest.fn().mockResolvedValue(result()) };
    const useCase = new VerifierAgentUseCase(service as never, config);

    await useCase.execute(input);

    const prompt = JSON.parse(
      String(service.generateObject.mock.calls[0][0].userPrompt),
    ) as { evidence: Array<{ evidenceText: string }> };
    expect(prompt.evidence[0].evidenceText).toContain(segmentTail);
  });

  it('treats an omitted contradictions list as empty', async () => {
    const raw = result();
    delete raw.contradictions;
    const service = { generateObject: jest.fn().mockResolvedValue(raw) };
    const useCase = new VerifierAgentUseCase(service as never, config);

    await expect(
      useCase.execute(
        state({ evidenceText: 'The zorb is linked to the quasar.' }),
      ),
    ).resolves.toMatchObject({
      passed: true,
      contradictions: [],
    });
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

  it('remaps an exact answer when the verifier uses an unbounded evidence index', async () => {
    const answer = 'The keys are on the kitchen table.';
    const service = {
      generateObject: jest.fn().mockResolvedValue(
        result({
          supportedClaimMappings: [
            { claim: answer, evidenceIds: ['e0', 'e6'] },
          ],
        }),
      ),
    };
    const rerankedChunks = Array.from({ length: 7 }, (_value, index) => ({
      chunkId: `chunk-${index}`,
      reelId: 'reel-1',
      evidenceType: 'TRANSCRIPT' as const,
      evidenceText: index === 0 ? answer : `Unrelated source window ${index}.`,
      chunkText: index === 0 ? answer : `Unrelated source window ${index}.`,
      tags: [],
    }));
    const useCase = new VerifierAgentUseCase(service as never, config);

    await expect(
      useCase.execute({
        ...state({ answer, evidenceText: answer }),
        userMessage: 'What did the speaker say about the keys?',
        rerankedChunks,
      } as unknown as RagChatWorkflowState),
    ).resolves.toMatchObject({
      passed: true,
      issues: [],
      supportedClaimMappings: [{ claim: answer, evidenceIds: ['e0'] }],
      diagnostics: { decisionSource: 'EXACT_PROVENANCE' },
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

  it('does not fast-pass a source-matched sentence when the verifier rejects first-sentence quality', async () => {
    const service = {
      generateObject: jest.fn().mockResolvedValue(
        result({
          passed: false,
          confidence: 1,
          issues: ['A short utterance is incomplete.'],
          answerQualityPassed: false,
          answerQualityIssues: ['The answer is too short.'],
          requiresRevision: true,
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
    const quoteState = {
      ...state({ answer: 'Ready!', evidenceText: 'Ready! We can start now.' }),
      userMessage:
        'Quote the first complete sentence in the indexed transcript.',
      route: {
        intent: 'REEL_VIDEO_QUESTION',
        needsVerification: true,
        reelQuestionType: 'TRANSCRIPT_CONTENT',
        transcriptRequestKind: 'FIRST_COMPLETE_UTTERANCE',
        requiredEvidence: ['TRANSCRIPT'],
      },
      rerankedChunks: [
        {
          chunkId: 'chunk-1',
          reelId: 'reel-1',
          evidenceType: 'TRANSCRIPT',
          evidenceText: 'Ready! We can start now.',
          chunkText: 'Ready! We can start now.',
          tags: [],
        },
      ],
      generationEvidence: [
        {
          evidenceId: 'e0',
          sourceId: 'chunk-1',
          reelId: 'reel-1',
          evidenceType: 'TRANSCRIPT',
          evidenceText: 'Ready! We can start now.',
        },
      ],
      answerClaims: [{ claim: 'Ready!', evidenceIds: ['e0'] }],
    } as unknown as RagChatWorkflowState;

    await expect(useCase.execute(quoteState)).resolves.toMatchObject({
      passed: false,
      confidence: 1,
      answerQualityPassed: false,
      requiresRevision: true,
      diagnostics: {
        decisionSource: 'LLM_PRIMARY',
        providerPassed: false,
        finalPassed: false,
      },
    });
    expect(service.generateObject).toHaveBeenCalledTimes(1);
    expect(service.generateObject.mock.calls[0][0].systemPrompt).toContain(
      'first-complete-sentence quote request',
    );
    expect(service.generateObject.mock.calls[0][0].systemPrompt).toContain(
      'Do not accept a later exact quote just because it appears in the transcript evidence',
    );
    expect(
      service.generateObject.mock.calls[0][0].jsonSchema.required,
    ).toContain('supportedClaimMappings');
    expect(
      service.generateObject.mock.calls[0][0].jsonSchema.properties
        .supportedClaimMappings.minItems,
    ).toBe(1);
  });

  it('accepts a verifier-approved transcript quote with an explicit transcript mapping', async () => {
    const answer = 'The courier arrived.';
    const service = {
      generateObject: jest.fn().mockResolvedValue(
        result({
          supportedClaimMappings: [{ claim: answer, evidenceIds: ['e0'] }],
        }),
      ),
    };
    const useCase = new VerifierAgentUseCase(service as never, config);
    const quoteState = {
      ...state({ answer, evidenceText: answer }),
      userMessage: 'Quote the first complete sentence in the transcript.',
      route: {
        intent: 'REEL_VIDEO_QUESTION',
        needsVerification: true,
        reelQuestionType: 'TRANSCRIPT_CONTENT',
        transcriptRequestKind: 'FIRST_COMPLETE_UTTERANCE',
        requiredEvidence: ['TRANSCRIPT'],
      },
      rerankedChunks: [
        {
          chunkId: 'chunk-1',
          reelId: 'reel-1',
          evidenceType: 'TRANSCRIPT',
          evidenceText: answer,
          chunkText: answer,
          startTime: 0,
          endTime: 5,
        },
      ],
      generationEvidence: [
        {
          evidenceId: 'e0',
          sourceId: 'chunk-1',
          reelId: 'reel-1',
          evidenceType: 'TRANSCRIPT',
          evidenceText: answer,
          startTime: 0,
          endTime: 5,
        },
      ],
      answerClaims: [{ claim: answer, evidenceIds: ['e0'] }],
    } as unknown as RagChatWorkflowState;

    await expect(useCase.execute(quoteState)).resolves.toMatchObject({
      passed: true,
      supportedClaimMappings: [{ claim: answer, evidenceIds: ['e0'] }],
      diagnostics: { decisionSource: 'LLM_PRIMARY' },
    });
  });

  it('keeps an exact first sentence from the supported timestamped source without asking the verifier to revise it', async () => {
    const answer = 'The visitor is waiting.';
    const evidenceText = 'The visitor is waiting. The family will arrive soon.';
    const service = { generateObject: jest.fn() };
    const useCase = new VerifierAgentUseCase(service as never, config);
    const quoteState = {
      ...state({ answer, evidenceText }),
      userMessage:
        'Quote the first complete sentence in the indexed transcript segment spanning 10–20 seconds.',
      route: {
        intent: 'REEL_VIDEO_QUESTION',
        needsVerification: true,
        reelQuestionType: 'TRANSCRIPT_CONTENT',
        transcriptRequestKind: 'FIRST_COMPLETE_UTTERANCE',
        requiredEvidence: ['TRANSCRIPT'],
      },
      retrievalPlan: {
        sourceTimestampSec: 10,
        sourceTimestampEndSec: 20,
        transcriptTimestampSec: 10,
        transcriptTimestampEndSec: 20,
      },
      contextSufficiency: {
        sufficient: true,
        supportedEvidenceIds: ['e0'],
      },
      rerankedChunks: [
        {
          chunkId: 'chunk-1',
          reelId: 'reel-1',
          evidenceType: 'TRANSCRIPT',
          evidenceText,
          chunkText: evidenceText,
          startTime: 10,
          endTime: 20,
          tags: [],
        },
      ],
      generationEvidence: [
        {
          evidenceId: 'e0',
          sourceId: 'chunk-1',
          reelId: 'reel-1',
          evidenceType: 'TRANSCRIPT',
          evidenceText,
          startTime: 10,
          endTime: 20,
        },
      ],
      answerClaims: [{ claim: answer, evidenceIds: ['e0'] }],
    } as unknown as RagChatWorkflowState;

    await expect(useCase.execute(quoteState)).resolves.toMatchObject({
      passed: true,
      confidence: 1,
      answerQualityPassed: true,
      requiresRevision: false,
      supportedClaimMappings: [{ claim: answer, evidenceIds: ['e0'] }],
      diagnostics: {
        providerStatus: 'NOT_CALLED',
        decisionSource: 'EXACT_PROVENANCE',
        exactProvenance: {
          supported: true,
          supportingEvidenceIndexes: [0],
        },
      },
    });
    expect(service.generateObject).not.toHaveBeenCalled();
  });

  it('does not use the source-sentence path for a paraphrase', async () => {
    const service = {
      generateObject: jest.fn().mockResolvedValue(
        result({
          passed: false,
          confidence: 1,
          issues: ['The answer is not a quote.'],
          answerQualityPassed: false,
          requiresRevision: true,
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
    const quoteState = {
      ...state({
        answer: 'The speaker is ready.',
        evidenceText: 'Ready! We can start now.',
      }),
      userMessage:
        'Quote the first complete sentence in the indexed transcript.',
      route: {
        intent: 'REEL_VIDEO_QUESTION',
        needsVerification: true,
        reelQuestionType: 'TRANSCRIPT_CONTENT',
        transcriptRequestKind: 'FIRST_COMPLETE_UTTERANCE',
        requiredEvidence: ['TRANSCRIPT'],
      },
      rerankedChunks: [
        {
          chunkId: 'chunk-1',
          reelId: 'reel-1',
          evidenceType: 'TRANSCRIPT',
          evidenceText: 'Ready! We can start now.',
          chunkText: 'Ready! We can start now.',
          tags: [],
        },
      ],
      generationEvidence: [
        {
          evidenceId: 'e0',
          sourceId: 'chunk-1',
          reelId: 'reel-1',
          evidenceType: 'TRANSCRIPT',
          evidenceText: 'Ready! We can start now.',
        },
      ],
      answerClaims: [{ claim: 'The speaker is ready.', evidenceIds: ['e0'] }],
    } as unknown as RagChatWorkflowState;

    await expect(useCase.execute(quoteState)).resolves.toMatchObject({
      passed: false,
      requiresRevision: true,
      diagnostics: { decisionSource: 'LLM_PRIMARY' },
    });
    expect(service.generateObject).toHaveBeenCalledTimes(1);
  });

  it('does not accept a later exact transcript sentence from provenance alone', async () => {
    const service = {
      generateObject: jest.fn().mockResolvedValue(
        result({
          passed: true,
          confidence: 0.95,
          issues: [],
          answerQualityPassed: true,
          answerQualityIssues: [],
          requiresRevision: false,
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
    const quoteState = {
      ...state({
        answer: 'The later sentence.',
        evidenceText: 'The first complete sentence. The later sentence.',
      }),
      userMessage:
        'Quote the first complete sentence in the indexed transcript segment spanning 10–20 seconds.',
      route: {
        intent: 'REEL_VIDEO_QUESTION',
        needsVerification: true,
        reelQuestionType: 'TRANSCRIPT_CONTENT',
        transcriptRequestKind: 'FIRST_COMPLETE_UTTERANCE',
        requiredEvidence: ['TRANSCRIPT'],
      },
      retrievalPlan: {
        transcriptTimestampSec: 10,
        transcriptTimestampEndSec: 20,
      },
      rerankedChunks: [
        {
          chunkId: 'chunk-1',
          reelId: 'reel-1',
          evidenceType: 'TRANSCRIPT',
          evidenceText: 'The first complete sentence. The later sentence.',
          chunkText: 'The first complete sentence. The later sentence.',
          startTime: 10,
          endTime: 20,
        },
      ],
      generationEvidence: [
        {
          evidenceId: 'e0',
          sourceId: 'chunk-1',
          reelId: 'reel-1',
          evidenceType: 'TRANSCRIPT',
          evidenceText: 'The first complete sentence. The later sentence.',
          startTime: 10,
          endTime: 20,
        },
      ],
      answerClaims: [{ claim: 'The later sentence.', evidenceIds: ['e0'] }],
    } as unknown as RagChatWorkflowState;

    await expect(useCase.execute(quoteState)).resolves.toMatchObject({
      passed: false,
      requiresRevision: true,
      diagnostics: {
        decisionSource: 'LLM_PRIMARY',
        exactProvenance: { supported: false },
      },
    });
    expect(service.generateObject).toHaveBeenCalledTimes(1);
    expect(service.generateObject.mock.calls[0][0].systemPrompt).toContain(
      'Do not accept a later exact quote just because it appears in the transcript evidence',
    );
  });

  it('passes punctuation-bounded sentence candidates to the verifier for timed first-sentence quotes', async () => {
    const answer = 'good!';
    const evidenceText = "good! Now, let's deal with the rest.";
    const service = {
      generateObject: jest.fn().mockResolvedValue(
        result({
          supportedClaimMappings: [{ claim: answer, evidenceIds: ['e0'] }],
        }),
      ),
    };
    const useCase = new VerifierAgentUseCase(service as never, config);
    const quoteState = {
      ...state({ answer, evidenceText }),
      userMessage:
        'Quote the first complete sentence in the indexed transcript segment spanning 10–20 seconds.',
      route: {
        intent: 'REEL_VIDEO_QUESTION',
        needsVerification: true,
        reelQuestionType: 'TRANSCRIPT_CONTENT',
        transcriptRequestKind: 'FIRST_COMPLETE_UTTERANCE',
        requiredEvidence: ['TRANSCRIPT'],
      },
      retrievalPlan: {
        sourceOrder: 'ASC',
        sourceTimestampSec: 10,
        sourceTimestampEndSec: 20,
        transcriptTimestampSec: 10,
        transcriptTimestampEndSec: 20,
      },
      rerankedChunks: [
        {
          chunkId: 'chunk-1',
          reelId: 'reel-1',
          evidenceType: 'TRANSCRIPT',
          evidenceText,
          chunkText: evidenceText,
          startTime: 10,
          endTime: 20,
          tags: [],
        },
      ],
      generationEvidence: [
        {
          evidenceId: 'e0',
          sourceId: 'chunk-1',
          reelId: 'reel-1',
          evidenceType: 'TRANSCRIPT',
          evidenceText,
          startTime: 10,
          endTime: 20,
        },
      ],
      answerClaims: [{ claim: answer, evidenceIds: ['e0'] }],
    } as unknown as RagChatWorkflowState;

    await expect(useCase.execute(quoteState)).resolves.toMatchObject({
      passed: true,
      supportedClaimMappings: [{ claim: answer, evidenceIds: ['e0'] }],
    });
    const request = service.generateObject.mock.calls[0][0];
    expect(JSON.parse(request.userPrompt).transcriptSentenceCandidates).toEqual(
      [
        {
          id: 's0',
          evidenceId: 'e0',
          text: 'good!',
          likelyIncompleteUtterance: false,
          continuesBeforeRequestedWindow: false,
        },
        {
          id: 's1',
          evidenceId: 'e0',
          text: "Now, let's deal with the rest.",
          likelyIncompleteUtterance: false,
          continuesBeforeRequestedWindow: false,
        },
      ],
    );
    expect(request.systemPrompt).toContain(
      'Do not merge adjacent candidates across punctuation',
    );
    expect(request.systemPrompt).toContain(
      'Candidate IDs such as s1 are internal span labels, never evidence IDs',
    );
  });

  it('requests a new quote when the selected span is a dangling auxiliary fragment', async () => {
    const answer = "I'll of a person.";
    const service = {
      generateObject: jest.fn().mockResolvedValue(
        result({
          supportedClaimMappings: [{ claim: answer, evidenceIds: ['e0'] }],
        }),
      ),
    };
    const useCase = new VerifierAgentUseCase(service as never, config);
    const input = state({
      answer,
      evidenceText: "I'll of a person. The meeting began.",
    });
    input.userMessage =
      'Quote the first complete sentence in the indexed transcript segment spanning 10–20 seconds.';
    input.route!.transcriptRequestKind = 'FIRST_COMPLETE_UTTERANCE';
    input.retrievalPlan = {
      transcriptTimestampSec: 10,
      transcriptTimestampEndSec: 20,
    } as never;
    input.rerankedChunks = input.rerankedChunks.map((chunk) => ({
      ...chunk,
      startTime: 10,
      endTime: 20,
    }));
    input.answerClaims = [{ claim: answer, evidenceIds: ['e0'] }];

    await expect(useCase.execute(input)).resolves.toMatchObject({
      passed: true,
      answerQualityPassed: false,
      requiresRevision: true,
      answerQualityIssues: [
        expect.stringContaining('structurally incomplete'),
      ],
    });
  });

  it('rejects an answer that completes the final clipped transcript fragment', async () => {
    const answer = 'They could conquer any nation and crush them.';
    const service = {
      generateObject: jest.fn().mockResolvedValue(
        result({
          supportedClaimMappings: [{ claim: answer, evidenceIds: ['e0'] }],
        }),
      ),
    };
    const useCase = new VerifierAgentUseCase(service as never, config);
    const input = state({
      answer,
      evidenceText: 'They could conquer any nation. Crush',
    });
    input.userMessage =
      'Summarize what is said in the indexed transcript segment spanning 0–60 seconds.';
    input.retrievalPlan = {
      sourceTimestampSec: 0,
      sourceTimestampEndSec: 60,
      transcriptTimestampSec: 0,
      transcriptTimestampEndSec: 60,
    } as never;
    input.rerankedChunks = input.rerankedChunks.map((chunk) => ({
      ...chunk,
      startTime: 0,
      endTime: 60,
    }));
    input.answerClaims = [{ claim: answer, evidenceIds: ['e0'] }];

    const verification = await useCase.execute(input);
    expect(verification).toMatchObject({
      passed: false,
      requiresRevision: true,
    });
    expect(verification.supportedClaimMappings).toEqual([]);
    expect(verification.diagnostics?.unsupportedClaimMappings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          claim: answer,
          reason: expect.stringContaining('incomplete transcript tail'),
        }),
      ]),
    );
    expect(verification.issues).toContain(
      'Answer completes an incomplete transcript tail beyond the supplied excerpt.',
    );
  });

  it('requests paraphrase when a transcript summary mostly reproduces its source', async () => {
    const evidenceText =
      'The speaker says they wanted to renovate the old house for many years. They thank the other person and describe how power could change the situation dramatically.';
    const answer = `The speaker says: ${evidenceText}`;
    const service = {
      generateObject: jest.fn().mockResolvedValue(
        result({
          supportedClaimMappings: [{ claim: answer, evidenceIds: ['e0'] }],
        }),
      ),
    };
    const useCase = new VerifierAgentUseCase(service as never, {
      ...config,
      boolean: jest.fn(() => false),
    });
    const input = state({ answer, evidenceText });
    input.userMessage =
      'Summarize what is said in the indexed transcript segment spanning 0–60 seconds.';
    input.retrievalPlan = {
      sourceTimestampSec: 0,
      sourceTimestampEndSec: 60,
      transcriptTimestampSec: 0,
      transcriptTimestampEndSec: 60,
    } as never;
    input.rerankedChunks = input.rerankedChunks.map((chunk) => ({
      ...chunk,
      startTime: 0,
      endTime: 60,
    }));
    input.answerClaims = [{ claim: answer, evidenceIds: ['e0'] }];

    await expect(useCase.execute(input)).resolves.toMatchObject({
      passed: true,
      answerQualityPassed: false,
      requiresRevision: true,
      answerQualityIssues: [
        expect.stringContaining('reproduces most of the transcript wording'),
      ],
    });
  });

  it('scopes timed quote verification to the selected transcript and only includes necessary boundary context', async () => {
    const service = {
      generateObject: jest
        .fn()
        .mockResolvedValueOnce(
          result({
            supportedClaimMappings: [
              { claim: 'Get away from me.', evidenceIds: ['e1'] },
            ],
          }),
        )
        .mockResolvedValueOnce(
          result({
            supportedClaimMappings: [
              { claim: 'The meeting began.', evidenceIds: ['e1'] },
            ],
          }),
        ),
    };
    const useCase = new VerifierAgentUseCase(service as never, config);
    const quoteState = (
      answer: string,
      earlierText: string,
      selectedText: string,
    ) =>
      ({
        ...state({ answer, evidenceText: selectedText }),
        userMessage:
          'Quote the first complete sentence in the indexed transcript segment spanning 9.52–62.28 seconds.',
        route: {
          intent: 'REEL_VIDEO_QUESTION',
          needsVerification: true,
          reelQuestionType: 'TRANSCRIPT_CONTENT',
          transcriptRequestKind: 'FIRST_COMPLETE_UTTERANCE',
          requiredEvidence: ['TRANSCRIPT'],
        },
        retrievalPlan: {
          transcriptTimestampSec: 9.52,
          transcriptTimestampEndSec: 62.28,
        },
        rerankedChunks: [
          {
            chunkId: 'chunk-before',
            reelId: 'reel-1',
            evidenceType: 'TRANSCRIPT',
            evidenceText: earlierText,
            chunkText: earlierText,
            startTime: 0,
            endTime: 10,
          },
          {
            chunkId: 'chunk-selected',
            reelId: 'reel-1',
            evidenceType: 'TRANSCRIPT',
            evidenceText: selectedText,
            chunkText: selectedText,
            startTime: 9.52,
            endTime: 62.28,
          },
        ],
        generationEvidence: [
          {
            evidenceId: 'e1',
            sourceId: 'chunk-selected',
            reelId: 'reel-1',
            evidenceType: 'TRANSCRIPT',
            evidenceText: selectedText,
            startTime: 9.52,
            endTime: 62.28,
          },
        ],
        answerClaims: [{ claim: answer, evidenceIds: ['e1'] }],
      }) as unknown as RagChatWorkflowState;

    await expect(
      useCase.execute(
        quoteState(
          'Get away from me.',
          'The lights go out. Get away from me.',
          'Get away from me. Who are you?',
        ),
      ),
    ).resolves.toMatchObject({ passed: true });
    const outsideUtterancePrompt = JSON.parse(
      service.generateObject.mock.calls[0][0].userPrompt,
    ) as { evidence: Array<Record<string, unknown>> };
    expect(outsideUtterancePrompt.evidence).toHaveLength(1);
    expect(outsideUtterancePrompt.evidence[0]).toMatchObject({
      evidenceId: 'e1',
      evidenceText: 'Get away from me. Who are you?',
    });
    expect(JSON.stringify(outsideUtterancePrompt.evidence)).not.toContain(
      'The lights go out.',
    );

    await expect(
      useCase.execute(
        quoteState(
          'The meeting began.',
          'The visitor came inside. The meeting began.',
          'inside. The meeting began.',
        ),
      ),
    ).resolves.toMatchObject({ passed: true });
    const continuationPrompt = JSON.parse(
      service.generateObject.mock.calls[1][0].userPrompt,
    ) as { evidence: Array<Record<string, unknown>> };
    expect(continuationPrompt.evidence).toHaveLength(2);
    expect(continuationPrompt.evidence[0]).toMatchObject({
      contextOnlyTranscript: 'The visitor came inside. The meeting began.',
    });
    expect(continuationPrompt.evidence[0]).not.toHaveProperty('evidenceId');
    expect(continuationPrompt.evidence[1]).toMatchObject({ evidenceId: 'e1' });
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
