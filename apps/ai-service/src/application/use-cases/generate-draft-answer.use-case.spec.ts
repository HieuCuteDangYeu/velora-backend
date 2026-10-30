import type { IAiApplicationConfig } from '@ai/domain/interfaces/ai-application-config.interface';
import type { RagChatWorkflowState } from '@ai/domain/interfaces/rag-chat-workflow.interface';
import { MULTI_REEL_TRANSCRIPT_COMPARISON_MAX_CHARS } from '@ai/domain/services/rag-answer-contract';
import {
  DEFAULT_RAG_PROMPT_BOUNDS,
  transcriptSegmentPromptBounds,
} from '@ai/domain/services/rag-prompt-bounds';
import { GenerateDraftAnswerUseCase } from './generate-draft-answer.use-case';

describe('GenerateDraftAnswerUseCase', () => {
  it('retries a multimodal answer when its claim mapping omits a required evidence type', async () => {
    const answer =
      'Visible: A blue car is parked. Spoken: The speaker says the car is blue.';
    const generateObject = jest
      .fn()
      .mockResolvedValueOnce({
        answer: 'The speaker says the car is blue.',
        claims: [
          { claim: 'The speaker says the car is blue.', evidenceIds: ['e0'] },
        ],
      })
      .mockResolvedValueOnce({
        answer,
        claims: [
          { claim: 'A blue car is parked.', evidenceIds: ['e1'] },
          { claim: 'The speaker says the car is blue.', evidenceIds: ['e0'] },
        ],
      });
    const useCase = new GenerateDraftAnswerUseCase(
      { generateObject } as never,
      { build: jest.fn(() => 'Grounding instructions.') },
      {
        model: () => 'test',
        timeoutMs: () => 10_000,
        maxCompletionTokens: () => 1024,
      } as never,
    );

    const result = await useCase.execute({
      userMessage:
        'What does the speaker say about the car, and what is visible?',
      route: {
        intent: 'REEL_VIDEO_QUESTION',
        reelQuestionType: 'MULTIMODAL_CONTENT',
        requiredEvidence: ['TRANSCRIPT', 'VISUAL'],
        needsRetrieval: true,
      },
      retrievalPlan: {},
      contextSufficiency: {
        sufficient: true,
        availableEvidence: ['TRANSCRIPT', 'VISUAL'],
        missingEvidence: [],
        supportedEvidenceIds: ['e0'],
        recommendedAction: 'ANSWER',
      },
      rerankedChunks: [
        {
          chunkId: 'transcript-1',
          reelId: 'reel-1',
          evidenceType: 'TRANSCRIPT',
          evidenceText: 'The speaker says the car is blue.',
          chunkText: 'The speaker says the car is blue.',
          tags: [],
          distance: null,
        },
        {
          chunkId: 'visual-1',
          reelId: 'reel-1',
          evidenceType: 'VISUAL',
          evidenceText: 'A blue car is parked.',
          chunkText: 'A blue car is parked.',
          tags: [],
          distance: null,
        },
      ],
    } as never);

    expect(generateObject).toHaveBeenCalledTimes(2);
    expect(generateObject.mock.calls[0][0].systemPrompt).toMatch(
      /cover every required evidence type/i,
    );
    expect(generateObject.mock.calls[0][0].userPrompt).toContain(
      '"requiredEvidenceTypes":["TRANSCRIPT","VISUAL"]',
    );
    expect(generateObject.mock.calls[0][0].systemPrompt).toMatch(
      /context check marked its listed evidence IDs sufficient/i,
    );
    expect(generateObject.mock.calls[0][0].userPrompt).toContain(
      '"supportedEvidenceIds":["e0"]',
    );
    expect(generateObject.mock.calls[0][0].userPrompt).toContain(
      '"sourceId":"visual-1"',
    );
    expect(generateObject.mock.calls[1][0].systemPrompt).toMatch(
      /cover every required evidence type/i,
    );
    expect(result.answer).toBe(answer);
    expect(result.claims.map((claim) => claim.evidenceIds)).toEqual([
      ['e1'],
      ['e0'],
    ]);
  });

  it('builds a source-grounded multimodal fallback only when both modalities are supported', () => {
    const useCase = new GenerateDraftAnswerUseCase(
      { generateObject: jest.fn() } as never,
      { build: jest.fn() },
      { model: () => 'test', maxCompletionTokens: () => 1024 } as never,
    );
    const fallback = useCase.buildExtractiveFallback(
      {
        userMessage: 'Describe what is visible and what is said.',
        route: {
          intent: 'REEL_VIDEO_QUESTION',
          reelQuestionType: 'MULTIMODAL_CONTENT',
          requiredEvidence: ['TRANSCRIPT', 'VISUAL'],
        },
        contextSufficiency: {
          sufficient: true,
          supportedEvidenceIds: ['e0', 'e1'],
          missingEvidence: [],
          availableEvidence: ['TRANSCRIPT', 'VISUAL'],
        },
        rerankedChunks: [
          {
            chunkId: 'transcript-1',
            reelId: 'reel-1',
            evidenceType: 'TRANSCRIPT',
            evidenceText: 'The speaker says hello.',
            chunkText: 'The speaker says hello.',
            tags: [],
          },
          {
            chunkId: 'visual-1',
            reelId: 'reel-1',
            evidenceType: 'VISUAL',
            evidenceText: 'A person waves.',
            chunkText: 'A person waves.',
            tags: [],
          },
        ],
      } as never,
      'UNUSABLE_SYNTHESIS',
    );

    expect(fallback).toMatchObject({
      answer: 'Visible: A person waves.\nSpoken: The speaker says hello.',
      claims: [
        { claim: 'Visible: A person waves.', evidenceIds: ['e1'] },
        { claim: 'Spoken: The speaker says hello.', evidenceIds: ['e0'] },
      ],
      generationEvidence: expect.arrayContaining([
        expect.objectContaining({
          evidenceId: 'e0',
          evidenceType: 'TRANSCRIPT',
        }),
        expect.objectContaining({ evidenceId: 'e1', evidenceType: 'VISUAL' }),
      ]),
      finalizationMode: 'EXTRACTIVE_EVIDENCE_FALLBACK',
      fallbackReason: 'UNUSABLE_SYNTHESIS',
    });

    const insufficient = useCase.buildExtractiveFallback(
      {
        userMessage: 'Describe what is visible and what is said.',
        route: {
          intent: 'REEL_VIDEO_QUESTION',
          reelQuestionType: 'MULTIMODAL_CONTENT',
          requiredEvidence: ['TRANSCRIPT', 'VISUAL'],
        },
        contextSufficiency: {
          sufficient: false,
          supportedEvidenceIds: ['e0'],
          missingEvidence: ['VISUAL'],
        },
        rerankedChunks: [
          {
            chunkId: 'transcript-1',
            reelId: 'reel-1',
            evidenceType: 'TRANSCRIPT',
            evidenceText: 'The speaker says hello.',
            chunkText: 'The speaker says hello.',
            tags: [],
          },
        ],
      } as never,
      'UNUSABLE_SYNTHESIS',
    );
    expect(insufficient).toBeUndefined();
  });

  it('uses exact transcript spans as a source-attributed fallback for a supported multi-Reel comparison', () => {
    const useCase = new GenerateDraftAnswerUseCase(
      { generateObject: jest.fn() } as never,
      { build: jest.fn() },
      { model: () => 'test', maxCompletionTokens: () => 1024 } as never,
    );
    const state = {
      userMessage:
        'Compare the first indexed transcript segments of Episode One and Episode Two. Attribute each statement to its own clip.',
      route: {
        intent: 'REEL_VIDEO_QUESTION',
        reelQuestionType: 'TRANSCRIPT_CONTENT',
        requiredEvidence: ['TRANSCRIPT'],
        needsRetrieval: true,
      },
      retrievalPlan: {
        requiresReelCoverage: true,
        sourceOrder: 'ASC',
        mode: 'REEL_HYBRID',
        query: 'Compare the opening transcript segments.',
      },
      accessibleReelIds: ['reel-one', 'reel-two'],
      contextSufficiency: {
        sufficient: true,
        availableEvidence: ['TRANSCRIPT'],
        missingEvidence: [],
        supportedEvidenceIds: ['e0', 'e1'],
        recommendedAction: 'ANSWER',
      },
      retrievedChunks: [
        { chunkId: 'chunk-one', reelId: 'reel-one' },
        { chunkId: 'chunk-two', reelId: 'reel-two' },
      ],
      rerankedChunks: [
        {
          chunkId: 'chunk-one',
          reelId: 'reel-one',
          title: 'Episode One',
          evidenceType: 'TRANSCRIPT',
          startTime: 0,
          endTime: 30,
          evidenceText: 'Alice leaves the station after sunrise.',
          chunkText: 'Alice leaves the station after sunrise.',
          tags: [],
        },
        {
          chunkId: 'chunk-two',
          reelId: 'reel-two',
          title: 'Episode Two',
          evidenceType: 'TRANSCRIPT',
          startTime: 0,
          endTime: 30,
          evidenceText: 'Bob enters the courthouse before noon.',
          chunkText: 'Bob enters the courthouse before noon.',
          tags: [],
        },
      ],
    } as unknown as RagChatWorkflowState;

    const fallback = useCase.buildExtractiveFallback(
      state,
      'ANSWER_GENERATION_FAILURE',
    );

    expect(fallback).toMatchObject({
      answer: expect.stringContaining('Episode One:'),
      finalizationMode: 'EXTRACTIVE_EVIDENCE_FALLBACK',
      claims: [
        expect.objectContaining({ evidenceIds: ['e0'] }),
        expect.objectContaining({ evidenceIds: ['e1'] }),
      ],
      generationEvidence: expect.arrayContaining([
        expect.objectContaining({ reelId: 'reel-one', evidenceId: 'e0' }),
        expect.objectContaining({ reelId: 'reel-two', evidenceId: 'e1' }),
      ]),
    });
    expect(fallback?.answer).toContain('Alice leaves the station');
    expect(fallback?.answer).toContain(
      'Episode Two: Bob enters the courthouse',
    );

    const oneSource = useCase.buildExtractiveFallback(
      {
        ...state,
        contextSufficiency: {
          ...state.contextSufficiency,
          supportedEvidenceIds: ['e0'],
        },
      } as unknown as RagChatWorkflowState,
      'ANSWER_GENERATION_FAILURE',
    );
    expect(oneSource).toBeUndefined();
  });

  it('does not require source-identifying metadata as a transcript claim', async () => {
    const service = {
      generateObject: jest.fn().mockResolvedValue({
        answer: 'He arrived at 8 p.m.',
        claims: [{ claim: 'He arrived at 8 p.m.', evidenceIds: ['e0'] }],
      }),
    };
    const promptBuilder = { build: jest.fn(() => 'Grounding instructions.') };
    const useCase = new GenerateDraftAnswerUseCase(
      service as never,
      promptBuilder,
      {
        model: () => 'test/test/answer',
        timeoutMs: () => 10_000,
        maxCompletionTokens: () => 1024,
        get: () => undefined,
      } as never,
    );

    const result = await useCase.execute({
      userMessage:
        'Summarize what is said in the indexed transcript segment of Episode Two.',
      route: {
        intent: 'REEL_VIDEO_QUESTION',
        reelQuestionType: 'GENERAL_REEL_SUMMARY',
        requiredEvidence: ['TRANSCRIPT', 'METADATA'],
        needsRetrieval: true,
      },
      retrievalPlan: {
        requiresReelCoverage: false,
        mode: 'REEL_HYBRID',
        query: 'Summarize the indexed transcript segment.',
      },
      accessibleReelIds: ['reel-two'],
      contextSufficiency: {
        sufficient: true,
        availableEvidence: ['TRANSCRIPT', 'METADATA'],
        missingEvidence: [],
        supportedEvidenceIds: ['e0'],
        recommendedAction: 'ANSWER',
      },
      rerankedChunks: [
        {
          chunkId: 'chunk-two',
          reelId: 'reel-two',
          title: 'Episode Two',
          evidenceType: 'TRANSCRIPT',
          evidenceText: 'He arrived at 8 p.m.',
          chunkText: 'He arrived at 8 p.m.',
          tags: [],
        },
      ],
    } as unknown as RagChatWorkflowState);

    expect(result.answer).toBe('He arrived at 8 p.m.');
    expect(
      JSON.parse(String(service.generateObject.mock.calls[0][0].userPrompt))
        .requiredEvidenceTypes,
    ).toEqual(['TRANSCRIPT']);
    expect(promptBuilder.build.mock.calls[0][0].route.requiredEvidence).toEqual(
      ['TRANSCRIPT'],
    );
  });

  it('retries a Groq JSON validation failure once with the answer repair prompt', async () => {
    const providerError = Object.assign(
      new Error('structured output invalid'),
      {
        code: 'STRUCTURED_COMPLETION_PROVIDER_ERROR',
        providerCode: 'json_validate_failed',
        transient: false,
      },
    );
    const service = {
      generateObject: jest
        .fn()
        .mockRejectedValueOnce(providerError)
        .mockResolvedValueOnce({
          answer: 'A blue car is parked.',
          claims: [{ claim: 'A blue car is parked.', evidenceIds: ['e0'] }],
        }),
    };
    const useCase = new GenerateDraftAnswerUseCase(
      service as never,
      { build: jest.fn(() => 'Grounding instructions.') },
      {
        model: () => 'test/test/answer',
        timeoutMs: () => 10_000,
        maxCompletionTokens: () => 1024,
        get: () => undefined,
      } as never,
    );

    const result = await useCase.execute({
      userMessage: 'What is visible in the frame?',
      route: {
        intent: 'REEL_VIDEO_QUESTION',
        reelQuestionType: 'VISUAL_CONTENT',
        requiredEvidence: ['VISUAL'],
        needsRetrieval: true,
      },
      contextSufficiency: {
        sufficient: true,
        availableEvidence: ['VISUAL'],
        missingEvidence: [],
        supportedEvidenceIds: ['e0'],
        recommendedAction: 'ANSWER',
      },
      rerankedChunks: [
        {
          chunkId: 'visual-1',
          reelId: 'reel-1',
          title: 'A Reel',
          evidenceType: 'VISUAL',
          evidenceText: 'A blue car is parked.',
          chunkText: 'A blue car is parked.',
          tags: [],
        },
      ],
    } as unknown as RagChatWorkflowState);

    expect(result.answer).toBe('A blue car is parked.');
    expect(service.generateObject).toHaveBeenCalledTimes(2);
    expect(service.generateObject.mock.calls[1][0].systemPrompt).toMatch(
      /failed structured-output validation/i,
    );
  });

  it('retries invalid structured output and falls back to supported source-attributed transcript segments', async () => {
    const invalidStructuredOutput = Object.assign(
      new Error('structured output validation failed'),
      {
        code: 'STRUCTURED_COMPLETION_PROVIDER_ERROR',
        providerCode: 'json_validate_failed',
        transient: false,
      },
    );
    const service = {
      generateObject: jest.fn().mockRejectedValue(invalidStructuredOutput),
    };
    const useCase = new GenerateDraftAnswerUseCase(
      service as never,
      { build: jest.fn(() => 'Grounding instructions.') },
      {
        model: () => 'test/test/answer',
        timeoutMs: () => 10_000,
        maxCompletionTokens: () => 1024,
        get: () => undefined,
      } as never,
    );

    const result = await useCase.execute({
      userMessage:
        'Compare the first indexed transcript segments of Episode One and Episode Two. Attribute each statement to its own clip.',
      route: {
        intent: 'REEL_VIDEO_QUESTION',
        reelQuestionType: 'TRANSCRIPT_CONTENT',
        requiredEvidence: ['TRANSCRIPT'],
        needsRetrieval: true,
      },
      retrievalPlan: {
        requiresReelCoverage: true,
        sourceOrder: 'ASC',
        mode: 'REEL_HYBRID',
        query: 'Compare the opening transcript segments.',
      },
      accessibleReelIds: ['reel-one', 'reel-two'],
      contextSufficiency: {
        sufficient: true,
        availableEvidence: ['TRANSCRIPT'],
        missingEvidence: [],
        supportedEvidenceIds: ['e0', 'e1'],
        recommendedAction: 'ANSWER',
      },
      retrievedChunks: [
        { chunkId: 'chunk-one', reelId: 'reel-one' },
        { chunkId: 'chunk-two', reelId: 'reel-two' },
      ],
      rerankedChunks: [
        {
          chunkId: 'chunk-one',
          reelId: 'reel-one',
          title: 'Episode One',
          evidenceType: 'TRANSCRIPT',
          startTime: 0,
          endTime: 30,
          evidenceText: 'Alice leaves the station after sunrise.',
          chunkText: 'Alice leaves the station after sunrise.',
          tags: [],
        },
        {
          chunkId: 'chunk-two',
          reelId: 'reel-two',
          title: 'Episode Two',
          evidenceType: 'TRANSCRIPT',
          startTime: 0,
          endTime: 30,
          evidenceText: 'Bob enters the courthouse before noon.',
          chunkText: 'Bob enters the courthouse before noon.',
          tags: [],
        },
      ],
    } as unknown as RagChatWorkflowState);

    expect(service.generateObject).toHaveBeenCalledTimes(2);
    expect(result.finalizationMode).toBe('EXTRACTIVE_EVIDENCE_FALLBACK');
    expect(result.answer).toContain('Episode One: Alice leaves the station');
    expect(result.answer).toContain('Episode Two: Bob enters the courthouse');
    expect(result.claims.map((claim) => claim.evidenceIds)).toEqual([
      ['e0'],
      ['e1'],
    ]);
    expect(result.generationEvidence?.map((item) => item.reelId)).toEqual([
      'reel-one',
      'reel-two',
    ]);
  });

  it('rejects a synthesized comparison whose claims omit one source Reel', async () => {
    const generateObject = jest.fn().mockResolvedValue({
      answer: 'Reel one shows a blue car.',
      claims: [{ claim: 'Reel one shows a blue car.', evidenceIds: ['e0'] }],
    });
    const useCase = new GenerateDraftAnswerUseCase(
      { generateObject } as never,
      { build: jest.fn(() => 'Grounding instructions.') },
      {
        model: () => 'test',
        timeoutMs: () => 10_000,
        maxCompletionTokens: () => 1024,
      } as never,
    );

    await expect(
      useCase.execute({
        userMessage: 'Compare the visual scenes in the two clips.',
        route: {
          intent: 'REEL_VIDEO_QUESTION',
          reelQuestionType: 'VISUAL_CONTENT',
          requiredEvidence: ['VISUAL'],
        },
        retrievalPlan: { requiresReelCoverage: true },
        contextSufficiency: {
          sufficient: true,
          availableEvidence: ['VISUAL'],
          missingEvidence: [],
          supportedEvidenceIds: ['e0', 'e1'],
          recommendedAction: 'ANSWER',
        },
        retrievedChunks: [
          { chunkId: 'visual-1', reelId: 'reel-1' },
          { chunkId: 'visual-2', reelId: 'reel-2' },
        ],
        rerankedChunks: [
          {
            chunkId: 'visual-1',
            reelId: 'reel-1',
            evidenceType: 'VISUAL',
            evidenceText: 'A blue car is parked.',
            chunkText: 'A blue car is parked.',
            tags: [],
          },
          {
            chunkId: 'visual-2',
            reelId: 'reel-2',
            evidenceType: 'VISUAL',
            evidenceText: 'A red bus is parked.',
            chunkText: 'A red bus is parked.',
            tags: [],
          },
        ],
      } as never),
    ).rejects.toThrow(/omit required Reel evidence/);
    expect(generateObject).toHaveBeenCalledTimes(2);
    expect(generateObject.mock.calls[0][0].systemPrompt).toMatch(
      /source-attributed claim for each requested Reel/i,
    );
    expect(generateObject.mock.calls[0][0].userPrompt).toContain(
      '"preserveReelCoverage":true',
    );
  });

  it('retries a multi-Reel multimodal answer when one Reel lacks a required modality claim', async () => {
    const generateObject = jest
      .fn()
      .mockResolvedValueOnce({
        answer:
          'In Reel one, the speaker says hello and a red door is visible. In Reel two, the speaker says goodbye.',
        claims: [
          {
            claim: 'In Reel one, the speaker says hello.',
            evidenceIds: ['e0'],
          },
          { claim: 'In Reel one, a red door is visible.', evidenceIds: ['e1'] },
          {
            claim: 'In Reel two, the speaker says goodbye.',
            evidenceIds: ['e2'],
          },
        ],
      })
      .mockResolvedValueOnce({
        answer:
          'In Reel one, the speaker says hello and a red door is visible. In Reel two, the speaker says goodbye and a blue window is visible.',
        claims: [
          {
            claim: 'In Reel one, the speaker says hello.',
            evidenceIds: ['e0'],
          },
          { claim: 'In Reel one, a red door is visible.', evidenceIds: ['e1'] },
          {
            claim: 'In Reel two, the speaker says goodbye.',
            evidenceIds: ['e2'],
          },
          {
            claim: 'In Reel two, a blue window is visible.',
            evidenceIds: ['e3'],
          },
        ],
      });
    const useCase = new GenerateDraftAnswerUseCase(
      { generateObject } as never,
      { build: jest.fn(() => 'Grounding instructions.') },
      {
        model: () => 'test',
        timeoutMs: () => 10_000,
        maxCompletionTokens: () => 1024,
      } as never,
    );

    const result = await useCase.execute({
      userMessage:
        'For each of both clips, tell me what is said and what is visible.',
      route: {
        intent: 'REEL_VIDEO_QUESTION',
        reelQuestionType: 'MULTIMODAL_CONTENT',
        requiredEvidence: ['TRANSCRIPT', 'VISUAL'],
        needsRetrieval: true,
      },
      retrievalPlan: { requiresReelCoverage: true },
      contextSufficiency: {
        sufficient: true,
        confidence: 1,
        availableEvidence: ['TRANSCRIPT', 'VISUAL'],
        missingEvidence: [],
        supportedEvidenceIds: ['e0', 'e1', 'e2', 'e3'],
        recommendedAction: 'ANSWER',
      },
      retrievedChunks: [
        { chunkId: 't1', reelId: 'reel-1' },
        { chunkId: 'v1', reelId: 'reel-1' },
        { chunkId: 't2', reelId: 'reel-2' },
        { chunkId: 'v2', reelId: 'reel-2' },
      ],
      rerankedChunks: [
        {
          chunkId: 't1',
          reelId: 'reel-1',
          evidenceType: 'TRANSCRIPT',
          evidenceText: 'In Reel one, the speaker says hello.',
          chunkText: 'In Reel one, the speaker says hello.',
          tags: [],
        },
        {
          chunkId: 'v1',
          reelId: 'reel-1',
          evidenceType: 'VISUAL',
          evidenceText: 'In Reel one, a red door is visible.',
          chunkText: 'In Reel one, a red door is visible.',
          tags: [],
        },
        {
          chunkId: 't2',
          reelId: 'reel-2',
          evidenceType: 'TRANSCRIPT',
          evidenceText: 'In Reel two, the speaker says goodbye.',
          chunkText: 'In Reel two, the speaker says goodbye.',
          tags: [],
        },
        {
          chunkId: 'v2',
          reelId: 'reel-2',
          evidenceType: 'VISUAL',
          evidenceText: 'In Reel two, a blue window is visible.',
          chunkText: 'In Reel two, a blue window is visible.',
          tags: [],
        },
      ],
    } as never);

    expect(generateObject).toHaveBeenCalledTimes(2);
    expect(generateObject.mock.calls[0][0].systemPrompt).toMatch(
      /each requested Reel.*every required modality/i,
    );
    expect(result.answer).toContain('a blue window is visible');
    expect(result.generationEvidence).toHaveLength(4);
  });

  it('uses separate authorized evidence when multimodal answer-contract validation fails', async () => {
    const evidence = [
      {
        evidenceId: 'e0',
        sourceId: 'transcript-1',
        reelId: 'reel-1',
        evidenceType: 'TRANSCRIPT' as const,
        evidenceText: 'The speaker says hello.',
      },
      {
        evidenceId: 'e1',
        sourceId: 'visual-1',
        reelId: 'reel-1',
        evidenceType: 'VISUAL' as const,
        evidenceText: 'A person waves.',
      },
    ];
    const service = {
      generateObject: jest.fn(
        (input: { onDiagnostics?: (value: never) => void }) => {
          input.onDiagnostics?.({
            modelRole: 'ANSWER',
            providerStatus: 200,
          } as never);
          return Promise.resolve({
            answer: 'The speaker says hello.',
            claims: [{ claim: 'The speaker says hello.', evidenceIds: ['e0'] }],
          });
        },
      ),
    };
    const useCase = new GenerateDraftAnswerUseCase(
      service as never,
      { build: jest.fn(() => 'Grounding instructions.') },
      {
        model: () => 'test',
        timeoutMs: () => 10_000,
        maxCompletionTokens: () => 1024,
      } as never,
    );

    const result = await useCase.execute({
      userMessage: 'Describe what is visible and what is said.',
      route: {
        intent: 'REEL_VIDEO_QUESTION',
        reelQuestionType: 'MULTIMODAL_CONTENT',
        requiredEvidence: ['TRANSCRIPT', 'VISUAL'],
      },
      contextSufficiency: {
        sufficient: true,
        supportedEvidenceIds: ['e0', 'e1'],
      },
      rerankedChunks: [
        {
          chunkId: 'transcript-1',
          reelId: 'reel-1',
          evidenceType: 'TRANSCRIPT',
          evidenceText: 'The speaker says hello.',
          chunkText: 'The speaker says hello.',
          tags: [],
        },
        {
          chunkId: 'visual-1',
          reelId: 'reel-1',
          evidenceType: 'VISUAL',
          evidenceText: 'A person waves.',
          chunkText: 'A person waves.',
          tags: [],
        },
      ],
    } as never);

    expect(result).toMatchObject({
      answer: 'Visible: A person waves.\nSpoken: The speaker says hello.',
      claims: [
        { claim: 'Visible: A person waves.', evidenceIds: ['e1'] },
        { claim: 'Spoken: The speaker says hello.', evidenceIds: ['e0'] },
      ],
      generationEvidence: evidence,
      finalizationMode: 'EXTRACTIVE_EVIDENCE_FALLBACK',
      fallbackReason: 'UNUSABLE_SYNTHESIS',
    });
    expect(service.generateObject).toHaveBeenCalledTimes(2);
  });

  it('retains evidence on generation errors when a safe fallback is unavailable', async () => {
    const service = {
      generateObject: jest.fn(
        (input: { onDiagnostics?: (value: never) => void }) => {
          input.onDiagnostics?.({
            modelRole: 'ANSWER',
            providerStatus: 200,
          } as never);
          return Promise.resolve({
            answer: 'A person waves.',
            claims: [],
          });
        },
      ),
    };
    const useCase = new GenerateDraftAnswerUseCase(
      service as never,
      { build: jest.fn(() => 'Grounding instructions.') },
      {
        model: () => 'test',
        timeoutMs: () => 10_000,
        maxCompletionTokens: () => 1024,
      } as never,
    );

    await expect(
      useCase.execute({
        userMessage: 'Describe the sampled frame.',
        route: {
          intent: 'REEL_VIDEO_QUESTION',
          reelQuestionType: 'VISUAL_CONTENT',
          requiredEvidence: ['VISUAL'],
        },
        contextSufficiency: {
          sufficient: true,
          supportedEvidenceIds: ['e0'],
        },
        rerankedChunks: [
          {
            chunkId: 'visual-1',
            reelId: 'reel-1',
            evidenceType: 'VISUAL',
            evidenceText: 'A person waves.',
            chunkText: 'A person waves.',
            tags: [],
          },
        ],
      } as never),
    ).rejects.toMatchObject({
      name: 'DraftAnswerGenerationError',
      generationEvidence: [
        expect.objectContaining({
          evidenceType: 'VISUAL',
          sourceId: 'visual-1',
        }),
      ],
    });
  });

  it('omits unsupported claims that no readable text is visible', async () => {
    const objectClaim = 'An orange tabby cat is in a hallway.';
    const generateObject = jest.fn().mockResolvedValue({
      answer: `${objectClaim} No readable text is present.`,
      claims: [
        { claim: objectClaim, evidenceIds: ['e0'] },
        { claim: 'No readable text is present.', evidenceIds: ['e0'] },
      ],
    });
    const useCase = new GenerateDraftAnswerUseCase(
      { generateObject } as never,
      { build: jest.fn(() => 'Grounding instructions.') },
      {
        model: () => 'test',
        timeoutMs: () => 10_000,
        maxCompletionTokens: () => 1024,
      } as never,
    );

    const result = await useCase.execute({
      userMessage:
        'What is visible in the sampled frame? Separate readable text from objects.',
      route: {
        intent: 'REEL_VIDEO_QUESTION',
        reelQuestionType: 'VISUAL_CONTENT',
        requiredEvidence: ['VISUAL'],
      },
      contextSufficiency: { sufficient: true, supportedEvidenceIds: ['e0'] },
      rerankedChunks: [
        {
          chunkId: 'visual-1',
          reelId: 'reel-1',
          evidenceType: 'VISUAL',
          evidenceText: 'An orange tabby cat in a hallway.',
          chunkText: 'An orange tabby cat in a hallway.',
          tags: [],
        },
      ],
    } as never);

    expect(result.answer).toBe(objectClaim);
    expect(result.claims).toEqual([
      { claim: objectClaim, evidenceIds: ['e0'] },
    ]);
  });

  it('preserves a readable-text absence claim when the visual evidence states it', async () => {
    const answer = 'No readable text is visible.';
    const generateObject = jest.fn().mockResolvedValue({
      answer,
      claims: [{ claim: answer, evidenceIds: ['e0'] }],
    });
    const useCase = new GenerateDraftAnswerUseCase(
      { generateObject } as never,
      { build: jest.fn(() => 'Grounding instructions.') },
      {
        model: () => 'test',
        timeoutMs: () => 10_000,
        maxCompletionTokens: () => 1024,
      } as never,
    );

    const result = await useCase.execute({
      userMessage: 'Is readable text visible?',
      route: {
        intent: 'REEL_VIDEO_QUESTION',
        reelQuestionType: 'VISUAL_CONTENT',
        requiredEvidence: ['VISUAL'],
      },
      contextSufficiency: { sufficient: true, supportedEvidenceIds: ['e0'] },
      rerankedChunks: [
        {
          chunkId: 'visual-1',
          reelId: 'reel-1',
          evidenceType: 'VISUAL',
          evidenceText:
            'A sampled-frame review says no readable text is visible.',
          chunkText: 'A sampled-frame review says no readable text is visible.',
          tags: [],
        },
      ],
    } as never);

    expect(result.answer).toBe(answer);
  });

  it('answers an explicit first indexed sentence from the beginning rather than choosing a later sentence', async () => {
    const generateObject = jest.fn().mockResolvedValue({
      selectedSentenceCandidateId: 'sentence-1',
    });
    const useCase = new GenerateDraftAnswerUseCase(
      { generateObject } as never,
      { build: jest.fn() },
      {
        model: () => 'test',
        timeoutMs: () => 10_000,
        maxCompletionTokens: () => 1024,
      } as never,
    );
    const result = await useCase.execute({
      userMessage:
        'What is the first complete sentence recorded in the indexed transcript?',
      route: {
        intent: 'REEL_VIDEO_QUESTION',
        reelQuestionType: 'TRANSCRIPT_CONTENT',
        requiredEvidence: ['TRANSCRIPT'],
        needsRetrieval: true,
      },
      retrievalPlan: {},
      rerankedChunks: [
        {
          chunkId: 'c0',
          reelId: 'r',
          evidenceType: 'TRANSCRIPT',
          startTime: 0,
          endTime: 10,
          evidenceText: 'The episode begins here! Please, take him.',
          chunkText: 'The episode begins here! Please, take him.',
          tags: [],
          distance: null,
        },
      ],
    } as never);
    expect(result.answer).toBe('The episode begins here!');
    expect(result.generationEvidence?.[0].evidenceText).toBe(
      'The episode begins here! Please, take him.',
    );
    expect(result.claims).toEqual([
      { claim: 'The episode begins here!', evidenceIds: ['e0'] },
    ]);
    expect(generateObject).toHaveBeenCalledTimes(1);
  });
  it('keeps complete canonical metadata values beyond ordinary prompt preview limits', async () => {
    const title = 't'.repeat(220);
    const tags = Array.from({ length: 30 }, (_, i) => `tag-${i}`);
    const useCase = new GenerateDraftAnswerUseCase(
      { generateObject: jest.fn() } as never,
      { build: jest.fn() },
      { model: () => 'test', maxCompletionTokens: () => 1024 } as never,
    );
    const input = {
      route: {
        intent: 'REEL_VIDEO_QUESTION',
        reelQuestionType: 'REEL_METADATA',
        requiredEvidence: ['METADATA'],
      },
      rerankedChunks: [
        {
          chunkId: 'doc',
          reelId: 'r',
          evidenceType: 'METADATA',
          title,
          tags,
          evidenceText: `Title: ${title}. Tags: ${tags.join(', ')}`,
          chunkText: '',
          distance: null,
        },
      ],
    };
    const titleResult = await useCase.execute({
      ...input,
      userMessage: 'What title is assigned to this Reel?',
    } as never);
    expect(titleResult.answer).toBe(title);
    const tagResult = await useCase.execute({
      ...input,
      userMessage: 'Which tags are associated with this Reel?',
    } as never);
    expect(tagResult.answer).toBe(tags.join(', '));
    expect(tagResult.generationEvidence?.[0].evidenceText).toBe(
      `Tags: ${tags.join(', ')}`,
    );
  });

  it('answers an explicit transcript time-window question from the matching source span', async () => {
    const generateObject = jest.fn();
    const useCase = new GenerateDraftAnswerUseCase(
      { generateObject } as never,
      { build: jest.fn() },
      {
        model: () => 'test',
        timeoutMs: () => 10_000,
        maxCompletionTokens: () => 1024,
      } as never,
    );
    const result = await useCase.execute({
      userMessage: 'What is said in the transcript segment at 11.68 seconds?',
      route: {
        intent: 'REEL_VIDEO_QUESTION',
        reelQuestionType: 'TRANSCRIPT_CONTENT',
        requiredEvidence: ['TRANSCRIPT'],
        needsRetrieval: true,
      },
      retrievalPlan: { sourceOrder: 'ASC', sourceTimestampSec: 11.68 },
      rerankedChunks: [
        {
          chunkId: 'c-window',
          reelId: 'r',
          evidenceType: 'TRANSCRIPT',
          startTime: 11.68,
          endTime: 56.38,
          evidenceText: 'The speaker names the blue device.',
          chunkText: 'The speaker names the blue device.',
          tags: [],
          distance: null,
        },
      ],
    } as never);
    expect(result.answer).toBe('The speaker names the blue device.');
    expect(result.generationEvidence?.[0].sourceId).toBe('c-window');
    expect(generateObject).not.toHaveBeenCalled();
  });

  it('extracts an exact quote from the full source before prompt evidence truncation', async () => {
    const generateObject = jest
      .fn()
      .mockResolvedValue({ selectedSentenceCandidateId: 'sentence-1' });
    const useCase = new GenerateDraftAnswerUseCase(
      { generateObject } as never,
      { build: jest.fn() },
      {
        model: () => 'test',
        timeoutMs: () => 10_000,
        maxCompletionTokens: () => 1024,
      } as never,
    );
    const fullText =
      'The dog came back. ' +
      'Unrelated dialogue. '.repeat(1_000) +
      'The transcript segment spanning the requested range contains other dialogue.';
    const result = await useCase.execute({
      userMessage:
        'Quote the first complete sentence in the indexed transcript segment spanning 0-100 seconds.',
      route: {
        intent: 'REEL_VIDEO_QUESTION',
        reelQuestionType: 'TRANSCRIPT_CONTENT',
        requiredEvidence: ['TRANSCRIPT'],
        needsRetrieval: true,
      },
      contextSufficiency: { sufficient: true, supportedEvidenceIds: ['e0'] },
      rerankedChunks: [
        {
          chunkId: 'long-window',
          reelId: 'r',
          evidenceType: 'TRANSCRIPT',
          startTime: 0,
          endTime: 100,
          evidenceText: fullText,
          chunkText: fullText,
          tags: [],
          distance: null,
        },
      ],
    } as never);

    expect(generateObject).toHaveBeenCalledTimes(1);
    expect(result.answer).toBe('The dog came back.');
    expect(result.generationEvidence?.[0].sourceId).toBe('long-window');
    expect(result.generationEvidence?.[0].evidenceText).toBe(fullText);
    const prompt = JSON.parse(
      generateObject.mock.calls[0][0].userPrompt as string,
    ) as {
      authorizedEvidence: Array<{
        evidenceText?: string;
        orderedSentenceCandidates?: Array<{
          candidateId: string;
          ordinal: number;
          text: string;
        }>;
      }>;
    };
    const promptEvidence = prompt.authorizedEvidence[0];
    const candidates = promptEvidence.orderedSentenceCandidates ?? [];
    expect(promptEvidence).not.toHaveProperty('evidenceText');
    expect(candidates.slice(0, 2)).toEqual([
      { candidateId: 'sentence-1', ordinal: 1, text: 'The dog came back.' },
      { candidateId: 'sentence-2', ordinal: 2, text: 'Unrelated dialogue.' },
    ]);
    expect(generateObject.mock.calls[0][0].jsonSchema).toMatchObject({
      required: ['selectedSentenceCandidateId'],
      properties: {
        selectedSentenceCandidateId: {
          enum: expect.arrayContaining(['sentence-1', 'sentence-2']),
        },
      },
    });
    expect(generateObject.mock.calls[0][0].systemPrompt).toMatch(
      /choose the earliest independent utterance within the requested source interval/i,
    );
    expect(generateObject.mock.calls[0][0].systemPrompt).toMatch(
      /contextOnlyTranscript only to determine whether an opening candidate continues speech/i,
    );
    expect(generateObject.mock.calls[0][0].systemPrompt).toMatch(
      /exhaustive grounding audit/i,
    );
  });

  it('corrects an obvious opening fragment returned by the sentence selector', async () => {
    const generateObject = jest
      .fn()
      .mockResolvedValue({ selectedSentenceCandidateId: 'sentence-1' });
    const useCase = new GenerateDraftAnswerUseCase(
      { generateObject } as never,
      { build: jest.fn() },
      {
        model: () => 'test',
        timeoutMs: () => 10_000,
        maxCompletionTokens: () => 1024,
      } as never,
    );
    const result = await useCase.execute({
      userMessage:
        'Quote the first complete sentence in the indexed transcript segment spanning 0-60 seconds.',
      route: {
        intent: 'REEL_VIDEO_QUESTION',
        reelQuestionType: 'TRANSCRIPT_CONTENT',
        requiredEvidence: ['TRANSCRIPT'],
        needsRetrieval: true,
      },
      contextSufficiency: { sufficient: true, supportedEvidenceIds: ['e0'] },
      rerankedChunks: [
        {
          chunkId: 'quote-window',
          reelId: 'r',
          evidenceType: 'TRANSCRIPT',
          startTime: 0,
          endTime: 60,
          evidenceText: 'the red notebook! Where is it? The train is outside.',
          chunkText: 'the red notebook! Where is it? The train is outside.',
          tags: [],
          distance: null,
        },
      ],
    } as never);

    expect(generateObject).toHaveBeenCalledTimes(1);
    expect(result.answer).toBe('Where is it?');
    expect(result.generationEvidence?.[0].evidenceText).toBe(
      'the red notebook! Where is it? The train is outside.',
    );
  });

  it('omits a leading transcript span that starts before the requested interval', async () => {
    const generateObject = jest
      .fn()
      .mockResolvedValue({ selectedSentenceCandidateId: 'sentence-1' });
    const useCase = new GenerateDraftAnswerUseCase(
      { generateObject } as never,
      { build: jest.fn() },
      {
        model: () => 'test',
        timeoutMs: () => 10_000,
        maxCompletionTokens: () => 1024,
      } as never,
    );
    const result = await useCase.execute({
      userMessage:
        'Quote the first complete sentence in the indexed transcript segment spanning 0.82-51.6 seconds.',
      route: {
        intent: 'REEL_VIDEO_QUESTION',
        reelQuestionType: 'TRANSCRIPT_CONTENT',
        requiredEvidence: ['TRANSCRIPT'],
        needsRetrieval: true,
      },
      contextSufficiency: { sufficient: true, supportedEvidenceIds: ['e0'] },
      rerankedChunks: [
        {
          chunkId: 'overlapping-window',
          reelId: 'r',
          evidenceType: 'TRANSCRIPT',
          startTime: 0.64,
          endTime: 45.44,
          evidenceText:
            'A phrase begun before the requested interval. The first complete sentence inside it. A later sentence.',
          chunkText:
            'A phrase begun before the requested interval. The first complete sentence inside it. A later sentence.',
          tags: [],
          distance: null,
        },
      ],
    } as never);

    expect(result.answer).toBe('The first complete sentence inside it.');
    const prompt = JSON.parse(
      generateObject.mock.calls[0][0].userPrompt as string,
    ) as {
      authorizedEvidence: Array<{
        orderedSentenceCandidates?: Array<{
          candidateId: string;
          ordinal: number;
          text: string;
        }>;
      }>;
    };
    expect(prompt.authorizedEvidence[0].orderedSentenceCandidates).toEqual([
      {
        candidateId: 'sentence-1',
        ordinal: 2,
        text: 'The first complete sentence inside it.',
      },
      {
        candidateId: 'sentence-2',
        ordinal: 3,
        text: 'A later sentence.',
      },
    ]);
  });

  it('uses verifier feedback instead of repeating the initial extractive quote on revision', async () => {
    const generateObject = jest
      .fn()
      .mockResolvedValue({ selectedSentenceCandidateId: 'sentence-3' });
    const useCase = new GenerateDraftAnswerUseCase(
      { generateObject } as never,
      { build: jest.fn(() => 'Use the verifier revision instruction.') },
      {
        model: () => 'test',
        timeoutMs: () => 10_000,
        maxCompletionTokens: () => 1024,
      } as never,
    );
    const result = await useCase.execute({
      userMessage:
        'Quote the first complete sentence in the indexed transcript segment spanning 29.46-74.2 seconds.',
      route: {
        intent: 'REEL_VIDEO_QUESTION',
        reelQuestionType: 'TRANSCRIPT_CONTENT',
        requiredEvidence: ['TRANSCRIPT'],
        needsRetrieval: true,
      },
      nextDraftSource: 'VERIFIER_REVISION',
      verification: {
        passed: false,
        confidence: 0.5,
        issues: ['The initial quote is a fragment.'],
        requiresRevision: true,
        revisedInstruction:
          'Quote the first complete sentence after the opening fragment.',
      },
      contextSufficiency: { sufficient: true, supportedEvidenceIds: ['e0'] },
      rerankedChunks: [
        {
          chunkId: 'quote-window',
          reelId: 'r',
          evidenceType: 'TRANSCRIPT',
          startTime: 29.46,
          endTime: 74.2,
          evidenceText:
            'client. asking about pets. Avery thought for a second and said no.',
          chunkText:
            'client. asking about pets. Avery thought for a second and said no.',
          tags: [],
          distance: null,
        },
      ],
    } as never);

    expect(result.answer).toBe('Avery thought for a second and said no.');
    expect(generateObject).toHaveBeenCalledTimes(1);
  });

  it('requests source wording and sufficient budget for first-segment comparisons', async () => {
    const answer =
      'Episode One: A scientist enters the room. Episode Two: The child runs outside.';
    const segmentTail = 'The visitor then explains the laboratory rules.';
    const firstSegmentText = `A scientist enters the room. ${'The visitor describes the room. '.repeat(20)}${segmentTail}`;
    const generateObject = jest.fn().mockResolvedValue({
      answer,
      claims: [
        { claim: 'A scientist enters the room.', evidenceIds: ['e0'] },
        { claim: 'The child runs outside.', evidenceIds: ['e1'] },
      ],
    });
    const useCase = new GenerateDraftAnswerUseCase(
      { generateObject } as never,
      { build: jest.fn() },
      {
        model: () => 'test',
        timeoutMs: () => 10_000,
        maxCompletionTokens: () => 512,
      } as never,
    );
    const result = await useCase.execute({
      userMessage:
        'Compare the first indexed transcript segments of Episode One and Episode Two. Attribute each statement to its own clip.',
      route: {
        intent: 'REEL_VIDEO_QUESTION',
        reelQuestionType: 'TRANSCRIPT_CONTENT',
        requiredEvidence: ['TRANSCRIPT'],
        needsRetrieval: true,
      },
      retrievalPlan: {
        requiresReelCoverage: true,
        sourceOrder: 'ASC',
        mode: 'REEL_HYBRID',
        query: 'Compare the opening transcript segments.',
      },
      accessibleReelIds: ['reel-1', 'reel-2'],
      contextSufficiency: {
        sufficient: true,
        availableEvidence: ['TRANSCRIPT'],
        missingEvidence: [],
        supportedEvidenceIds: ['e0', 'e1'],
        recommendedAction: 'ANSWER',
      },
      rerankedChunks: [
        {
          chunkId: 'transcript-one',
          reelId: 'reel-1',
          title: 'Episode One',
          evidenceType: 'TRANSCRIPT',
          startTime: 0,
          endTime: 30,
          evidenceText: firstSegmentText,
          chunkText: firstSegmentText,
          tags: [],
          distance: null,
        },
        {
          chunkId: 'transcript-two',
          reelId: 'reel-2',
          title: 'Episode Two',
          evidenceType: 'TRANSCRIPT',
          startTime: 0,
          endTime: 30,
          evidenceText: 'The child runs outside.',
          chunkText: 'The child runs outside.',
          tags: [],
          distance: null,
        },
      ],
    } as never);

    const call = generateObject.mock.calls[0][0];
    expect(result.answer).toBe(answer);
    expect(call.systemPrompt).toMatch(
      /quote the complete earliest transcript segment from each Reel/i,
    );
    expect(call.systemPrompt).toMatch(
      /one concise comparison grounded in those passages/i,
    );
    expect(JSON.parse(String(call.userPrompt)).answerShape).toBe('SUMMARY');
    expect(call.jsonSchema.properties.answer).toMatchObject({
      maxLength: MULTI_REEL_TRANSCRIPT_COMPARISON_MAX_CHARS,
    });
    expect(call.maxTokens).toBe(1024);
    const prompt = JSON.parse(String(call.userPrompt)) as {
      authorizedEvidence: Array<{ evidenceText: string }>;
    };
    expect(prompt.authorizedEvidence[0].evidenceText).toContain(segmentTail);
  });

  it('summarizes a requested transcript interval across its main turns', async () => {
    const answer =
      'Visible: A person stands in the room. Spoken: The speaker describes the plan and asks the other person to leave.';
    const generateObject = jest.fn().mockResolvedValue({
      answer,
      claims: [
        {
          claim: 'A person stands in the room.',
          evidenceIds: ['e0'],
        },
        {
          claim:
            'The speaker describes the plan and asks the other person to leave.',
          evidenceIds: ['e1'],
        },
      ],
    });
    const useCase = new GenerateDraftAnswerUseCase(
      { generateObject } as never,
      { build: jest.fn() },
      {
        model: () => 'test',
        timeoutMs: () => 10_000,
        maxCompletionTokens: () => 512,
      } as never,
    );
    const result = await useCase.execute({
      userMessage:
        'Describe the sampled frame and summarize the indexed speech segment at 0.38-59.98 seconds.',
      route: {
        intent: 'REEL_VIDEO_QUESTION',
        reelQuestionType: 'MULTIMODAL_CONTENT',
        requiredEvidence: ['VISUAL', 'TRANSCRIPT'],
        needsRetrieval: true,
      },
      contextSufficiency: {
        sufficient: true,
        availableEvidence: ['VISUAL', 'TRANSCRIPT'],
        missingEvidence: [],
        supportedEvidenceIds: ['e0', 'e1'],
        recommendedAction: 'ANSWER',
      },
      rerankedChunks: [
        {
          chunkId: 'visual-frame',
          reelId: 'reel-1',
          evidenceType: 'VISUAL',
          startTime: 48,
          endTime: 48,
          evidenceText: 'A person stands in the room.',
          chunkText: 'A person stands in the room.',
          tags: [],
          distance: null,
        },
        {
          chunkId: 'speech-segment',
          reelId: 'reel-1',
          evidenceType: 'TRANSCRIPT',
          startTime: 0.38,
          endTime: 44,
          evidenceText:
            'The speaker describes the plan. The other person asks for details. The speaker asks the other person to leave.',
          chunkText:
            'The speaker describes the plan. The other person asks for details. The speaker asks the other person to leave.',
          tags: [],
          distance: null,
        },
      ],
    } as never);

    const call = generateObject.mock.calls[0][0];
    expect(result.answer).toBe(answer);
    expect(call.systemPrompt).toMatch(
      /use concise paraphrase instead of reproducing the transcript verbatim/i,
    );
    const prompt = JSON.parse(String(call.userPrompt));
    expect(prompt.answerShape).toBe('SUMMARY');
    expect(prompt.maxAnswerChars).toBe(
      call.jsonSchema.properties.answer.maxLength,
    );
    expect(call.jsonSchema.properties.answer).toMatchObject({
      maxLength: transcriptSegmentPromptBounds(
        DEFAULT_RAG_PROMPT_BOUNDS,
        'SUMMARY',
      ).maxEvidenceTotalChars,
    });
    expect(call.maxTokens).toBe(1024);
  });

  it('returns an exact indexed interval for a transcript time range', async () => {
    const generateObject = jest.fn().mockResolvedValue({
      answer: 'The speaker names the blue device.',
      claims: [
        { claim: 'The speaker names the blue device.', evidenceIds: ['e0'] },
      ],
    });
    const useCase = new GenerateDraftAnswerUseCase(
      { generateObject } as never,
      { build: jest.fn(() => 'Grounding instructions.') },
      {
        model: () => 'test',
        timeoutMs: () => 10_000,
        maxCompletionTokens: () => 1024,
      } as never,
    );
    const result = await useCase.execute({
      userMessage:
        'Summarize what is said in the transcript segment spanning 11.68-56.38 seconds of the shared Reel.',
      route: {
        intent: 'REEL_VIDEO_QUESTION',
        reelQuestionType: 'TRANSCRIPT_CONTENT',
        requiredEvidence: ['TRANSCRIPT'],
        needsRetrieval: true,
      },
      retrievalPlan: {
        sourceOrder: 'ASC',
        sourceTimestampSec: 11.68,
        sourceTimestampEndSec: 56.38,
      },
      contextSufficiency: {
        sufficient: true,
        supportedEvidenceIds: ['e0'],
      },
      rerankedChunks: [
        {
          chunkId: 'c-window',
          reelId: 'r',
          evidenceType: 'TRANSCRIPT',
          startTime: 11.68,
          endTime: 56.38,
          evidenceText: 'The speaker names the blue device.',
          chunkText: 'The speaker names the blue device.',
          tags: [],
          distance: null,
        },
      ],
    } as never);

    expect(result.answer).toBe('The speaker names the blue device.');
    expect(result.finalizationMode).toBe('SYNTHESIZED');
    expect(result.claims[0].evidenceIds).toEqual(['e0']);
    expect(generateObject).not.toHaveBeenCalled();
  });

  it('chooses the chunk aligned to a requested range before overlapping chunks', async () => {
    const generateObject = jest
      .fn()
      .mockResolvedValue({ selectedSentenceCandidateId: 'sentence-2' });
    const useCase = new GenerateDraftAnswerUseCase(
      { generateObject } as never,
      { build: jest.fn() },
      {
        model: () => 'test',
        timeoutMs: () => 10_000,
        maxCompletionTokens: () => 1024,
      } as never,
    );
    const result = await useCase.execute({
      userMessage:
        'Quote the first complete sentence in the indexed transcript segment spanning 9.52–62.28 seconds of the shared Reel.',
      route: {
        intent: 'REEL_VIDEO_QUESTION',
        reelQuestionType: 'TRANSCRIPT_CONTENT',
        requiredEvidence: ['TRANSCRIPT'],
        needsRetrieval: true,
      },
      contextSufficiency: {
        sufficient: true,
        supportedEvidenceIds: ['e1'],
      },
      retrievalPlan: {},
      rerankedChunks: [
        {
          chunkId: 'overlap',
          reelId: 'r',
          evidenceType: 'TRANSCRIPT',
          startTime: 9.06,
          endTime: 76.25734,
          evidenceText: 'that he grew up here. Get away from me.',
          chunkText: 'that he grew up here. Get away from me.',
          tags: [],
          distance: null,
        },
        {
          chunkId: 'aligned',
          reelId: 'r',
          evidenceType: 'TRANSCRIPT',
          startTime: 9.52,
          endTime: 62.28,
          evidenceText: 'grew up here. Get away from me.',
          chunkText: 'grew up here. Get away from me.',
          tags: [],
          distance: null,
        },
      ],
    } as never);
    expect(result.answer).toBe('Get away from me.');
    expect(result.claims[0].evidenceIds).toEqual(['e1']);
    expect(result.generationEvidence?.[0].sourceId).toBe('aligned');
    const prompt = JSON.parse(
      generateObject.mock.calls[0][0].userPrompt as string,
    ) as {
      authorizedEvidence: Array<{
        sourceId: string;
        contextOnlyTranscript?: string;
        orderedSentenceCandidates?: Array<{ text: string }>;
      }>;
    };
    const boundaryContext = prompt.authorizedEvidence.find(
      (item) => item.sourceId === 'overlap',
    );
    expect(boundaryContext?.contextOnlyTranscript).toContain(
      'that he grew up here.',
    );
    expect(boundaryContext).not.toHaveProperty('orderedSentenceCandidates');
    expect(
      prompt.authorizedEvidence.find((item) => item.sourceId === 'aligned')
        ?.orderedSentenceCandidates,
    ).toHaveLength(2);
    expect(generateObject).toHaveBeenCalledTimes(1);
  });

  it('asks for source wording and a larger budget for first-segment comparisons', async () => {
    const answer =
      'Episode One: A scientist enters the room. Episode Two: The child runs outside.';
    const generateObject = jest.fn().mockResolvedValue({
      answer,
      claims: [
        { claim: 'A scientist enters the room.', evidenceIds: ['e0'] },
        { claim: 'The child runs outside.', evidenceIds: ['e1'] },
      ],
    });
    const useCase = new GenerateDraftAnswerUseCase(
      { generateObject } as never,
      { build: jest.fn() },
      {
        model: () => 'test',
        timeoutMs: () => 10_000,
        maxCompletionTokens: () => 512,
      } as never,
    );
    const result = await useCase.execute({
      userMessage:
        'Compare the first indexed transcript segments of Episode One and Episode Two. Attribute each statement to its own clip.',
      route: {
        intent: 'REEL_VIDEO_QUESTION',
        reelQuestionType: 'TRANSCRIPT_CONTENT',
        requiredEvidence: ['TRANSCRIPT'],
        needsRetrieval: true,
      },
      retrievalPlan: {
        requiresReelCoverage: true,
        sourceOrder: 'ASC',
        mode: 'REEL_HYBRID',
        query: 'Compare the opening transcript segments.',
      },
      accessibleReelIds: ['reel-1', 'reel-2'],
      contextSufficiency: {
        sufficient: true,
        availableEvidence: ['TRANSCRIPT'],
        missingEvidence: [],
        supportedEvidenceIds: ['e0', 'e1'],
        recommendedAction: 'ANSWER',
      },
      rerankedChunks: [
        {
          chunkId: 'transcript-one',
          reelId: 'reel-1',
          title: 'Episode One',
          evidenceType: 'TRANSCRIPT',
          startTime: 0,
          endTime: 30,
          evidenceText: 'A scientist enters the room.',
          chunkText: 'A scientist enters the room.',
          tags: [],
          distance: null,
        },
        {
          chunkId: 'transcript-two',
          reelId: 'reel-2',
          title: 'Episode Two',
          evidenceType: 'TRANSCRIPT',
          startTime: 0,
          endTime: 30,
          evidenceText: 'The child runs outside.',
          chunkText: 'The child runs outside.',
          tags: [],
          distance: null,
        },
      ],
    } as never);

    expect(result.answer).toBe(answer);
    expect(generateObject.mock.calls[0][0].systemPrompt).toMatch(
      /quote the complete earliest transcript segment from each Reel/i,
    );
    expect(generateObject.mock.calls[0][0].systemPrompt).toMatch(
      /one concise comparison grounded in those passages/i,
    );
    expect(
      JSON.parse(String(generateObject.mock.calls[0][0].userPrompt))
        .answerShape,
    ).toBe('SUMMARY');
    expect(
      generateObject.mock.calls[0][0].jsonSchema.properties.answer,
    ).toMatchObject({
      maxLength: MULTI_REEL_TRANSCRIPT_COMPARISON_MAX_CHARS,
    });
    expect(generateObject.mock.calls[0][0].maxTokens).toBe(1024);
  });

  it('returns the complete indexed interval with separate visual and speech evidence', async () => {
    const generateObject = jest.fn();
    const useCase = new GenerateDraftAnswerUseCase(
      { generateObject } as never,
      { build: jest.fn() },
      {
        model: () => 'test',
        timeoutMs: () => 10_000,
        maxCompletionTokens: () => 512,
      } as never,
    );
    const segmentTail = 'The transcript ends with a final plan review.';
    const speechEvidence = `${'The speaker describes the plan. '.repeat(20)}The speaker asks the other person to leave. ${segmentTail}`;
    const result = await useCase.execute({
      userMessage:
        'Describe the sampled frame at 48 seconds and summarize the indexed speech segment at 0.38-59.98 seconds.',
      route: {
        intent: 'REEL_VIDEO_QUESTION',
        reelQuestionType: 'MULTIMODAL_CONTENT',
        requiredEvidence: ['VISUAL', 'TRANSCRIPT'],
        needsRetrieval: true,
      },
      contextSufficiency: {
        sufficient: true,
        availableEvidence: ['VISUAL', 'TRANSCRIPT'],
        missingEvidence: [],
        supportedEvidenceIds: ['e0', 'e1'],
        recommendedAction: 'ANSWER',
      },
      rerankedChunks: [
        {
          chunkId: 'visual-frame',
          reelId: 'reel-1',
          evidenceType: 'VISUAL',
          startTime: 48,
          endTime: 48,
          evidenceText: 'A person stands in the room.',
          chunkText: 'A person stands in the room.',
          tags: [],
          distance: null,
        },
        {
          chunkId: 'speech-segment',
          reelId: 'reel-1',
          evidenceType: 'TRANSCRIPT',
          startTime: 0.38,
          endTime: 59.98,
          evidenceText: speechEvidence,
          chunkText: speechEvidence,
          tags: [],
          distance: null,
        },
      ],
    } as never);

    expect(result.answer).toBe(
      `Visible: A person stands in the room.\n\nSaid: ${speechEvidence}`,
    );
    const visualEvidenceId = result.generationEvidence?.find(
      (item) => item.evidenceType === 'VISUAL',
    )?.evidenceId;
    const transcriptEvidenceId = result.generationEvidence?.find(
      (item) => item.evidenceType === 'TRANSCRIPT',
    )?.evidenceId;
    expect(result.claims).toEqual([
      {
        claim: 'Visible: A person stands in the room.',
        evidenceIds: [visualEvidenceId],
      },
      {
        claim: `Said: ${speechEvidence}`,
        evidenceIds: [transcriptEvidenceId],
      },
    ]);
    expect(result.generationEvidence).toMatchObject([
      {
        evidenceType: 'VISUAL',
        evidenceText: 'A person stands in the room.',
      },
      { evidenceType: 'TRANSCRIPT', evidenceText: speechEvidence },
    ]);
    expect(generateObject).not.toHaveBeenCalled();
  });

  it.each([
    'What title is assigned to this Reel?',
    'Which tags are associated with this Reel?',
  ])(
    'answers exact typed metadata without synthesizing unrelated transcript: %s',
    async (question) => {
      const service = { generateObject: jest.fn() };
      const useCase = new GenerateDraftAnswerUseCase(
        service as never,
        { build: jest.fn() },
        { model: () => 'test', maxCompletionTokens: () => 1024 } as never,
      );
      const result = await useCase.execute({
        userMessage: question,
        route: {
          intent: 'REEL_VIDEO_QUESTION',
          reelQuestionType: 'REEL_METADATA',
          requiredEvidence: ['METADATA'],
        },
        rerankedChunks: [
          {
            chunkId: 'document',
            reelId: 'r',
            evidenceType: 'METADATA',
            evidenceText: 'Title: Canonical title. Tags: canonical',
            chunkText: 'Title: Canonical title. Tags: canonical',
            title: 'Canonical title',
            tags: ['canonical'],
            distance: null,
          },
        ],
      } as never);
      expect(result.answer).toBe(
        question.includes('title') ? 'Canonical title' : 'canonical',
      );
      expect(result.generationEvidence?.[0].sourceId).toBe('document');
      expect(service.generateObject).not.toHaveBeenCalled();
    },
  );
  const config = {
    get: jest.fn().mockReturnValue(undefined),
    model: jest.fn(() => 'test/test/answer'),
    timeoutMs: jest.fn(() => 10_000),
    maxCompletionTokens: jest.fn(() => 1_536),
  } as unknown as IAiApplicationConfig;
  const promptBuilder = { build: jest.fn(() => 'Grounding instructions.') };
  const state = {
    userMessage: 'What relation is asserted?',
    route: {
      intent: 'REEL_VIDEO_QUESTION',
      reelQuestionType: 'TRANSCRIPT_CONTENT',
    },
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
      finalizationMode: 'SYNTHESIZED',
      generationEvidence: expect.arrayContaining([
        expect.objectContaining({
          evidenceId: 'e0',
          evidenceText: 'The zorb is coupled to the quasar.',
        }),
      ]),
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
      maxLength: 900,
    });
    expect(request.userPrompt).toContain('"answerShape":"EXPLANATION"');
    expect(request.userPrompt).toContain('"maxAnswerChars":900');
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
    expect(request.systemPrompt).toContain(
      'reuse its distinctive nouns, names, values, and relations',
    );
    expect(request.systemPrompt).toContain('shortest complete form');
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
    {
      name: 'entity',
      question: 'Who supervised the project?',
      evidence: 'Jean-Marc supervised the project.',
      answer: 'Jean-Marc supervised the project.',
    },
    {
      name: 'number',
      question: 'How many backups do they keep?',
      evidence: 'They keep 3 backups.',
      answer: 'They keep 3 backups.',
    },
    {
      name: 'short fact',
      question: 'What storage medium is mentioned?',
      evidence: 'The speaker mentions optical discs.',
      answer: 'The speaker mentions optical discs.',
    },
    {
      name: 'compound question',
      question: 'Who supervised the project, and when did it begin?',
      evidence: 'Jean-Marc supervised the project, which began in 2024.',
      answer: 'Jean-Marc supervised the project, which began in 2024.',
    },
    {
      name: 'non-English explanation',
      question: 'Tại sao nhóm chuyển sang TypeScript?',
      evidence: 'Nhóm chuyển sang TypeScript để giảm lỗi kiểu dữ liệu.',
      answer: 'Nhóm chuyển sang TypeScript để giảm lỗi kiểu dữ liệu.',
    },
  ])(
    'uses the semantic transcript-content budget for a $name question',
    async (fixture) => {
      const service = {
        generateObject: jest.fn().mockResolvedValue({
          answer: fixture.answer,
          claims: [{ claim: fixture.answer, evidenceIds: ['e0'] }],
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
          userMessage: fixture.question,
          route: {
            intent: 'REEL_VIDEO_QUESTION',
            reelQuestionType: 'TRANSCRIPT_CONTENT',
            requiredEvidence: ['TRANSCRIPT'],
          },
          rerankedChunks: [
            {
              evidenceType: 'TRANSCRIPT',
              evidenceText: fixture.evidence,
              chunkText: fixture.evidence,
              tags: [],
            },
          ],
        } as unknown as RagChatWorkflowState),
      ).resolves.toMatchObject({
        answer: fixture.answer,
        finalizationMode: 'SYNTHESIZED',
      });

      expect(
        service.generateObject.mock.calls[0][0].jsonSchema.properties.answer,
      ).toMatchObject({ maxLength: 900 });
      expect(service.generateObject.mock.calls[0][0].userPrompt).toContain(
        '"answerShape":"EXPLANATION"',
      );
    },
  );

  it('preserves a grounded transcript paraphrase instead of replacing it', async () => {
    const service = {
      generateObject: jest.fn().mockResolvedValue({
        answer:
          'The speaker began learning TypeScript roughly three years ago when the team moved away from plain JavaScript.',
        claims: [
          {
            claim:
              'The speaker began learning TypeScript roughly three years ago when the team moved away from plain JavaScript.',
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

    await expect(
      useCase.execute({
        ...state,
        userMessage: 'Why did the speaker start learning TypeScript?',
        route: {
          intent: 'REEL_VIDEO_QUESTION',
          reelQuestionType: 'TRANSCRIPT_CONTENT',
          requiredEvidence: ['TRANSCRIPT'],
        },
        rerankedChunks: [
          {
            evidenceType: 'TRANSCRIPT',
            evidenceText:
              'I started learning TypeScript about three years ago because our team moved away from plain JavaScript.',
            chunkText:
              'I started learning TypeScript about three years ago because our team moved away from plain JavaScript.',
            tags: [],
          },
        ],
      } as unknown as RagChatWorkflowState),
    ).resolves.toMatchObject({
      answer:
        'The speaker began learning TypeScript roughly three years ago when the team moved away from plain JavaScript.',
      claims: [
        {
          claim:
            'The speaker began learning TypeScript roughly three years ago when the team moved away from plain JavaScript.',
          evidenceIds: ['e0'],
        },
      ],
      finalizationMode: 'SYNTHESIZED',
    });
  });

  it('retries a revision that introduces an unsupported distinctive entity', async () => {
    const service = {
      generateObject: jest
        .fn()
        .mockResolvedValueOnce({
          answer:
            'The video shot detector project was carried out at EDIAP under Jean-Marc.',
          claims: [
            {
              claim:
                'The video shot detector project was carried out at EDIAP under Jean-Marc.',
              evidenceIds: ['e0'],
            },
          ],
        })
        .mockResolvedValueOnce({
          answer:
            'The video shot detector project was carried out at IDIAP under Jean-Marc.',
          claims: [
            {
              claim:
                'The video shot detector project was carried out at IDIAP under Jean-Marc.',
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

    await expect(
      useCase.execute({
        ...state,
        userMessage:
          'Where was the video shot detector project carried out, and under whose supervision?',
        route: {
          intent: 'REEL_VIDEO_QUESTION',
          requiredEvidence: ['TRANSCRIPT'],
        },
        rerankedChunks: [
          {
            evidenceType: 'TRANSCRIPT',
            evidenceText:
              'The video shot detector project was carried out at IDIAP under Jean-Marc.',
            chunkText:
              'The video shot detector project was carried out at IDIAP under Jean-Marc.',
            tags: [],
          },
        ],
      } as unknown as RagChatWorkflowState),
    ).resolves.toMatchObject({
      answer:
        'The video shot detector project was carried out at IDIAP under Jean-Marc.',
      finalizationMode: 'SYNTHESIZED',
    });
    expect(service.generateObject).toHaveBeenCalledTimes(2);
  });

  it('preserves a grounded summary assembled from multiple transcript chunks', async () => {
    const answer =
      "The speaker learned TypeScript during the team's move away from plain JavaScript.";
    const service = {
      generateObject: jest.fn().mockResolvedValue({
        answer,
        claims: [
          {
            claim: 'The speaker learned TypeScript during the transition.',
            evidenceIds: ['e0', 'e1'],
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
        userMessage: 'What happened during the language transition?',
        route: {
          intent: 'REEL_VIDEO_QUESTION',
          requiredEvidence: ['TRANSCRIPT'],
        },
        rerankedChunks: [
          {
            evidenceType: 'TRANSCRIPT',
            evidenceText: 'The speaker started learning TypeScript.',
            chunkText: 'The speaker started learning TypeScript.',
            tags: [],
          },
          {
            evidenceType: 'TRANSCRIPT',
            evidenceText: 'The team moved away from plain JavaScript.',
            chunkText: 'The team moved away from plain JavaScript.',
            tags: [],
          },
        ],
      } as unknown as RagChatWorkflowState),
    ).resolves.toMatchObject({
      answer,
      finalizationMode: 'SYNTHESIZED',
    });
  });

  it('leaves an unanchored candidate for semantic verification instead of copying transcript text', async () => {
    const answer = 'The zorb is coupled to the quasar and glows green.';
    const service = {
      generateObject: jest.fn().mockResolvedValue({
        answer,
        claims: [{ claim: answer, evidenceIds: ['e0'] }],
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
        route: {
          intent: 'REEL_VIDEO_QUESTION',
          requiredEvidence: ['TRANSCRIPT'],
        },
      } as unknown as RagChatWorkflowState),
    ).resolves.toMatchObject({
      answer,
      finalizationMode: 'SYNTHESIZED',
    });
  });

  it('uses the ranked transcript window when synthesis remains unusable', async () => {
    const service = {
      generateObject: jest.fn().mockResolvedValue({
        answer: '',
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
        userMessage: 'Where was the project carried out?',
        route: {
          intent: 'REEL_VIDEO_QUESTION',
          requiredEvidence: ['TRANSCRIPT'],
        },
        rerankedChunks: [
          {
            evidenceType: 'TRANSCRIPT',
            evidenceText:
              'At 42.5 seconds, the project was carried out during an internship at IDIAP under Jean-Marc. A separate sentence follows.',
            chunkText:
              'At 42.5 seconds, the project was carried out during an internship at IDIAP under Jean-Marc. A separate sentence follows.',
            tags: [],
          },
        ],
      } as unknown as RagChatWorkflowState),
    ).resolves.toMatchObject({
      answer:
        'At 42.5 seconds, the project was carried out during an internship at IDIAP under Jean-Marc.',
      claims: [
        {
          claim:
            'At 42.5 seconds, the project was carried out during an internship at IDIAP under Jean-Marc.',
          evidenceIds: ['e0'],
        },
      ],
      finalizationMode: 'EXTRACTIVE_TRANSCRIPT_FALLBACK',
      fallbackReason: 'UNUSABLE_SYNTHESIS',
    });
  });

  it('keeps only the top ranked source span for short factual fallback', async () => {
    const service = {
      generateObject: jest.fn().mockResolvedValue({
        answer: '',
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
        userMessage: 'What relation is asserted?',
        route: {
          intent: 'REEL_VIDEO_QUESTION',
          requiredEvidence: ['TRANSCRIPT'],
        },
        rerankedChunks: [
          {
            evidenceType: 'TRANSCRIPT',
            evidenceText: 'The asserted relation is coupled.',
            chunkText: 'The asserted relation is coupled.',
            reelId: 'target-reel',
            tags: [],
          },
          {
            evidenceType: 'TRANSCRIPT',
            evidenceText: 'Target evidence window two.',
            chunkText: 'Target evidence window two.',
            reelId: 'target-reel',
            tags: [],
          },
          {
            evidenceType: 'TRANSCRIPT',
            evidenceText: 'Distractor evidence window.',
            chunkText: 'Distractor evidence window.',
            reelId: 'other-reel',
            tags: [],
          },
        ],
      } as unknown as RagChatWorkflowState),
    ).resolves.toMatchObject({
      answer: 'The asserted relation is coupled.',
      claims: [
        {
          evidenceIds: ['e0'],
        },
      ],
      finalizationMode: 'EXTRACTIVE_TRANSCRIPT_FALLBACK',
      fallbackReason: 'UNUSABLE_SYNTHESIS',
    });
  });

  it('prefers answer-bearing evidence over a topical question echo in fallback', async () => {
    const service = {
      generateObject: jest.fn().mockResolvedValue({ answer: '', claims: [] }),
    };
    const useCase = new GenerateDraftAnswerUseCase(
      service as never,
      promptBuilder,
      config,
    );

    await expect(
      useCase.execute({
        ...state,
        userMessage: 'What storage medium is used for backups?',
        route: {
          intent: 'REEL_VIDEO_QUESTION',
          reelQuestionType: 'TRANSCRIPT_CONTENT',
          requiredEvidence: ['TRANSCRIPT'],
        },
        rerankedChunks: [
          {
            evidenceType: 'TRANSCRIPT',
            evidenceText:
              'What storage medium is used for backups? The backups use optical discs.',
            chunkText:
              'What storage medium is used for backups? The backups use optical discs.',
            reelId: 'target-reel',
            tags: [],
          },
        ],
      } as unknown as RagChatWorkflowState),
    ).resolves.toMatchObject({
      answer: 'The backups use optical discs.',
      claims: [{ evidenceIds: ['e0'] }],
      finalizationMode: 'EXTRACTIVE_TRANSCRIPT_FALLBACK',
    });
  });

  it('prefers answer-bearing evidence over a paraphrased topical question echo in fallback', async () => {
    const service = {
      generateObject: jest.fn().mockResolvedValue({ answer: '', claims: [] }),
    };
    const useCase = new GenerateDraftAnswerUseCase(
      service as never,
      promptBuilder,
      config,
    );

    await expect(
      useCase.execute({
        ...state,
        userMessage: 'What storage medium is used for backups?',
        route: {
          intent: 'REEL_VIDEO_QUESTION',
          reelQuestionType: 'TRANSCRIPT_CONTENT',
          requiredEvidence: ['TRANSCRIPT'],
        },
        rerankedChunks: [
          {
            evidenceType: 'TRANSCRIPT',
            evidenceText:
              'The video asks what storage medium is used for backups. The backups use optical discs.',
            chunkText:
              'The video asks what storage medium is used for backups. The backups use optical discs.',
            reelId: 'target-reel',
            tags: [],
          },
        ],
      } as unknown as RagChatWorkflowState),
    ).resolves.toMatchObject({
      answer: 'The backups use optical discs.',
      claims: [{ evidenceIds: ['e0'] }],
      finalizationMode: 'EXTRACTIVE_TRANSCRIPT_FALLBACK',
    });
  });

  it.each([
    'The video discusses the storage medium used for backups. The backups use optical discs.',
    'Vídeo: storage medium used for backups. The backups use optical discs.',
  ])(
    'prefers answer-bearing evidence over a vocabulary-independent topical echo: %s',
    async (evidenceText) => {
      const service = {
        generateObject: jest.fn().mockResolvedValue({ answer: '', claims: [] }),
      };
      const useCase = new GenerateDraftAnswerUseCase(
        service as never,
        promptBuilder,
        config,
      );

      await expect(
        useCase.execute({
          ...state,
          userMessage: 'What storage medium is used for backups?',
          route: {
            intent: 'REEL_VIDEO_QUESTION',
            reelQuestionType: 'TRANSCRIPT_CONTENT',
            requiredEvidence: ['TRANSCRIPT'],
          },
          rerankedChunks: [
            {
              evidenceType: 'TRANSCRIPT',
              evidenceText,
              chunkText: evidenceText,
              reelId: 'target-reel',
              tags: [],
            },
          ],
        } as unknown as RagChatWorkflowState),
      ).resolves.toMatchObject({
        answer: 'The backups use optical discs.',
        claims: [{ evidenceIds: ['e0'] }],
        finalizationMode: 'EXTRACTIVE_TRANSCRIPT_FALLBACK',
      });
    },
  );

  it('returns one direct answer-bearing span instead of transcript-shaped fallback text', () => {
    const service = { generateObject: jest.fn() };
    const useCase = new GenerateDraftAnswerUseCase(
      service as never,
      promptBuilder,
      config,
    );
    const evidenceText =
      "salient features that they share in common. I would like them to be in the same cluster. And those two, one of them is labeled and the other is not labeled. So you look at that and you say, oh, someone told this one was very similar and this one is said to be blue, for example. I don't know if it's the label. So I put it in the blue bag. But you never use the blue bag.";

    const fallback = useCase.buildExtractiveFallback(
      {
        ...state,
        userMessage:
          'What example label is used for a marble that is put into a bag?',
        route: {
          intent: 'REEL_VIDEO_QUESTION',
          reelQuestionType: 'TRANSCRIPT_CONTENT',
          requiredEvidence: ['TRANSCRIPT'],
        },
        contextSufficiency: {
          sufficient: true,
          supportedEvidenceIds: ['e0'],
        },
        rerankedChunks: [
          {
            evidenceType: 'TRANSCRIPT',
            evidenceText,
            chunkText: evidenceText,
            reelId: 'target-reel',
            tags: [],
          },
        ],
      } as unknown as RagChatWorkflowState,
      'UNUSABLE_SYNTHESIS',
    );

    expect(fallback).toMatchObject({
      answer: 'So I put it in the blue bag.',
      claims: [{ evidenceIds: ['e0'] }],
      finalizationMode: 'EXTRACTIVE_TRANSCRIPT_FALLBACK',
    });
    expect(fallback?.answer).not.toContain('\n');
    expect(service.generateObject).not.toHaveBeenCalled();
  });

  it('uses extractive fallback when an empty answer remains unusable after retry', async () => {
    const service = {
      generateObject: jest.fn().mockResolvedValue({ answer: '', claims: [] }),
    };
    const useCase = new GenerateDraftAnswerUseCase(
      service as never,
      promptBuilder,
      config,
    );

    await expect(
      useCase.execute({
        ...state,
        route: {
          intent: 'REEL_VIDEO_QUESTION',
          requiredEvidence: ['TRANSCRIPT'],
        },
      } as unknown as RagChatWorkflowState),
    ).resolves.toMatchObject({
      answer: 'The zorb is coupled to the quasar.',
      claims: [{ evidenceIds: ['e0'] }],
      finalizationMode: 'EXTRACTIVE_TRANSCRIPT_FALLBACK',
      fallbackReason: 'UNUSABLE_SYNTHESIS',
    });
    expect(service.generateObject).toHaveBeenCalledTimes(2);
  });

  it('selects relevant source spans from a noisy transcript fallback', async () => {
    const service = {
      generateObject: jest.fn().mockResolvedValue({
        answer: '',
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
        userMessage: 'Why do they say CDs are not enough for backing up data?',
        route: {
          intent: 'REEL_VIDEO_QUESTION',
          requiredEvidence: ['TRANSCRIPT'],
        },
        rerankedChunks: [
          {
            evidenceType: 'TRANSCRIPT',
            evidenceText:
              'They discussed unrelated storage. Because one CD is not even one GB. Another unrelated sentence.',
            chunkText:
              'They discussed unrelated storage. Because one CD is not even one GB. Another unrelated sentence.',
            reelId: 'target-reel',
            tags: [],
          },
        ],
      } as unknown as RagChatWorkflowState),
    ).resolves.toMatchObject({
      answer: 'Because one CD is not even one GB.',
      claims: [{ evidenceIds: ['e0'] }],
      finalizationMode: 'EXTRACTIVE_TRANSCRIPT_FALLBACK',
    });
  });

  it('extracts a compact causal proposition from punctuation-free ASR', () => {
    const service = { generateObject: jest.fn() };
    const useCase = new GenerateDraftAnswerUseCase(
      service as never,
      promptBuilder,
      config,
    );
    const evidenceText =
      "no CDs are not enough because one CD is how much it's not even one GB so then CDs are not enough phone book";

    const fallback = useCase.buildExtractiveFallback(
      {
        ...state,
        userMessage: 'Why do they say CDs are not enough for backing up data?',
        route: {
          intent: 'REEL_VIDEO_QUESTION',
          requiredEvidence: ['TRANSCRIPT'],
        },
        contextSufficiency: {
          sufficient: true,
          supportedEvidenceIds: ['e0'],
        },
        rerankedChunks: [
          {
            evidenceType: 'TRANSCRIPT',
            evidenceText,
            chunkText: evidenceText,
            reelId: 'target-reel',
            tags: [],
          },
        ],
      } as unknown as RagChatWorkflowState,
      'UNUSABLE_SYNTHESIS',
    );

    expect(fallback).toMatchObject({
      answer: "because one CD is how much it's not even one GB",
      claims: [{ evidenceIds: ['e0'] }],
      finalizationMode: 'EXTRACTIVE_TRANSCRIPT_FALLBACK',
    });
    expect(service.generateObject).not.toHaveBeenCalled();
  });

  it('prefers the requested directional quantity over an unrelated number in fallback evidence', () => {
    const service = { generateObject: jest.fn() };
    const useCase = new GenerateDraftAnswerUseCase(
      service as never,
      promptBuilder,
      config,
    );
    const fallback = useCase.buildExtractiveFallback(
      {
        ...state,
        userMessage:
          'How low does the speaker say the number of bands can go while still being okay?',
        route: {
          intent: 'REEL_VIDEO_QUESTION',
          reelQuestionType: 'TRANSCRIPT_CONTENT',
          requiredEvidence: ['TRANSCRIPT'],
        },
        contextSufficiency: {
          sufficient: true,
          supportedEvidenceIds: ['e0'],
        },
        rerankedChunks: [
          {
            evidenceType: 'TRANSCRIPT',
            evidenceText:
              'There are 2 controls on the panel. We can go down till like 12 bands and it is still okay.',
            chunkText:
              'There are 2 controls on the panel. We can go down till like 12 bands and it is still okay.',
            tags: [],
          },
        ],
      } as unknown as RagChatWorkflowState,
      'UNUSABLE_SYNTHESIS',
    );

    expect(fallback?.answer).toContain('12 bands');
    expect(fallback?.answer).not.toBe('There are 2 controls on the panel.');
    expect(fallback).toMatchObject({ claims: [{ evidenceIds: ['e0'] }] });
  });

  it('returns only the current-band proposition from a noisy quantity transcript', () => {
    const service = { generateObject: jest.fn() };
    const useCase = new GenerateDraftAnswerUseCase(
      service as never,
      promptBuilder,
      config,
    );
    const evidenceText =
      "With, I don't know, the compression, number of bands and... Number of bands and... What you were playing with and what are the results, like what to use? Now what I am using are 15 frequency bands, which seems to me quite reasonable. We can go down till like 12 and still okay I would say.";

    const fallback = useCase.buildExtractiveFallback(
      {
        ...state,
        userMessage: 'How many frequency bands is the speaker currently using?',
        route: {
          intent: 'REEL_VIDEO_QUESTION',
          reelQuestionType: 'TRANSCRIPT_CONTENT',
          requiredEvidence: ['TRANSCRIPT'],
        },
        contextSufficiency: {
          sufficient: true,
          supportedEvidenceIds: ['e0'],
        },
        rerankedChunks: [
          {
            evidenceType: 'TRANSCRIPT',
            evidenceText,
            chunkText: evidenceText,
            reelId: 'target-reel',
            tags: [],
          },
        ],
      } as unknown as RagChatWorkflowState,
      'UNUSABLE_SYNTHESIS',
    );

    expect(fallback).toMatchObject({
      answer:
        'Now what I am using are 15 frequency bands, which seems to me quite reasonable.',
      claims: [{ evidenceIds: ['e0'] }],
    });
    expect(fallback?.answer).not.toContain('12');
    expect(service.generateObject).not.toHaveBeenCalled();
  });

  it('uses extractive fallback for an evidence-dependent refusal', async () => {
    const refusal =
      'The transcript is too garbled to determine the requested label reliably.';
    const service = {
      generateObject: jest.fn().mockResolvedValue({
        answer: refusal,
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
        userMessage: 'What example label is used for the marble?',
        route: {
          intent: 'REEL_VIDEO_QUESTION',
          requiredEvidence: ['TRANSCRIPT'],
        },
        contextSufficiency: {
          sufficient: true,
          supportedEvidenceIds: ['e0'],
        },
        rerankedChunks: [
          {
            evidenceType: 'TRANSCRIPT',
            evidenceText: 'The example label used for the marble is blue.',
            chunkText: 'The example label used for the marble is blue.',
            tags: [],
          },
        ],
      } as unknown as RagChatWorkflowState),
    ).resolves.toMatchObject({
      answer: 'The example label used for the marble is blue.',
      finalizationMode: 'EXTRACTIVE_TRANSCRIPT_FALLBACK',
      fallbackReason: 'UNUSABLE_SYNTHESIS',
    });
    expect(service.generateObject).toHaveBeenCalledTimes(2);
  });

  it('does not preserve an answer that only echoes the question vocabulary', async () => {
    const service = {
      generateObject: jest.fn().mockResolvedValue({
        answer:
          'The example label used for a marble that is put into a bag is bag.',
        claims: [
          {
            claim:
              'The example label used for a marble that is put into a bag is bag.',
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

    await expect(
      useCase.execute({
        ...state,
        userMessage:
          'What example label is used for a marble that is put into a bag?',
        route: {
          intent: 'REEL_VIDEO_QUESTION',
          requiredEvidence: ['TRANSCRIPT'],
        },
        contextSufficiency: {
          sufficient: true,
          supportedEvidenceIds: ['e0'],
        },
        rerankedChunks: [
          {
            evidenceType: 'TRANSCRIPT',
            evidenceText: 'The example label used for the marble is blue.',
            chunkText: 'The example label used for the marble is blue.',
            tags: [],
          },
        ],
      } as unknown as RagChatWorkflowState),
    ).resolves.toMatchObject({
      answer: 'The example label used for the marble is blue.',
      finalizationMode: 'EXTRACTIVE_TRANSCRIPT_FALLBACK',
      fallbackReason: 'UNUSABLE_SYNTHESIS',
    });
    expect(service.generateObject).toHaveBeenCalledTimes(2);
  });

  it('uses extractive fallback after provider failure without bypassing the evidence boundary', async () => {
    const service = {
      generateObject: jest.fn().mockRejectedValue(new Error('provider down')),
    };
    const useCase = new GenerateDraftAnswerUseCase(
      service as never,
      promptBuilder,
      config,
    );

    await expect(
      useCase.execute({
        ...state,
        route: {
          intent: 'REEL_VIDEO_QUESTION',
          requiredEvidence: ['TRANSCRIPT'],
        },
      } as unknown as RagChatWorkflowState),
    ).resolves.toMatchObject({
      answer: 'The zorb is coupled to the quasar.',
      finalizationMode: 'EXTRACTIVE_TRANSCRIPT_FALLBACK',
      fallbackReason: 'ANSWER_GENERATION_FAILURE',
    });
    expect(service.generateObject).toHaveBeenCalledTimes(1);
  });

  it('uses the configured secondary model after a transient answer-provider failure', async () => {
    const providerError = Object.assign(new Error('rate limited'), {
      code: 'STRUCTURED_COMPLETION_PROVIDER_ERROR',
      transient: true,
    });
    const service = {
      generateObject: jest
        .fn()
        .mockRejectedValueOnce(providerError)
        .mockResolvedValueOnce({
          answer: 'A blue car is parked.',
          claims: [{ claim: 'A blue car is parked.', evidenceIds: ['e0'] }],
        }),
    };
    const fallbackConfig = {
      ...config,
      get: jest.fn((key: string) =>
        key === 'AI_ROUTER_FALLBACK_MODEL' ? 'test/test/secondary' : undefined,
      ),
    } as unknown as IAiApplicationConfig;
    const useCase = new GenerateDraftAnswerUseCase(
      service as never,
      promptBuilder,
      fallbackConfig,
    );

    const result = await useCase.execute({
      userMessage: 'What is visible in the frame?',
      route: {
        intent: 'REEL_VIDEO_QUESTION',
        reelQuestionType: 'VISUAL_CONTENT',
        requiredEvidence: ['VISUAL'],
      },
      contextSufficiency: {
        sufficient: true,
        availableEvidence: ['VISUAL'],
        missingEvidence: [],
        supportedEvidenceIds: ['e0'],
        recommendedAction: 'ANSWER',
      },
      rerankedChunks: [
        {
          chunkId: 'visual-1',
          reelId: 'reel-1',
          evidenceType: 'VISUAL',
          evidenceText: 'A blue car is parked.',
          chunkText: 'A blue car is parked.',
          description: 'A blue car is parked.',
          tags: [],
        },
      ],
    } as unknown as RagChatWorkflowState);

    expect(result).toMatchObject({
      answer: 'A blue car is parked.',
      claims: [{ evidenceIds: ['e0'] }],
      finalizationMode: 'SYNTHESIZED',
    });
    expect(service.generateObject).toHaveBeenCalledTimes(2);
    expect(service.generateObject).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ model: 'test/test/answer' }),
    );
    expect(service.generateObject).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ model: 'test/test/secondary' }),
    );
  });

  it('retries when the structured provider rejects the answer maxLength contract', async () => {
    const schemaError = Object.assign(
      new Error(
        'Structured completion failed local schema validation (path=$.answer, constraint=maxLength)',
      ),
      {
        name: 'GroqStructuredCompletionSchemaError',
        code: 'STRUCTURED_COMPLETION_SCHEMA_INVALID',
        path: '$.answer',
        constraint: 'maxLength',
      },
    );
    const answer = 'The zorb is coupled to the quasar.';
    const service = {
      generateObject: jest
        .fn()
        .mockRejectedValueOnce(schemaError)
        .mockResolvedValueOnce({
          answer,
          claims: [{ claim: answer, evidenceIds: ['e0'] }],
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
        route: {
          intent: 'REEL_VIDEO_QUESTION',
          requiredEvidence: ['TRANSCRIPT'],
        },
      } as unknown as RagChatWorkflowState),
    ).resolves.toMatchObject({
      answer,
      finalizationMode: 'SYNTHESIZED',
    });

    expect(service.generateObject).toHaveBeenCalledTimes(2);
    expect(service.generateObject.mock.calls[1][0].systemPrompt).toContain(
      'shortest complete form within the supplied answer budget',
    );
  });

  it('uses only sufficiency-authorized evidence for an extractive fallback', async () => {
    const service = {
      generateObject: jest.fn().mockResolvedValue({ answer: '', claims: [] }),
    };
    const useCase = new GenerateDraftAnswerUseCase(
      service as never,
      promptBuilder,
      config,
    );

    await expect(
      useCase.execute({
        ...state,
        route: {
          intent: 'REEL_VIDEO_QUESTION',
          requiredEvidence: ['TRANSCRIPT'],
        },
        contextSufficiency: {
          sufficient: true,
          supportedEvidenceIds: ['e1'],
        },
        rerankedChunks: [
          {
            evidenceType: 'TRANSCRIPT',
            evidenceText: 'Unauthorized distractor text.',
            chunkText: 'Unauthorized distractor text.',
            tags: [],
          },
          {
            evidenceType: 'TRANSCRIPT',
            evidenceText: 'Authorized evidence text.',
            chunkText: 'Authorized evidence text.',
            tags: [],
          },
        ],
      } as unknown as RagChatWorkflowState),
    ).resolves.toMatchObject({
      answer: 'Authorized evidence text.',
      claims: [{ evidenceIds: ['e1'] }],
    });
  });

  it('builds an extractive verifier-outage fallback without another provider call', () => {
    const service = { generateObject: jest.fn() };
    const useCase = new GenerateDraftAnswerUseCase(
      service as never,
      promptBuilder,
      config,
    );
    const fallback = useCase.buildExtractiveFallback(
      {
        ...state,
        userMessage: 'What example label is used for the marble?',
        route: {
          intent: 'REEL_VIDEO_QUESTION',
          requiredEvidence: ['TRANSCRIPT'],
        },
        contextSufficiency: {
          sufficient: true,
          supportedEvidenceIds: ['e0'],
        },
        rerankedChunks: [
          {
            evidenceType: 'TRANSCRIPT',
            evidenceText:
              'This one is said to be blue. So I put it in the blue bag.',
            chunkText:
              'This one is said to be blue. So I put it in the blue bag.',
            tags: [],
          },
        ],
      } as unknown as RagChatWorkflowState,
      'UNUSABLE_SYNTHESIS',
    );

    expect(fallback).toMatchObject({
      claims: [{ evidenceIds: ['e0'] }],
      finalizationMode: 'EXTRACTIVE_TRANSCRIPT_FALLBACK',
      fallbackReason: 'UNUSABLE_SYNTHESIS',
    });
    expect(fallback?.answer.toLowerCase()).toContain('blue');
    expect(service.generateObject).not.toHaveBeenCalled();
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

  it('focuses an advisory negative on the top required-evidence reel', async () => {
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

    await useCase.execute({
      ...state,
      route: {
        intent: 'REEL_VIDEO_QUESTION',
        requiredEvidence: ['TRANSCRIPT'],
      },
      contextSufficiency: {
        sufficient: false,
        confidence: 0.2,
        availableEvidence: ['TRANSCRIPT'],
        missingEvidence: ['TRANSCRIPT'],
        supportedEvidenceIds: [],
        reason: 'Advisory negative.',
        recommendedAction: 'REFUSE_NO_CONTEXT',
        diagnostics: { providerStatus: 'SUCCESS', decisionSource: 'LLM' },
      },
      rerankedChunks: [
        {
          evidenceType: 'TRANSCRIPT',
          evidenceText: 'Target evidence.',
          chunkText: 'Target evidence.',
          reelId: 'reel-target',
          tags: [],
        },
        {
          evidenceType: 'TRANSCRIPT',
          evidenceText: 'Distractor evidence.',
          chunkText: 'Distractor evidence.',
          reelId: 'reel-distractor',
          tags: [],
        },
        {
          evidenceType: 'TRANSCRIPT',
          evidenceText: 'Target companion evidence.',
          chunkText: 'Target companion evidence.',
          reelId: 'reel-target',
          tags: [],
        },
      ],
    } as unknown as RagChatWorkflowState);

    const request = service.generateObject.mock.calls[0]?.[0] as {
      userPrompt: string;
    };
    const payload = JSON.parse(request.userPrompt) as {
      authorizedEvidence: Array<{ evidenceId: string }>;
    };
    expect(payload.authorizedEvidence.map((item) => item.evidenceId)).toEqual([
      'e0',
      'e2',
    ]);
  });

  it('retries a quantity answer that omits the supported value', async () => {
    const service = {
      generateObject: jest
        .fn()
        .mockResolvedValueOnce({
          answer: 'It is lower than the current setting.',
          claims: [
            {
              claim: 'It is lower than the current setting.',
              evidenceIds: ['e0'],
            },
          ],
        })
        .mockResolvedValueOnce({
          answer: 'Twelve bands.',
          claims: [{ claim: 'Twelve bands.', evidenceIds: ['e0'] }],
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
        userMessage: 'How low can the number of bands go?',
        rerankedChunks: [
          {
            evidenceType: 'TRANSCRIPT',
            evidenceText: 'The number can go down to 12 bands.',
            chunkText: 'The number can go down to 12 bands.',
            tags: [],
          },
        ],
      } as unknown as RagChatWorkflowState),
    ).resolves.toMatchObject({ answer: 'Twelve bands.' });

    expect(service.generateObject).toHaveBeenCalledTimes(2);
    expect(service.generateObject.mock.calls[1][0].systemPrompt).toContain(
      'explicit-quantity requirement',
    );
  });

  it('requires a supported quantity in a capacity explanation', async () => {
    const service = {
      generateObject: jest
        .fn()
        .mockResolvedValueOnce({
          answer:
            'CDs are not enough for backing up data because a single CD cannot hold all the data needed.',
          claims: [
            {
              claim:
                'CDs are not enough for backing up data because a single CD cannot hold all the data needed.',
              evidenceIds: ['e0'],
            },
          ],
        })
        .mockResolvedValueOnce({
          answer: 'One CD is not even one gigabyte.',
          claims: [
            {
              claim: 'One CD is not even one gigabyte.',
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

    await expect(
      useCase.execute({
        ...state,
        userMessage: 'Why do they say CDs are not enough for backing up data?',
        rerankedChunks: [
          {
            evidenceType: 'TRANSCRIPT',
            evidenceText: 'One CD is not even one GB.',
            chunkText: 'One CD is not even one GB.',
            tags: [],
          },
        ],
      } as unknown as RagChatWorkflowState),
    ).resolves.toMatchObject({ answer: 'One CD is not even one gigabyte.' });
    expect(service.generateObject).toHaveBeenCalledTimes(2);
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
