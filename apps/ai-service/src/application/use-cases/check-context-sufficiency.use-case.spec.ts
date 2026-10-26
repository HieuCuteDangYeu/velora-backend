import type { IAiApplicationConfig } from '@ai/domain/interfaces/ai-application-config.interface';
import type { RagChatWorkflowState } from '@ai/domain/interfaces/rag-chat-workflow.interface';
import { CheckContextSufficiencyUseCase } from './check-context-sufficiency.use-case';

describe('CheckContextSufficiencyUseCase', () => {
  const config = {
    get: jest.fn(),
    model: jest.fn(() => 'test/test/sufficiency'),
    timeoutMs: jest.fn(() => 6_000),
    maxCompletionTokens: jest.fn(() => 512),
  } as unknown as IAiApplicationConfig;

  const state = (input: {
    requiredEvidence?: Array<'TRANSCRIPT' | 'VISUAL' | 'AUDIO' | 'METADATA'>;
    evidenceType?: 'TRANSCRIPT' | 'VISUAL' | 'METADATA';
    evidenceText?: string;
  }): RagChatWorkflowState =>
    ({
      userMessage: 'What semantic relation is asserted?',
      route: {
        needsRetrieval: true,
        requiredEvidence: input.requiredEvidence ?? ['TRANSCRIPT'],
      },
      rerankedChunks: input.evidenceText
        ? [
            {
              evidenceType: input.evidenceType ?? 'TRANSCRIPT',
              evidenceText: input.evidenceText,
              chunkText: input.evidenceText,
              tags: [],
            },
          ]
        : [],
    }) as unknown as RagChatWorkflowState;

  it('refuses deterministically when no evidence exists', async () => {
    const service = { generateObject: jest.fn() };
    const useCase = new CheckContextSufficiencyUseCase(
      service as never,
      config,
    );

    await expect(useCase.execute(state({}))).resolves.toMatchObject({
      sufficient: false,
      missingEvidence: ['TRANSCRIPT'],
      supportedEvidenceIds: [],
      recommendedAction: 'REFUSE_NO_CONTEXT',
      diagnostics: { decisionSource: 'DETERMINISTIC_NO_CONTEXT' },
    });
    expect(service.generateObject).not.toHaveBeenCalled();
  });

  it('refuses a comparison when reranking drops one retrieved Reel', async () => {
    const service = { generateObject: jest.fn() };
    const useCase = new CheckContextSufficiencyUseCase(
      service as never,
      config,
    );
    const comparisonState = {
      userMessage: 'Compare both shared Reels.',
      route: {
        intent: 'REEL_VIDEO_QUESTION',
        reelQuestionType: 'TRANSCRIPT_CONTENT',
        needsRetrieval: true,
        requiredEvidence: ['TRANSCRIPT'],
      },
      retrievalPlan: { requiresReelCoverage: true },
      retrievedChunks: [
        { reelId: 'reel-1', evidenceType: 'TRANSCRIPT', chunkText: 'one' },
        { reelId: 'reel-2', evidenceType: 'TRANSCRIPT', chunkText: 'two' },
      ],
      rerankedChunks: [
        {
          reelId: 'reel-1',
          evidenceType: 'TRANSCRIPT',
          evidenceText: 'one',
          chunkText: 'one',
          tags: [],
        },
      ],
    } as unknown as RagChatWorkflowState;

    await expect(useCase.execute(comparisonState)).resolves.toMatchObject({
      sufficient: false,
      missingReelIds: ['reel-2'],
      recommendedAction: 'REFUSE_NO_CONTEXT',
    });
    expect(service.generateObject).not.toHaveBeenCalled();
  });

  it('refuses a multi-Reel multimodal answer when one Reel lacks a required modality', async () => {
    const service = { generateObject: jest.fn() };
    const useCase = new CheckContextSufficiencyUseCase(
      service as never,
      config,
    );
    const state = {
      userMessage: 'Compare what is visible and said in both shared Reels.',
      route: {
        intent: 'REEL_VIDEO_QUESTION',
        reelQuestionType: 'MULTIMODAL_CONTENT',
        needsRetrieval: true,
        requiredEvidence: ['TRANSCRIPT', 'VISUAL'],
      },
      retrievalPlan: { requiresReelCoverage: true },
      retrievedChunks: [
        { reelId: 'reel-1', evidenceType: 'TRANSCRIPT', chunkText: 'speech 1' },
        { reelId: 'reel-1', evidenceType: 'VISUAL', chunkText: 'scene 1' },
        { reelId: 'reel-2', evidenceType: 'TRANSCRIPT', chunkText: 'speech 2' },
        { reelId: 'reel-2', evidenceType: 'VISUAL', chunkText: 'scene 2' },
      ],
      rerankedChunks: [
        {
          reelId: 'reel-1',
          evidenceType: 'TRANSCRIPT',
          chunkText: 'speech 1',
          tags: [],
        },
        {
          reelId: 'reel-1',
          evidenceType: 'VISUAL',
          chunkText: 'scene 1',
          tags: [],
        },
        {
          reelId: 'reel-2',
          evidenceType: 'TRANSCRIPT',
          chunkText: 'speech 2',
          tags: [],
        },
      ],
    } as unknown as RagChatWorkflowState;

    await expect(useCase.execute(state)).resolves.toMatchObject({
      sufficient: false,
      missingReelIds: ['reel-2'],
      recommendedAction: 'REFUSE_NO_CONTEXT',
    });
    expect(service.generateObject).not.toHaveBeenCalled();
  });

  it('requires both transcript and visual evidence for a multimodal route', async () => {
    const service = {
      generateObject: jest.fn().mockResolvedValue({
        sufficient: true,
        confidence: 1,
        supportedEvidenceIds: ['e0', 'e1'],
        reason: 'Both modalities directly support the request.',
        recommendedAction: 'ANSWER',
      }),
    };
    const useCase = new CheckContextSufficiencyUseCase(
      service as never,
      config,
    );
    const multimodalState = {
      userMessage:
        'What did the speaker say while the blue device was visible?',
      route: {
        intent: 'REEL_VIDEO_QUESTION',
        reelQuestionType: 'MULTIMODAL_CONTENT',
        needsRetrieval: true,
        requiredEvidence: ['TRANSCRIPT', 'VISUAL'],
      },
      rerankedChunks: [
        {
          evidenceType: 'TRANSCRIPT',
          evidenceText: 'The device is ready.',
          chunkText: 'The device is ready.',
          tags: [],
        },
        {
          evidenceType: 'VISUAL',
          evidenceText: 'A blue device is visible.',
          chunkText: 'A blue device is visible.',
          tags: [],
        },
      ],
    } as unknown as RagChatWorkflowState;
    await expect(useCase.execute(multimodalState)).resolves.toMatchObject({
      sufficient: true,
      availableEvidence: ['TRANSCRIPT', 'VISUAL'],
    });
  });

  it('instructs the judge to assess requested Reel comparisons independently', async () => {
    const service = {
      generateObject: jest.fn().mockResolvedValue({
        sufficient: true,
        confidence: 1,
        supportedEvidenceIds: ['e0', 'e1'],
        reason: 'Each requested Reel has a relevant transcript segment.',
        recommendedAction: 'ANSWER',
      }),
    };
    const useCase = new CheckContextSufficiencyUseCase(
      service as never,
      config,
    );
    const segmentTail = 'The final transcript clause remains available.';
    const longFirstSegment = `${'The opening transcript describes the setting. '.repeat(15)}${segmentTail}`;
    const comparisonState = {
      userMessage: 'Compare the first transcript segment from both Reels.',
      route: {
        intent: 'REEL_VIDEO_QUESTION',
        reelQuestionType: 'TRANSCRIPT_CONTENT',
        needsRetrieval: true,
        requiredEvidence: ['TRANSCRIPT'],
      },
      retrievalPlan: {
        sourceOrder: 'ASC',
        searchLimit: 1,
        requiresReelCoverage: true,
      },
      retrievedChunks: [
        { reelId: 'reel-1', evidenceType: 'TRANSCRIPT', chunkText: 'one' },
        { reelId: 'reel-2', evidenceType: 'TRANSCRIPT', chunkText: 'two' },
      ],
      rerankedChunks: [
        {
          reelId: 'reel-1',
          evidenceType: 'TRANSCRIPT',
          evidenceText: longFirstSegment,
          chunkText: longFirstSegment,
          tags: [],
        },
        {
          reelId: 'reel-2',
          evidenceType: 'TRANSCRIPT',
          evidenceText: 'The second clip opens with a police report.',
          chunkText: 'The second clip opens with a police report.',
          tags: [],
        },
      ],
    } as unknown as RagChatWorkflowState;

    await expect(useCase.execute(comparisonState)).resolves.toMatchObject({
      sufficient: true,
      supportedEvidenceIds: ['e0', 'e1'],
    });
    expect(service.generateObject.mock.calls[0][0].systemPrompt).toMatch(
      /assess each requested Reel independently/i,
    );
    expect(service.generateObject.mock.calls[0][0].systemPrompt).toMatch(
      /earliest source-ordered transcript item for each Reel/i,
    );
    expect(service.generateObject.mock.calls[0][0].userPrompt).toContain(
      '"requiresReelCoverage":true',
    );
    expect(service.generateObject.mock.calls[0][0].userPrompt).toContain(
      '"sourceOrder":"ASC"',
    );
    expect(service.generateObject.mock.calls[0][0].userPrompt).toContain(
      '"searchLimit":1',
    );
    expect(service.generateObject.mock.calls[0][0].userPrompt).toContain(
      segmentTail,
    );
  });

  it('refuses a required user-memory request when the memory tool is empty', async () => {
    const service = { generateObject: jest.fn() };
    const useCase = new CheckContextSufficiencyUseCase(
      service as never,
      config,
    );
    const memoryState = {
      userMessage: 'What database do I prefer?',
      route: {
        intent: 'USER_MEMORY_QUESTION',
        needsRetrieval: false,
        requiredEvidence: ['USER_MEMORY'],
        toolPlan: {
          allowedTools: ['search_user_memory'],
          requiredTools: ['search_user_memory'],
        },
      },
      userMemories: { memories: [] },
      contextToolExecution: {
        allowedTools: ['search_user_memory'],
        requiredTools: ['search_user_memory'],
        stepCount: 1,
        calls: [
          {
            toolName: 'search_user_memory',
            status: 'EMPTY',
            itemCount: 0,
            latencyMs: 2,
          },
        ],
        providerStatus: 'SUCCESS',
      },
    } as unknown as RagChatWorkflowState;

    await expect(useCase.execute(memoryState)).resolves.toMatchObject({
      sufficient: false,
      recommendedAction: 'REFUSE_NO_CONTEXT',
      diagnostics: { decisionSource: 'DETERMINISTIC_REQUIRED_TOOL' },
    });
    expect(service.generateObject).not.toHaveBeenCalled();
  });

  it('accepts usable user memory without a second semantic sufficiency call', async () => {
    const service = { generateObject: jest.fn() };
    const useCase = new CheckContextSufficiencyUseCase(
      service as never,
      config,
    );
    const memoryState = {
      userMessage: 'What database do I prefer?',
      route: {
        intent: 'USER_MEMORY_QUESTION',
        needsRetrieval: false,
        requiredEvidence: ['USER_MEMORY'],
        toolPlan: {
          allowedTools: ['search_user_memory'],
          requiredTools: ['search_user_memory'],
        },
      },
      userMemories: {
        memories: [
          {
            userId: 'user-1',
            type: 'PREFERENCE',
            content: 'PostgreSQL',
            confidence: 0.9,
          },
        ],
      },
      contextToolExecution: {
        allowedTools: ['search_user_memory'],
        requiredTools: ['search_user_memory'],
        stepCount: 1,
        calls: [
          {
            toolName: 'search_user_memory',
            status: 'SUCCESS',
            itemCount: 1,
            latencyMs: 2,
          },
        ],
        providerStatus: 'SUCCESS',
      },
    } as unknown as RagChatWorkflowState;

    await expect(useCase.execute(memoryState)).resolves.toMatchObject({
      sufficient: true,
      availableEvidence: ['USER_MEMORY'],
      diagnostics: { decisionSource: 'DETERMINISTIC_REQUIRED_TOOL' },
    });
    expect(service.generateObject).not.toHaveBeenCalled();
  });

  it('refuses deterministically when the required modality is absent', async () => {
    const service = { generateObject: jest.fn() };
    const useCase = new CheckContextSufficiencyUseCase(
      service as never,
      config,
    );

    await expect(
      useCase.execute(
        state({
          requiredEvidence: ['VISUAL'],
          evidenceType: 'TRANSCRIPT',
          evidenceText: 'A speaker discusses a glyph.',
        }),
      ),
    ).resolves.toMatchObject({
      sufficient: false,
      missingEvidence: ['VISUAL'],
      supportedEvidenceIds: [],
      diagnostics: { decisionSource: 'DETERMINISTIC_REQUIRED_MODALITY' },
    });
    expect(service.generateObject).not.toHaveBeenCalled();
  });

  it.each([
    ['supports an unseen relation', true, 'ANSWER'],
    ['contains only a nearby topic', false, 'REFUSE_NO_CONTEXT'],
  ])(
    'uses the semantic decision when evidence %s',
    async (_description, sufficient, recommendedAction) => {
      const service = {
        generateObject: jest.fn().mockResolvedValue({
          sufficient,
          confidence: 0.87,
          availableEvidence: ['TRANSCRIPT'],
          missingEvidence: sufficient ? [] : ['TRANSCRIPT'],
          supportedEvidenceIds: sufficient ? ['e0'] : [],
          reason: 'Semantic evidence judgment.',
          userFacingReason: sufficient ? '' : 'The relation is unsupported.',
          recommendedAction,
        }),
      };
      const useCase = new CheckContextSufficiencyUseCase(
        service as never,
        config,
      );

      await expect(
        useCase.execute(
          state({ evidenceText: 'A novel relation appears in this passage.' }),
        ),
      ).resolves.toMatchObject({
        sufficient,
        missingEvidence: [],
        supportedEvidenceIds: sufficient ? ['e0'] : [],
        diagnostics: { providerStatus: 'SUCCESS', decisionSource: 'LLM' },
      });
      expect(service.generateObject).toHaveBeenCalledWith(
        expect.objectContaining({
          model: 'test/test/sufficiency',
          timeoutMs: 6_000,
          temperature: 0,
          schemaVersion: 'context-sufficiency-v2',
        }),
      );
      const schema = service.generateObject.mock.calls[0][0].jsonSchema;
      expect(schema.required).not.toEqual(
        expect.arrayContaining(['availableEvidence', 'missingEvidence']),
      );
      expect(schema.properties).toMatchObject({
        confidence: { minimum: 0, maximum: 1 },
        supportedEvidenceIds: { maxItems: 8 },
        reason: { maxLength: 400 },
        userFacingReason: { maxLength: 300 },
      });
      expect(service.generateObject.mock.calls[0][0].systemPrompt).toContain(
        'minimal set of supplied evidence items that directly supports answering the exact user question',
      );
      expect(service.generateObject.mock.calls[0][0].systemPrompt).toContain(
        'Use REWRITE_AND_RETRY only when typed evidence exists',
      );
      expect(service.generateObject.mock.calls[0][0].systemPrompt).toContain(
        'Transcript ASR may contain punctuation',
      );
    },
  );

  it('persists safe structured-call diagnostics from the sufficiency provider', async () => {
    const service = {
      generateObject: jest
        .fn()
        .mockImplementation(
          (input: { onDiagnostics?: (value: unknown) => void }) => {
            input.onDiagnostics?.({
              modelRole: 'CONTEXT_SUFFICIENCY',
              model: 'test/test/sufficiency',
              providerStatus: 200,
              attempt: 1,
            });
            return Promise.resolve({
              sufficient: true,
              confidence: 0.9,
              supportedEvidenceIds: ['e0'],
              reason: 'Supported.',
              recommendedAction: 'ANSWER',
            });
          },
        ),
    };
    const useCase = new CheckContextSufficiencyUseCase(
      service as never,
      config,
    );

    await expect(
      useCase.execute(state({ evidenceText: 'Authorized evidence.' })),
    ).resolves.toMatchObject({
      diagnostics: {
        semanticCalls: [
          expect.objectContaining({
            modelRole: 'CONTEXT_SUFFICIENCY',
            providerStatus: 200,
            attempt: 1,
          }),
        ],
      },
    });
  });

  it('filters provider evidence IDs that were not supplied', async () => {
    const service = {
      generateObject: jest.fn().mockResolvedValue({
        sufficient: true,
        confidence: 1,
        availableEvidence: ['TRANSCRIPT'],
        missingEvidence: [],
        supportedEvidenceIds: ['e0', 'e99'],
        reason: 'Supported.',
        userFacingReason: '',
        recommendedAction: 'ANSWER',
      }),
    };
    const useCase = new CheckContextSufficiencyUseCase(
      service as never,
      config,
    );

    await expect(
      useCase.execute(state({ evidenceText: 'Authorized evidence.' })),
    ).resolves.toMatchObject({ supportedEvidenceIds: ['e0'] });
  });

  it('preserves multiple valid support IDs while deduplicating them', async () => {
    const service = {
      generateObject: jest.fn().mockResolvedValue({
        sufficient: true,
        confidence: 0.9,
        supportedEvidenceIds: ['e0', 'e1', 'e0'],
        reason: 'Both supplied items directly support the relation.',
        userFacingReason: '',
        recommendedAction: 'ANSWER',
      }),
    };
    const useCase = new CheckContextSufficiencyUseCase(
      service as never,
      config,
    );
    const multiEvidenceState = {
      ...state({ evidenceText: 'First support.' }),
      rerankedChunks: [
        {
          evidenceType: 'TRANSCRIPT',
          evidenceText: 'First support.',
          chunkText: 'First support.',
          tags: [],
        },
        {
          evidenceType: 'TRANSCRIPT',
          evidenceText: 'Second support.',
          chunkText: 'Second support.',
          tags: [],
        },
      ],
    } as RagChatWorkflowState;

    await expect(useCase.execute(multiEvidenceState)).resolves.toMatchObject({
      sufficient: true,
      supportedEvidenceIds: ['e0', 'e1'],
    });
  });

  it('fails closed when the semantic provider is unavailable', async () => {
    const service = {
      generateObject: jest.fn().mockRejectedValue(new Error('down')),
    };
    const fallbackConfig = {
      ...config,
      get: jest.fn((key: string) =>
        key === 'AI_ROUTER_FALLBACK_MODEL' ? 'test/test/fallback' : undefined,
      ),
    } as unknown as IAiApplicationConfig;
    const useCase = new CheckContextSufficiencyUseCase(
      service as never,
      fallbackConfig,
    );

    await expect(
      useCase.execute(state({ evidenceText: 'Potential evidence.' })),
    ).resolves.toMatchObject({
      sufficient: false,
      confidence: 0,
      missingEvidence: [],
      supportedEvidenceIds: [],
      diagnostics: { providerStatus: 'ERROR', decisionSource: 'FAIL_CLOSED' },
    });
    expect(service.generateObject).toHaveBeenCalledTimes(1);
  });

  it('uses the configured router fallback after a transient provider error', async () => {
    const transientError = Object.assign(new Error('rate limited'), {
      code: 'STRUCTURED_COMPLETION_PROVIDER_ERROR',
      transient: true,
    });
    const service = {
      generateObject: jest
        .fn()
        .mockRejectedValueOnce(transientError)
        .mockResolvedValueOnce({
          sufficient: true,
          confidence: 0.9,
          supportedEvidenceIds: ['e0'],
          reason: 'The evidence directly supports the answer.',
          recommendedAction: 'ANSWER',
        }),
    };
    const fallbackConfig = {
      ...config,
      get: jest.fn((key: string) =>
        key === 'AI_ROUTER_FALLBACK_MODEL' ? 'test/test/fallback' : undefined,
      ),
    } as unknown as IAiApplicationConfig;
    const useCase = new CheckContextSufficiencyUseCase(
      service as never,
      fallbackConfig,
    );

    await expect(
      useCase.execute(state({ evidenceText: 'Potential evidence.' })),
    ).resolves.toMatchObject({
      sufficient: true,
      diagnostics: {
        providerStatus: 'SUCCESS',
        decisionSource: 'LLM_FALLBACK',
        model: 'test/test/fallback',
      },
    });
    expect(service.generateObject).toHaveBeenCalledTimes(2);
    expect(service.generateObject).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ model: 'test/test/sufficiency' }),
    );
    expect(service.generateObject).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ model: 'test/test/fallback' }),
    );
  });

  it('fails closed when the configured fallback also fails', async () => {
    const transientError = Object.assign(new Error('rate limited'), {
      code: 'STRUCTURED_COMPLETION_PROVIDER_ERROR',
      transient: true,
    });
    const service = {
      generateObject: jest
        .fn()
        .mockRejectedValueOnce(transientError)
        .mockRejectedValueOnce(new Error('fallback unavailable')),
    };
    const fallbackConfig = {
      ...config,
      get: jest.fn((key: string) =>
        key === 'AI_ROUTER_FALLBACK_MODEL' ? 'test/test/fallback' : undefined,
      ),
    } as unknown as IAiApplicationConfig;
    const useCase = new CheckContextSufficiencyUseCase(
      service as never,
      fallbackConfig,
    );

    await expect(
      useCase.execute(state({ evidenceText: 'Potential evidence.' })),
    ).resolves.toMatchObject({
      sufficient: false,
      confidence: 0,
      recommendedAction: 'REFUSE_NO_CONTEXT',
      diagnostics: { providerStatus: 'ERROR', decisionSource: 'FAIL_CLOSED' },
    });
    expect(service.generateObject).toHaveBeenCalledTimes(2);
  });

  it('does not require visual evidence when reelQuestionType is TRANSCRIPT_CONTENT even if VISUAL was listed in requiredEvidence', async () => {
    const service = {
      generateObject: jest.fn().mockResolvedValue({
        sufficient: true,
        confidence: 0.95,
        supportedEvidenceIds: ['reel:1:chunk:0'],
        reason: 'Transcript provides the answer.',
        recommendedAction: 'ANSWER',
      }),
    };
    const useCase = new CheckContextSufficiencyUseCase(
      service as never,
      config,
    );

    const transcriptState = {
      userMessage: 'What is said in the opening?',
      route: {
        needsRetrieval: true,
        reelQuestionType: 'TRANSCRIPT_CONTENT',
        requiredEvidence: ['TRANSCRIPT', 'VISUAL'],
      },
      rerankedChunks: [
        {
          id: 'reel:1:chunk:0',
          evidenceType: 'TRANSCRIPT',
          evidenceText: 'Hello world opening statement',
          chunkText: 'Hello world opening statement',
          tags: [],
        },
      ],
    } as unknown as RagChatWorkflowState;

    const result = await useCase.execute(transcriptState);
    expect(result.sufficient).toBe(true);
    expect(result.missingEvidence).toEqual([]);
    expect(result.diagnostics.decisionSource).toBe('LLM');
  });
});
