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
