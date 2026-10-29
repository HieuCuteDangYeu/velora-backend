import type { RagChatWorkflowState } from '@ai/domain/interfaces/rag-chat-workflow.interface';
import { MULTI_REEL_TRANSCRIPT_COMPARISON_MAX_CHARS } from '@ai/domain/services/rag-answer-contract';
import { BuildGroundedAnswerRevisionUseCase } from './build-grounded-answer-revision.use-case';

describe('BuildGroundedAnswerRevisionUseCase', () => {
  const structuredLlm = { generateObject: jest.fn() };
  const config = {
    get: jest.fn().mockReturnValue(undefined),
    model: jest.fn().mockReturnValue('test/test/answer-revision'),
    timeoutMs: jest.fn().mockReturnValue(1_000),
    maxCompletionTokens: jest.fn().mockReturnValue(768),
  };
  const useCase = new BuildGroundedAnswerRevisionUseCase(
    structuredLlm as never,
    config as never,
  );

  const state = (input: {
    question: string;
    evidence: string[];
  }): RagChatWorkflowState =>
    ({
      userId: 'user-1',
      conversationId: 'conversation-1',
      userMessage: input.question,
      route: {
        intent: 'REEL_VIDEO_QUESTION',
        reelQuestionType: 'TRANSCRIPT_CONTENT',
        requiredEvidence: ['TRANSCRIPT'],
      },
      verification: {
        passed: false,
        confidence: 0.9,
        issues: ['Answer the requested relation from the evidence.'],
        requiresRevision: true,
      },
      nextDraftSource: 'VERIFIER_REVISION',
      rerankedChunks: input.evidence.map((evidenceText, index) => ({
        chunkId: `chunk-${index}`,
        reelId: 'reel-1',
        evidenceType: 'TRANSCRIPT',
        evidenceText,
        chunkText: evidenceText,
        tags: [],
      })),
      retrievedChunks: [],
      retryCount: 0,
      retrievalRetryCount: 0,
      citationRetryCount: 0,
      draftHistory: [],
      draftRevision: 1,
      citationAttempts: [],
      finalFailureSource: 'UNKNOWN',
    }) as unknown as RagChatWorkflowState;

  beforeEach(() => {
    jest.clearAllMocks();
    config.get.mockReturnValue(undefined);
  });

  it.each([
    {
      name: 'IN1002-1 later evidence',
      question:
        'What safety measure do they say protects data if a building has a fire?',
      evidence: [
        'The building can burn in a fire.',
        'They will have backup at different physically at different places.',
      ],
      answer: 'They keep backups in physically different places.',
      evidenceIds: ['e1'],
    },
    {
      name: 'IN1002-2 noisy ASR',
      question: 'Why do they say CDs are not enough for backing up data?',
      evidence: [
        "no CDs are not enough because one CD is how much it's not even one GB so then CDs are not enough phone book",
      ],
      answer: 'CDs are not enough because one CD holds less than one GB.',
      evidenceIds: ['e0'],
    },
    {
      name: 'multilingual unseen relation',
      question: 'Máy bơm zircon được đặt ở đâu?',
      evidence: ['Máy bơm zircon được đặt cạnh cửa phía tây của tầng hầm.'],
      answer: 'Máy bơm zircon ở cạnh cửa phía tây của tầng hầm.',
      evidenceIds: ['e0'],
    },
  ])('uses the model decision for $name', async (fixture) => {
    structuredLlm.generateObject.mockResolvedValueOnce({
      answer: fixture.answer,
      evidenceIds: fixture.evidenceIds,
    });

    await expect(
      useCase.executeWithProvenance(
        state({ question: fixture.question, evidence: fixture.evidence }),
      ),
    ).resolves.toEqual({
      answer: fixture.answer,
      evidenceIds: fixture.evidenceIds,
      modelRole: 'ANSWER_REVISION',
      generationEvidence: expect.arrayContaining([
        expect.objectContaining({ sourceId: 'chunk-0', evidenceId: 'e0' }),
      ]),
      diagnostics: [],
    });
  });

  it('rejects a revision missing a required Reel/modality pair', async () => {
    const input = state({
      question: 'For each clip, what is said and what is visible?',
      evidence: [],
    });
    input.route = {
      ...input.route!,
      reelQuestionType: 'MULTIMODAL_CONTENT',
      requiredEvidence: ['TRANSCRIPT', 'VISUAL'],
    };
    input.retrievalPlan = {
      requiresReelCoverage: true,
      mode: 'REEL_HYBRID',
      query: input.userMessage,
      searchLimit: 4,
      rerankLimit: 4,
      shouldRerank: false,
      reason: 'Both Clips require source and modality coverage.',
    };
    input.retrievedChunks = [
      { reelId: 'reel-1' },
      { reelId: 'reel-2' },
    ] as never;
    input.rerankedChunks = [
      {
        chunkId: 't1',
        reelId: 'reel-1',
        evidenceType: 'TRANSCRIPT',
        evidenceText: 'The speaker says hello.',
        chunkText: 'The speaker says hello.',
        tags: [],
      },
      {
        chunkId: 'v1',
        reelId: 'reel-1',
        evidenceType: 'VISUAL',
        evidenceText: 'A red door is visible.',
        chunkText: 'A red door is visible.',
        tags: [],
      },
      {
        chunkId: 't2',
        reelId: 'reel-2',
        evidenceType: 'TRANSCRIPT',
        evidenceText: 'The speaker says goodbye.',
        chunkText: 'The speaker says goodbye.',
        tags: [],
      },
      {
        chunkId: 'v2',
        reelId: 'reel-2',
        evidenceType: 'VISUAL',
        evidenceText: 'A blue window is visible.',
        chunkText: 'A blue window is visible.',
        tags: [],
      },
    ] as never;
    structuredLlm.generateObject.mockResolvedValueOnce({
      answer:
        'The speaker says hello. A red door is visible. The speaker says goodbye.',
      evidenceIds: ['e0', 'e1', 'e2'],
    });

    await expect(useCase.executeWithProvenance(input)).resolves.toBeUndefined();
    expect(
      structuredLlm.generateObject.mock.calls[0][0].jsonSchema.properties
        .evidenceIds.maxItems,
    ).toBe(4);
  });

  it('trims a supported but over-verbose answer without changing the answer fact', async () => {
    const input = state({
      question: 'Who supervised the project?',
      evidence: ['Jean-Marc supervised the project.'],
    });
    input.answer = Array.from(
      { length: 14 },
      () => 'Jean-Marc supervised the project.',
    ).join(' ');
    input.verification = {
      passed: true,
      confidence: 0.95,
      issues: [],
      answerQualityPassed: false,
      answerQualityIssues: [
        'EXPLANATION answer exceeds the 900-character direct-answer budget',
      ],
      requiresRevision: true,
      revisedInstruction:
        'Keep the supported answer fact and remove unrelated repetition.',
    };
    structuredLlm.generateObject.mockResolvedValueOnce({
      answer: 'Jean-Marc supervised the project.',
      evidenceIds: ['e0'],
    });

    await expect(useCase.executeWithProvenance(input)).resolves.toMatchObject({
      answer: 'Jean-Marc supervised the project.',
      evidenceIds: ['e0'],
    });

    const request = structuredLlm.generateObject.mock.calls[0][0];
    expect(request.jsonSchema.properties.answer).toMatchObject({
      maxLength: 900,
    });
    expect(request.userPrompt).toContain('"answerShape":"EXPLANATION"');
    expect(request.userPrompt).toContain('"answerQualityIssues"');
    expect(request.systemPrompt).toContain(
      'delete the unrelated material while preserving the supported fact',
    );
  });

  it('keeps complete first-segment excerpts within the generation answer budget', async () => {
    const question =
      'Compare the first indexed transcript segments of Episode One and Episode Two. Attribute each statement to its own clip.';
    const episodeOne = 'The first episode opens in a laboratory.';
    const episodeTwo = 'The second episode opens with a child outside.';
    const input = state({ question, evidence: [episodeOne, episodeTwo] });
    input.retrievalPlan = { requiresReelCoverage: true } as never;
    input.rerankedChunks = [
      {
        chunkId: 'episode-one',
        reelId: 'episode-one',
        evidenceType: 'TRANSCRIPT',
        evidenceText: episodeOne,
        chunkText: episodeOne,
      },
      {
        chunkId: 'episode-two',
        reelId: 'episode-two',
        evidenceType: 'TRANSCRIPT',
        evidenceText: episodeTwo,
        chunkText: episodeTwo,
      },
    ] as never;
    input.retrievedChunks = input.rerankedChunks;
    input.answer = 'A'.repeat(1_100);
    structuredLlm.generateObject.mockResolvedValueOnce({
      answer: `Episode One: ${episodeOne}\nEpisode Two: ${episodeTwo}`,
      evidenceIds: ['e0', 'e1'],
    });

    await expect(useCase.executeWithProvenance(input)).resolves.toMatchObject({
      answer: `Episode One: ${episodeOne}\nEpisode Two: ${episodeTwo}`,
      evidenceIds: ['e0', 'e1'],
    });

    const request = structuredLlm.generateObject.mock.calls[0][0];
    expect(request.userPrompt).toContain('"answerShape":"SUMMARY"');
    expect(request.userPrompt).toContain(
      `"maxAnswerChars":${MULTI_REEL_TRANSCRIPT_COMPARISON_MAX_CHARS}`,
    );
    expect(request.jsonSchema.properties.answer).toMatchObject({
      maxLength: MULTI_REEL_TRANSCRIPT_COMPARISON_MAX_CHARS,
    });
    expect(request.systemPrompt).toContain(
      'preserve the complete earliest transcript segment for each Reel',
    );
    expect(request.systemPrompt).toContain(
      'one concise comparison that follows from those passages',
    );
  });

  it('rejects unknown evidence IDs returned by the model', async () => {
    structuredLlm.generateObject.mockResolvedValueOnce({
      answer: 'Unsupported answer',
      evidenceIds: ['e99'],
    });

    await expect(
      useCase.executeWithProvenance(
        state({ question: 'Where is it?', evidence: ['Inside the atrium.'] }),
      ),
    ).rejects.toThrow('unknown evidence IDs');
  });

  it('does not accept a revision with an unsupported distinctive entity', async () => {
    structuredLlm.generateObject.mockResolvedValueOnce({
      answer:
        'The video shot detector project was carried out at EDIAP under Jean-Marc.',
      evidenceIds: ['e0'],
    });

    await expect(
      useCase.executeWithProvenance(
        state({
          question:
            'Where was the video shot detector project carried out, and under whose supervision?',
          evidence: [
            'The video shot detector project was carried out at IDIAP under Jean-Marc.',
          ],
        }),
      ),
    ).resolves.toBeUndefined();
  });

  it('does not accept an evidence-dependent refusal as a revision', async () => {
    structuredLlm.generateObject.mockResolvedValueOnce({
      answer:
        'The transcript is too garbled to determine the requested label reliably.',
      evidenceIds: ['e0'],
    });

    await expect(
      useCase.executeWithProvenance(
        state({
          question: 'What example label is used for the marble?',
          evidence: ['The example label used for the marble is blue.'],
        }),
      ),
    ).resolves.toBeUndefined();
  });

  it('bounds revision context to the shared evidence budget', async () => {
    structuredLlm.generateObject.mockResolvedValueOnce({
      answer: 'The answer uses the fifth item.',
      evidenceIds: ['e4'],
    });
    await useCase.executeWithProvenance(
      state({
        question: 'Which item?',
        evidence: Array.from({ length: 10 }, (_, index) => `item ${index}`),
      }),
    );

    const request = structuredLlm.generateObject.mock.calls[0][0];
    const payload = JSON.parse(request.userPrompt as string) as {
      evidence?: unknown[];
    };
    expect(payload.evidence).toHaveLength(5);
  });

  it('does not call the model outside a verifier revision', async () => {
    const input = state({ question: 'Where?', evidence: ['Here.'] });
    input.nextDraftSource = 'INITIAL';
    await expect(useCase.execute(input)).resolves.toBeUndefined();
    expect(structuredLlm.generateObject).not.toHaveBeenCalled();
  });

  it('uses ANSWER_REVISION for a citation revision', async () => {
    const input = state({
      question: 'What happened?',
      evidence: ['The speaker describes the project.'],
    });
    input.nextDraftSource = 'CITATION_REVISION';
    structuredLlm.generateObject.mockResolvedValueOnce({
      answer: 'The speaker describes the project.',
      evidenceIds: ['e0'],
    });

    await expect(useCase.executeWithProvenance(input)).resolves.toMatchObject({
      modelRole: 'ANSWER_REVISION',
      evidenceIds: ['e0'],
    });
    expect(structuredLlm.generateObject).toHaveBeenCalledWith(
      expect.objectContaining({ modelRole: 'ANSWER_REVISION' }),
    );
  });

  it('keeps the full transcript segment available during a grounded revision', async () => {
    const segmentTail = 'The final turn changes the stated condition.';
    const input = state({
      question: 'Summarize the speech transcript segment.',
      evidence: [
        `${'The speaker describes the plan. '.repeat(20)}${segmentTail}`,
      ],
    });
    input.retrievalPlan = { sourceOrder: 'ASC' } as NonNullable<
      RagChatWorkflowState['retrievalPlan']
    >;
    structuredLlm.generateObject.mockResolvedValueOnce({
      answer: 'The speaker describes the plan and changes a condition.',
      evidenceIds: ['e0'],
    });

    await useCase.executeWithProvenance(input);

    const prompt = JSON.parse(
      String(structuredLlm.generateObject.mock.calls[0][0].userPrompt),
    ) as { evidence: Array<{ evidenceText: string }> };
    expect(prompt.evidence[0].evidenceText).toContain(segmentTail);
  });

  it('delegates first-sentence revisions to the candidate-selection answer path', async () => {
    const input = state({
      question:
        'Quote the first complete sentence in the indexed transcript segment spanning 9.52-62.28 seconds.',
      evidence: ['opening fragment. The first complete sentence is here.'],
    });
    input.retrievalPlan = {
      sourceOrder: 'ASC',
      sourceTimestampSec: 9.52,
      sourceTimestampEndSec: 62.28,
    };
    await expect(useCase.executeWithProvenance(input)).resolves.toBeUndefined();
    expect(structuredLlm.generateObject).not.toHaveBeenCalled();
  });

  it('uses the configured fallback model after a transient revision-provider error', async () => {
    const fallbackModel = 'test/test/fallback';
    config.get.mockReturnValue(fallbackModel);
    structuredLlm.generateObject
      .mockRejectedValueOnce(
        Object.assign(new Error('rate limited'), {
          code: 'STRUCTURED_COMPLETION_PROVIDER_ERROR',
          transient: true,
        }),
      )
      .mockResolvedValueOnce({
        answer: 'They keep backups in physically different places.',
        evidenceIds: ['e1'],
      });

    await expect(
      useCase.executeWithProvenance(
        state({
          question:
            'What safety measure do they say protects data if a building has a fire?',
          evidence: [
            'The building can burn in a fire.',
            'They will have backup at different physically at different places.',
          ],
        }),
      ),
    ).resolves.toMatchObject({
      answer: 'They keep backups in physically different places.',
      evidenceIds: ['e1'],
    });
    expect(
      structuredLlm.generateObject.mock.calls.map(([request]) => {
        const model: unknown = request.model;
        return model;
      }),
    ).toEqual(['test/test/answer-revision', fallbackModel]);
  });

  it('does not use the fallback model for a non-transient schema error', async () => {
    config.get.mockReturnValue('test/test/fallback');
    structuredLlm.generateObject.mockRejectedValueOnce(
      Object.assign(new Error('invalid structured response'), {
        code: 'STRUCTURED_COMPLETION_SCHEMA_INVALID',
        transient: false,
      }),
    );

    await expect(
      useCase.executeWithProvenance(
        state({ question: 'Where?', evidence: ['The object is in the room.'] }),
      ),
    ).rejects.toMatchObject({
      code: 'STRUCTURED_COMPLETION_SCHEMA_INVALID',
    });
    expect(structuredLlm.generateObject).toHaveBeenCalledTimes(1);
  });

  it('keeps transcript and visual evidence in a fallback multimodal revision', async () => {
    const fallbackModel = 'test/test/fallback';
    config.get.mockReturnValue(fallbackModel);
    const input = state({
      question:
        'Describe what is visible and summarize what is said in the clip.',
      evidence: ['The speaker says the project is complete.'],
    });
    input.route!.reelQuestionType = 'MULTIMODAL_CONTENT';
    input.route!.requiredEvidence = ['TRANSCRIPT', 'VISUAL'];
    input.rerankedChunks[0].evidenceType = 'TRANSCRIPT';
    input.rerankedChunks.push({
      ...input.rerankedChunks[0],
      chunkId: 'visual-1',
      evidenceType: 'VISUAL',
      evidenceText: 'A person holds a red folder.',
      chunkText: 'A person holds a red folder.',
    });
    input.contextSufficiency = {
      sufficient: true,
      confidence: 0.95,
      availableEvidence: ['TRANSCRIPT', 'VISUAL'],
      missingEvidence: [],
      supportedEvidenceIds: ['e0', 'e1'],
      reason: 'Both required modalities are available.',
      recommendedAction: 'ANSWER',
    };
    structuredLlm.generateObject
      .mockRejectedValueOnce(
        Object.assign(new Error('rate limited'), {
          code: 'STRUCTURED_COMPLETION_PROVIDER_ERROR',
          transient: true,
        }),
      )
      .mockResolvedValueOnce({
        answer:
          'The transcript says the project is complete. The frame shows a person holding a red folder.',
        evidenceIds: ['e0', 'e1'],
      });

    await expect(useCase.executeWithProvenance(input)).resolves.toMatchObject({
      evidenceIds: ['e0', 'e1'],
      generationEvidence: expect.arrayContaining([
        expect.objectContaining({ evidenceType: 'TRANSCRIPT' }),
        expect.objectContaining({ evidenceType: 'VISUAL' }),
      ]),
    });
    expect(
      structuredLlm.generateObject.mock.calls.map(([request]) => {
        const model: unknown = request.model;
        return model;
      }),
    ).toEqual(['test/test/answer-revision', fallbackModel]);
  });
});
