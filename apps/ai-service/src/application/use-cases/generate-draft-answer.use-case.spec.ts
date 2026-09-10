import type { IAiApplicationConfig } from '@ai/domain/interfaces/ai-application-config.interface';
import type { RagChatWorkflowState } from '@ai/domain/interfaces/rag-chat-workflow.interface';
import { GenerateDraftAnswerUseCase } from './generate-draft-answer.use-case';

describe('GenerateDraftAnswerUseCase', () => {
  const config = {
    model: jest.fn(() => 'test/test/answer'),
    timeoutMs: jest.fn(() => 10_000),
    maxCompletionTokens: jest.fn(() => 1_536),
  } as unknown as IAiApplicationConfig;
  const promptBuilder = { build: jest.fn(() => 'Grounding instructions.') };
  const state = {
    userMessage: 'What relation is asserted?',
    route: { intent: 'REEL_VIDEO_QUESTION' },
    rerankedChunks: [
      {
        evidenceType: 'TRANSCRIPT',
        evidenceText: 'The zorb is coupled to the quasar.',
        chunkText: 'The zorb is coupled to the quasar.',
        tags: [],
      },
    ],
  } as unknown as RagChatWorkflowState;

  it('returns answer claims mapped to authorized evidence IDs', async () => {
    const service = {
      generateObject: jest.fn().mockResolvedValue({
        answer: 'The zorb is coupled to the quasar.',
        claims: [
          {
            claim: 'The zorb is coupled to the quasar.',
            evidenceIds: ['e0'],
          },
        ],
      }),
    };
    const useCase = new GenerateDraftAnswerUseCase(
      service as never,
      promptBuilder,
      config,
    );

    await expect(useCase.execute(state)).resolves.toEqual({
      answer: 'The zorb is coupled to the quasar.',
      claims: [
        {
          claim: 'The zorb is coupled to the quasar.',
          evidenceIds: ['e0'],
        },
      ],
      modelRole: 'ANSWER',
      diagnostics: [],
    });
    expect(service.generateObject).toHaveBeenCalledWith(
      expect.objectContaining({
        model: 'test/test/answer',
        timeoutMs: 10_000,
        maxTokens: 1_536,
        temperature: 0,
        userPrompt: expect.stringContaining('"evidenceId":"e0"'),
      }),
    );
    const request = service.generateObject.mock.calls[0]?.[0];
    expect(request.jsonSchema.properties.answer).toMatchObject({
      maxLength: 2_500,
    });
    expect(request.jsonSchema.properties.claims).toMatchObject({
      maxItems: 12,
    });
    expect(
      request.jsonSchema.properties.claims.items.properties.evidenceIds,
    ).toMatchObject({ minItems: 1, maxItems: 3 });
    expect(request.systemPrompt).toContain(
      'exhaustive grounding audit of every independently checkable factual reel assertion',
    );
    expect(request.systemPrompt).toContain(
      'Split compound answer sentences into atomic claims',
    );
    expect(request.systemPrompt).toContain(
      'do not add factual claims that answer does not state',
    );
    expect(request.systemPrompt).toContain(
      'Multiple claims may cite the same evidence ID',
    );
    expect(request.systemPrompt).toContain(
      'one claim may cite multiple evidence IDs',
    );
    expect(request.jsonSchema.properties.claims.description).toContain(
      'Exhaustive atomic grounding mappings',
    );
    expect(
      request.jsonSchema.properties.claims.items.properties.claim.description,
    ).toContain('actually stated in answer');
    expect(
      request.jsonSchema.properties.claims.items.properties.evidenceIds
        .description,
    ).toContain('directly support this exact claim');
    expect(promptBuilder.build).toHaveBeenCalledWith(state, {
      includeRetrievedEvidence: false,
    });
  });

  it.each([
    [
      'unknown evidence ID',
      {
        answer: 'Unsupported.',
        claims: [{ claim: 'Unsupported.', evidenceIds: ['e8'] }],
      },
      /unknown evidence ID/,
    ],
    ['empty answer', { answer: '', claims: [] }, /empty answer/],
  ])('rejects %s', async (_name, response, error) => {
    const useCase = new GenerateDraftAnswerUseCase(
      { generateObject: jest.fn().mockResolvedValue(response) } as never,
      promptBuilder,
      config,
    );
    await expect(useCase.execute(state)).rejects.toThrow(error);
  });

  it('passes a non-empty answer to the verifier when the provider omits optional claim mappings', async () => {
    const useCase = new GenerateDraftAnswerUseCase(
      {
        generateObject: jest.fn().mockResolvedValue({
          answer: 'The zorb is coupled to the quasar.',
          claims: [],
        }),
      } as never,
      promptBuilder,
      config,
    );

    await expect(useCase.execute(state)).resolves.toMatchObject({
      answer: 'The zorb is coupled to the quasar.',
      claims: [],
    });
  });

  it('allows normal chat to contain no reel claim mappings', async () => {
    const service = {
      generateObject: jest.fn().mockResolvedValue({
        answer: 'Hello!',
        claims: [],
      }),
    };
    const useCase = new GenerateDraftAnswerUseCase(
      service as never,
      promptBuilder,
      config,
    );
    await expect(
      useCase.execute({
        ...state,
        route: { intent: 'NORMAL_CHAT' },
        rerankedChunks: [],
      } as unknown as RagChatWorkflowState),
    ).resolves.toMatchObject({ answer: 'Hello!', claims: [] });
    const request = service.generateObject.mock.calls[0]?.[0] as {
      jsonSchema: { properties: { claims: { minItems?: number } } };
    };
    expect(request.jsonSchema.properties.claims).not.toHaveProperty('minItems');
  });

  it('narrows answer evidence to the sufficiency-selected IDs without renumbering them', async () => {
    const service = {
      generateObject: jest.fn().mockResolvedValue({
        answer: 'The zorb is coupled to the quasar.',
        claims: [
          {
            claim: 'The zorb is coupled to the quasar.',
            evidenceIds: ['e1'],
          },
        ],
      }),
    };
    const useCase = new GenerateDraftAnswerUseCase(
      service as never,
      promptBuilder,
      config,
    );

    await expect(
      useCase.execute({
        ...state,
        contextSufficiency: {
          sufficient: true,
          supportedEvidenceIds: ['e1'],
        },
        rerankedChunks: [
          {
            evidenceType: 'TRANSCRIPT',
            evidenceText: 'Unrelated distractor.',
            chunkText: 'Unrelated distractor.',
            tags: [],
          },
          {
            evidenceType: 'TRANSCRIPT',
            evidenceText: 'The zorb is coupled to the quasar.',
            chunkText: 'The zorb is coupled to the quasar.',
            tags: [],
          },
        ],
      } as unknown as RagChatWorkflowState),
    ).resolves.toMatchObject({ claims: [{ evidenceIds: ['e1'] }] });

    const request = service.generateObject.mock.calls[0]?.[0] as {
      userPrompt: string;
    };
    expect(JSON.parse(request.userPrompt).authorizedEvidence).toEqual([
      expect.objectContaining({ evidenceId: 'e1' }),
    ]);
  });

  it('retries once when a successful answer violates the local claim contract', async () => {
    const service = {
      generateObject: jest
        .fn()
        .mockResolvedValueOnce({
          answer: 'A response with an invalid grounded claim mapping.',
          claims: [
            {
              claim: 'An invalid mapping.',
              evidenceIds: ['e8'],
            },
          ],
        })
        .mockResolvedValueOnce({
          answer: 'The zorb is coupled to the quasar.',
          claims: [
            {
              claim: 'The zorb is coupled to the quasar.',
              evidenceIds: ['e0'],
            },
          ],
        }),
    };
    const useCase = new GenerateDraftAnswerUseCase(
      service as never,
      promptBuilder,
      config,
    );

    await expect(useCase.execute(state)).resolves.toMatchObject({
      answer: 'The zorb is coupled to the quasar.',
      claims: [{ evidenceIds: ['e0'] }],
    });
    expect(service.generateObject).toHaveBeenCalledTimes(2);
    expect(service.generateObject.mock.calls[1][0].systemPrompt).toContain(
      'previous response violated the local grounding contract',
    );
  });
});
