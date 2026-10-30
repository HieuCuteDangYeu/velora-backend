import {
  CitationAttributionProviderError,
  type ICitationAttributionService,
} from '@ai/domain/interfaces/citation-attribution.service.interface';
import type { RagChatWorkflowState } from '@ai/domain/interfaces/rag-chat-workflow.interface';
import { BuildRagCitationsUseCase } from './build-rag-citations.use-case';

describe('BuildRagCitationsUseCase', () => {
  it('never turns memory grounding into a public Reel citation', async () => {
    const state = buildState();
    state.generationEvidence = [
      {
        evidenceId: 'm0',
        sourceId: state.rerankedChunks[0].chunkId,
        reelId: 'r1',
        evidenceType: 'USER_MEMORY',
        evidenceText: 'PRIVATE_MEMORY_CANARY',
      },
    ];
    const attribute = jest.fn();
    const result = await new BuildRagCitationsUseCase({ attribute }).execute(
      state,
    );
    expect(result.citations).toEqual([]);
    expect(attribute).not.toHaveBeenCalled();
  });
  it('allocates citations for every required Reel/modality pair', async () => {
    const state = buildState();
    const items = [
      ['t1', 'reel-1', 'TRANSCRIPT', 'The speaker says hello.'],
      ['v1', 'reel-1', 'VISUAL', 'A red door is visible.'],
      ['t2', 'reel-2', 'TRANSCRIPT', 'The speaker says goodbye.'],
      ['v2', 'reel-2', 'VISUAL', 'A blue window is visible.'],
    ] as const;
    state.userMessage = 'For each clip, what is said and what is visible?';
    state.answer = items.map((item) => item[3]).join(' ');
    state.route = {
      ...state.route!,
      reelQuestionType: 'MULTIMODAL_CONTENT',
      requiredEvidence: ['TRANSCRIPT', 'VISUAL'],
    };
    state.retrievalPlan = {
      requiresReelCoverage: true,
      mode: 'REEL_HYBRID',
      query: state.userMessage,
      searchLimit: 4,
      rerankLimit: 4,
      shouldRerank: false,
      reason: 'Test multi-Reel modality citation coverage.',
    };
    state.retrievedChunks = items.map(([chunkId, reelId]) => ({
      chunkId,
      reelId,
    })) as never;
    state.rerankedChunks = items.map(
      ([chunkId, reelId, evidenceType, evidenceText]) => ({
        chunkId,
        reelId,
        evidenceType,
        evidenceText,
        chunkText: evidenceText,
        tags: [],
      }),
    ) as never;
    state.generationEvidence = items.map(
      ([sourceId, reelId, evidenceType, evidenceText], index) => ({
        evidenceId: `e${index}`,
        sourceId,
        reelId,
        evidenceType,
        evidenceText,
      }),
    );
    state.answerClaims = items.map((item, index) => ({
      claim: item[3],
      evidenceIds: [`e${index}`],
    }));
    const attribute = jest.fn().mockResolvedValue({
      selections: items.map((_, index) => ({ evidenceId: `e${index}` })),
      claims: items.map((item, index) => ({
        claim: item[3],
        supported: true,
        evidenceIds: [`e${index}`],
      })),
      factualClaimCount: 4,
      supportedClaimCount: 4,
      coverage: 1,
    });

    const result = await new BuildRagCitationsUseCase({ attribute }).execute(
      state,
    );

    expect(attribute).toHaveBeenCalledWith(
      expect.objectContaining({ maxCitations: 4 }),
    );
    expect(result.citations).toHaveLength(4);
    expect(result.coverage.coverage).toBe(1);
  });
  it('does not report full fallback coverage when the citation cap drops a supporting source', async () => {
    const state = buildState();
    state.rerankedChunks = Array.from({ length: 4 }, (_, i) => ({
      ...state.rerankedChunks[0],
      chunkId: `source-${i}`,
      evidenceText: `Fact ${i}.`,
      chunkText: `Fact ${i}.`,
    }));
    state.answer = 'Fact 0. Fact 1. Fact 2. Fact 3.';
    state.answerClaims = Array.from({ length: 4 }, (_, i) => ({
      claim: `Fact ${i}.`,
      evidenceIds: [`e${i}`],
    }));
    state.verification = {
      passed: true,
      confidence: 1,
      issues: [],
      requiresRevision: false,
      supportedClaimMappings: state.answerClaims,
      contradictions: [],
    };
    const useCase = new BuildRagCitationsUseCase({
      attribute: jest.fn().mockRejectedValue(new Error('unavailable')),
    });
    const result = await useCase.execute(state);
    expect(result.citations).toHaveLength(3);
    expect(result.coverage).toMatchObject({
      coverage: 0.75,
      supportedClaimCount: 3,
      factualClaimCount: 4,
      unsupportedClaims: ['Fact 3.'],
    });
  });
  it('preserves prompt-local IDs and original source IDs after generation evidence selection', async () => {
    const state = buildState();
    state.generationEvidence = [
      {
        evidenceId: 'e3',
        sourceId: state.rerankedChunks[0].chunkId,
        reelId: 'r1',
        evidenceType: 'VISUAL',
        evidenceText: 'Visible text: Cannot find module @nestjs/config',
      },
    ];
    const attribute = jest.fn().mockResolvedValue({
      selections: [{ evidenceId: 'e3' }],
      coverage: 1,
      factualClaimCount: 1,
      supportedClaimCount: 1,
      claims: [],
    });
    const result = await new BuildRagCitationsUseCase({ attribute }).execute(
      state,
    );
    expect(attribute.mock.calls[0][0].candidates[0].evidenceId).toBe('e3');
    expect(
      result.coverage.diagnostics?.selectedEvidenceMappings?.[0].evidenceId,
    ).toBe(state.rerankedChunks[0].chunkId);
  });
  const buildState = (): RagChatWorkflowState => ({
    userId: 'user-1',
    conversationId: 'conversation-1',
    userMessage: 'What error is visible?',
    answer: 'The visible error says Cannot find module @nestjs/config.',
    retrievedChunks: [],
    rerankedChunks: [
      {
        chunkId: 'reel:r1:visual:0',
        reelId: 'r1',
        title: 'Debugging demo',
        tags: ['nestjs'],
        chunkText: 'Visible text: Cannot find module @nestjs/config',
        retrievalText:
          'Document type: Visual scene\nReel title: Debugging demo\nGrounded visual evidence: Visible text: Cannot find module @nestjs/config',
        evidenceText: 'Visible text: Cannot find module @nestjs/config',
        evidenceType: 'VISUAL',
        startTime: 12.4,
        endTime: 12.4,
        distance: 0.08,
        score: 0.03,
      },
    ],
    route: {
      intent: 'REEL_VIDEO_QUESTION',
      needsRetrieval: true,
      needsUserMemory: false,
      needsConversationSummary: false,
      needsVerification: true,
      reelQuestionType: 'VISUAL_CONTENT',
      requiredEvidence: ['VISUAL'],
      recommendationAction: {
        type: 'NONE',
        reason: 'No recommendation needed.',
      },
      reason: 'The question asks about visible reel content.',
    },
    contextSufficiency: {
      sufficient: true,
      confidence: 1,
      availableEvidence: ['VISUAL'],
      missingEvidence: [],
      reason: 'Grounded visual evidence is available.',
      recommendedAction: 'ANSWER',
    },
    retryCount: 0,
    retrievalRetryCount: 0,
    citationRetryCount: 0,
  });

  it('uses LLM-selected evidence but quotes only grounded evidence text', async () => {
    const attributionService: ICitationAttributionService = {
      attribute: jest.fn().mockResolvedValue({
        selections: [{ evidenceId: 'e0', confidence: 0.98 }],
        claims: [
          {
            claim: 'The visible error says Cannot find module @nestjs/config.',
            supported: true,
            evidenceIds: ['e0'],
            confidence: 0.98,
          },
        ],
        factualClaimCount: 1,
        supportedClaimCount: 1,
        diagnostics: {
          decisionSource: 'LLM',
          selectedEvidenceIds: ['e0'],
          deterministicSupportingEvidenceIds: [],
          semanticCalls: [
            {
              modelRole: 'CITATION_ATTRIBUTION',
              model: 'test/test/citation',
              providerStatus: 200,
              latencyMs: 7,
              configuredTimeoutMs: 4_000,
              configuredMaxCompletionTokens: 768,
              attempt: 1,
              requestId: 'must-not-persist',
            },
          ],
        },
        coverage: 1,
      }),
    };
    const useCase = new BuildRagCitationsUseCase(attributionService);

    const assessment = await useCase.execute(buildState());
    expect(assessment.citations).toEqual([
      {
        sourceType: 'REEL',
        reelId: 'r1',
        evidenceType: 'VISUAL',
        title: 'Debugging demo',
        startTime: 12.4,
        endTime: 12.4,
        quote: 'Visible text: Cannot find module @nestjs/config',
      },
    ]);
    expect(assessment.coverage).toEqual(
      expect.objectContaining({
        mode: 'LLM',
        coverage: 1,
        factualClaimCount: 1,
        supportedClaimCount: 1,
        diagnostics: expect.objectContaining({
          selectedEvidenceIds: ['e0'],
          selectedEvidenceMappings: [
            {
              citationIndex: 0,
              selectedEvidenceId: 'e0',
              evidenceId: 'reel:r1:visual:0',
            },
          ],
          semanticCalls: expect.arrayContaining([
            expect.objectContaining({
              modelRole: 'CITATION_ATTRIBUTION',
              providerStatus: 200,
            }),
          ]),
        }),
      }),
    );
    expect(assessment.citations[0]).not.toHaveProperty('evidenceId');
  });

  it('keeps a focused citation quote when authorized transcript evidence includes context', async () => {
    const state = buildState();
    const evidenceText = `Opening context. ${'Transcript context. '.repeat(20)}The requested sentence. Later context.`;
    state.userMessage =
      'Quote the first complete sentence in the indexed transcript segment.';
    state.answer = 'The requested sentence.';
    state.route = {
      ...state.route!,
      reelQuestionType: 'TRANSCRIPT_CONTENT',
      requiredEvidence: ['TRANSCRIPT'],
    };
    state.rerankedChunks = [
      {
        chunkId: 'reel:r1:chunk:0',
        reelId: 'r1',
        title: 'Debugging demo',
        evidenceType: 'TRANSCRIPT',
        startTime: 4,
        endTime: 30,
        evidenceText,
        chunkText: evidenceText,
        tags: [],
      },
    ] as never;
    state.generationEvidence = [
      {
        evidenceId: 'e0',
        sourceId: 'reel:r1:chunk:0',
        reelId: 'r1',
        evidenceType: 'TRANSCRIPT',
        startTime: 4,
        endTime: 30,
        evidenceText,
      },
    ];
    const attribute = jest.fn().mockResolvedValue({
      selections: [{ evidenceId: 'e0' }],
      claims: [
        {
          claim: state.answer,
          supported: true,
          evidenceIds: ['e0'],
        },
      ],
      factualClaimCount: 1,
      supportedClaimCount: 1,
      coverage: 1,
    });

    const result = await new BuildRagCitationsUseCase({ attribute }).execute(
      state,
    );
    const quote = result.citations[0].quote!;

    expect(quote).toContain(state.answer);
    expect(evidenceText).toContain(quote);
    expect(quote.length).toBeLessThanOrEqual(240);
  });

  it('cites both supported modalities from an extractive multimodal fallback', async () => {
    const state = buildState();
    const transcript = {
      chunkId: 'reel:r1:chunk:0',
      reelId: 'r1',
      title: 'Debugging demo',
      evidenceType: 'TRANSCRIPT' as const,
      evidenceText: 'The speaker says hello.',
      chunkText: 'The speaker says hello.',
      startTime: 0,
      endTime: 4,
      tags: [],
      distance: 0,
      score: 1,
    };
    const visual = state.rerankedChunks[0];
    state.userMessage = 'What is visible and what is said?';
    state.answer =
      'Visible: Visible text: Cannot find module @nestjs/config.\nSpoken: The speaker says hello.';
    state.answerClaims = [
      {
        claim: 'Visible: Visible text: Cannot find module @nestjs/config.',
        evidenceIds: ['e1'],
      },
      {
        claim: 'Spoken: The speaker says hello.',
        evidenceIds: ['e0'],
      },
    ];
    state.route = {
      ...state.route!,
      reelQuestionType: 'MULTIMODAL_CONTENT',
      requiredEvidence: ['TRANSCRIPT', 'VISUAL'],
    };
    state.contextSufficiency = {
      ...state.contextSufficiency!,
      sufficient: true,
      availableEvidence: ['TRANSCRIPT', 'VISUAL'],
      missingEvidence: [],
      supportedEvidenceIds: ['e0', 'e1'],
    };
    state.rerankedChunks = [transcript, visual];
    state.generationEvidence = [
      {
        evidenceId: 'e0',
        sourceId: transcript.chunkId,
        reelId: 'r1',
        evidenceType: 'TRANSCRIPT',
        evidenceText: transcript.evidenceText,
        startTime: transcript.startTime,
        endTime: transcript.endTime,
      },
      {
        evidenceId: 'e1',
        sourceId: visual.chunkId,
        reelId: 'r1',
        evidenceType: 'VISUAL',
        evidenceText: visual.evidenceText,
        startTime: visual.startTime,
        endTime: visual.endTime,
      },
    ];
    const attribution = jest.fn().mockResolvedValue({
      selections: [{ evidenceId: 'e1' }, { evidenceId: 'e0' }],
      claims: [
        {
          claim: state.answerClaims[0].claim,
          supported: true,
          evidenceIds: ['e1'],
        },
        {
          claim: state.answerClaims[1].claim,
          supported: true,
          evidenceIds: ['e0'],
        },
      ],
      factualClaimCount: 2,
      supportedClaimCount: 2,
      coverage: 1,
    });

    const assessment = await new BuildRagCitationsUseCase({
      attribute: attribution,
    }).execute(state);

    expect(assessment.coverage.coverage).toBe(1);
    expect(
      assessment.citations.map((citation) => citation.evidenceType),
    ).toEqual(['VISUAL', 'TRANSCRIPT']);
    expect(assessment.coverage.diagnostics?.selectedEvidenceMappings).toEqual([
      expect.objectContaining({
        selectedEvidenceId: 'e1',
        evidenceId: visual.chunkId,
      }),
      expect.objectContaining({
        selectedEvidenceId: 'e0',
        evidenceId: transcript.chunkId,
      }),
    ]);
  });

  it('reports unsupported claims instead of inventing citations', async () => {
    const attributionService: ICitationAttributionService = {
      attribute: jest.fn().mockResolvedValue({
        selections: [],
        claims: [
          {
            claim: 'The error is caused by a missing production dependency.',
            supported: false,
            evidenceIds: [],
            confidence: 0.95,
          },
        ],
        factualClaimCount: 1,
        supportedClaimCount: 0,
        coverage: 0,
      }),
    };
    const useCase = new BuildRagCitationsUseCase(attributionService);

    const assessment = await useCase.execute(buildState());
    expect(assessment.citations).toEqual([]);
    expect(assessment.coverage.unsupportedClaims).toEqual([
      'The error is caused by a missing production dependency.',
    ]);
  });

  it('fails citation coverage closed when attribution provider fails', async () => {
    const failure = new CitationAttributionProviderError([
      {
        modelRole: 'CITATION_ATTRIBUTION',
        model: 'test/test/citation',
        providerStatus: 'TIMEOUT',
        latencyMs: 4_000,
        configuredTimeoutMs: 4_000,
        configuredMaxCompletionTokens: 768,
        attempt: 1,
        errorCode: 'STRUCTURED_COMPLETION_TIMEOUT',
        providerCategory: 'TRANSIENT_PROVIDER_FAILURE',
      },
    ]);
    const attributionService: ICitationAttributionService = {
      attribute: jest.fn().mockRejectedValue(failure),
    };
    const useCase = new BuildRagCitationsUseCase(attributionService);

    const assessment = await useCase.execute(buildState());
    expect(assessment.citations).toEqual([]);
    expect(assessment.coverage).toMatchObject({
      mode: 'FALLBACK',
      coverage: 0,
      supportedClaimCount: 0,
      diagnostics: { decisionSource: 'FALLBACK', selectedEvidenceIds: [] },
    });
    expect(assessment.coverage.diagnostics).toEqual(
      expect.objectContaining({
        providerStatus: 'ERROR',
        semanticCalls: [
          expect.objectContaining({
            providerStatus: 'TIMEOUT',
            errorCode: 'STRUCTURED_COMPLETION_TIMEOUT',
          }),
        ],
      }),
    );
  });

  it('uses an exact verifier mapping when attribution provider fails', async () => {
    const failure = new CitationAttributionProviderError([
      {
        modelRole: 'CITATION_ATTRIBUTION',
        model: 'test/test/citation',
        providerStatus: 'TIMEOUT',
        latencyMs: 4_000,
        configuredTimeoutMs: 4_000,
        configuredMaxCompletionTokens: 768,
        attempt: 1,
        errorCode: 'STRUCTURED_COMPLETION_TIMEOUT',
        providerCategory: 'TRANSIENT_PROVIDER_FAILURE',
      },
    ]);
    const attributionService: ICitationAttributionService = {
      attribute: jest.fn().mockRejectedValue(failure),
    };
    const state = buildState();
    state.verification = {
      passed: true,
      confidence: 1,
      issues: [],
      requiresRevision: false,
      supportedClaimMappings: [{ claim: state.answer, evidenceIds: ['e0'] }],
      contradictions: [],
    };
    const useCase = new BuildRagCitationsUseCase(attributionService);

    const assessment = await useCase.execute(state);

    expect(assessment.citations).toHaveLength(1);
    expect(assessment.coverage).toMatchObject({
      mode: 'FALLBACK',
      coverage: 1,
      factualClaimCount: 1,
      supportedClaimCount: 1,
      diagnostics: {
        decisionSource: 'FALLBACK',
        selectedEvidenceIds: ['e0'],
        providerStatus: 'ERROR',
      },
    });
  });

  it.each([
    [
      'Who is the shot detector being presented to?',
      'Olivier.',
      'The shot detector is being presented to Olivier.',
    ],
    [
      'What example label is used for a marble in a bag?',
      'Blue.',
      'The marble put in the bag is assigned the blue label.',
    ],
    [
      'How many frequency bands is the speaker currently using?',
      'Fifteen frequency bands.',
      'What I am using are 15 frequency bands.',
    ],
    [
      'How low can the number of bands go while still being okay?',
      'About twelve bands.',
      'We can go down till like 12 bands and it is still okay.',
    ],
  ])(
    'does not override a semantic citation rejection for a compact fact',
    async (question, answer, evidenceText) => {
      const attributionService: ICitationAttributionService = {
        attribute: jest.fn().mockResolvedValue({
          selections: [],
          claims: [{ claim: answer, supported: false, evidenceIds: [] }],
          factualClaimCount: 1,
          supportedClaimCount: 0,
          coverage: 0,
        }),
      };
      const useCase = new BuildRagCitationsUseCase(attributionService);
      const state = buildState();
      state.userMessage = question;
      state.answer = answer;
      state.rerankedChunks[0] = {
        ...state.rerankedChunks[0],
        evidenceType: 'TRANSCRIPT',
        evidenceText,
        chunkText: evidenceText,
      };

      await expect(useCase.execute(state)).resolves.toMatchObject({
        citations: [],
        coverage: {
          mode: 'LLM',
          coverage: 0,
          factualClaimCount: 1,
          supportedClaimCount: 0,
          diagnostics: {
            decisionSource: 'LLM',
            deterministicSupportingEvidenceIds: [],
          },
        },
      });
    },
  );

  it('preserves partial semantic coverage without fabricating support', async () => {
    const attributionService: ICitationAttributionService = {
      attribute: jest.fn().mockResolvedValue({
        selections: [{ evidenceId: 'e0', confidence: 0.9 }],
        claims: [
          {
            claim: 'The example label used for a marble in the bag is blue.',
            supported: true,
            evidenceIds: ['e0'],
            confidence: 0.9,
          },
          {
            claim: 'The marble is put into a bag.',
            supported: false,
            evidenceIds: [],
            confidence: 0.9,
          },
        ],
        factualClaimCount: 2,
        supportedClaimCount: 1,
        coverage: 0.5,
      }),
    };
    const useCase = new BuildRagCitationsUseCase(attributionService);
    const state = buildState();
    state.userMessage =
      'What example label is used for a marble that is put into a bag?';
    state.answer =
      'The example label used for a marble that is put into a bag is blue.';
    state.rerankedChunks[0] = {
      ...state.rerankedChunks[0],
      chunkId: 'reel:in1005:chunk:1',
      reelId: 'in1005',
      evidenceType: 'TRANSCRIPT',
      evidenceText:
        'Those two marbles are compared. This one is said to be blue, for example. I put it in the blue bag. I do not know if it is the label.',
      chunkText:
        'Those two marbles are compared. This one is said to be blue, for example. I put it in the blue bag. I do not know if it is the label.',
    };

    await expect(useCase.execute(state)).resolves.toMatchObject({
      citations: [expect.objectContaining({ reelId: 'in1005' })],
      coverage: {
        mode: 'LLM',
        coverage: 0.5,
        factualClaimCount: 2,
        supportedClaimCount: 1,
        diagnostics: {
          deterministicSupportingEvidenceIds: [],
        },
      },
    });
  });

  it('does not repair a topic-only citation attribution failure', async () => {
    const attributionService: ICitationAttributionService = {
      attribute: jest.fn().mockResolvedValue({
        selections: [],
        claims: [{ claim: 'Blue.', supported: false, evidenceIds: [] }],
        factualClaimCount: 1,
        supportedClaimCount: 0,
        coverage: 0,
      }),
    };
    const useCase = new BuildRagCitationsUseCase(attributionService);
    const state = buildState();
    state.userMessage = 'What label is assigned to the marble in the bag?';
    state.answer = 'Blue.';
    state.rerankedChunks[0] = {
      ...state.rerankedChunks[0],
      evidenceType: 'TRANSCRIPT',
      evidenceText: 'A blue marble is beside a bag.',
      chunkText: 'A blue marble is beside a bag.',
    };

    await expect(useCase.execute(state)).resolves.toMatchObject({
      citations: [],
      coverage: { mode: 'LLM', coverage: 0 },
    });
  });

  it('does not emit citations for insufficient context', async () => {
    const attributionService: ICitationAttributionService = {
      attribute: jest.fn(),
    };
    const useCase = new BuildRagCitationsUseCase(attributionService);
    const state = {
      ...buildState(),
      contextSufficiency: { sufficient: false },
    } as RagChatWorkflowState;

    await expect(useCase.execute(state)).resolves.toMatchObject({
      citations: [],
      coverage: {
        mode: 'NOT_REQUIRED',
        coverage: 1,
        factualClaimCount: 0,
        supportedClaimCount: 0,
        unsupportedClaims: [],
        diagnostics: { decisionSource: 'NOT_REQUIRED' },
      },
    });
    expect(attributionService.attribute).not.toHaveBeenCalled();
  });

  it('keeps citations enabled for a successful semantic negative with typed evidence', async () => {
    const attributionService: ICitationAttributionService = {
      attribute: jest.fn().mockResolvedValue({
        selections: [{ evidenceId: 'e0', confidence: 0.98 }],
        claims: [
          {
            claim: 'The visible error says Cannot find module @nestjs/config.',
            supported: true,
            evidenceIds: ['e0'],
            confidence: 0.98,
          },
        ],
        factualClaimCount: 1,
        supportedClaimCount: 1,
        coverage: 1,
      }),
    };
    const useCase = new BuildRagCitationsUseCase(attributionService);
    const state = {
      ...buildState(),
      contextSufficiency: {
        sufficient: false,
        confidence: 0.2,
        availableEvidence: ['VISUAL'],
        missingEvidence: ['VISUAL'],
        reason: 'Semantic negative.',
        recommendedAction: 'REFUSE_NO_CONTEXT',
        diagnostics: { providerStatus: 'SUCCESS', decisionSource: 'LLM' },
      },
    } as RagChatWorkflowState;

    await expect(useCase.execute(state)).resolves.toMatchObject({
      citations: [expect.objectContaining({ reelId: 'r1' })],
      coverage: { mode: 'LLM', coverage: 1 },
    });
    expect(attributionService.attribute).toHaveBeenCalledTimes(1);
  });

  it('does not attach accessible Reel citations to a no-context refusal', async () => {
    const attributionService: ICitationAttributionService = {
      attribute: jest.fn(),
    };
    const useCase = new BuildRagCitationsUseCase(attributionService);
    const state = {
      ...buildState(),
      answer: "I don't have enough information to summarize that Reel.",
      contextSufficiency: {
        sufficient: false,
        availableEvidence: ['TRANSCRIPT'],
        missingEvidence: ['TRANSCRIPT'],
        recommendedAction: 'REFUSE_NO_CONTEXT',
        diagnostics: { providerStatus: 'SUCCESS', decisionSource: 'LLM' },
      },
    } as RagChatWorkflowState;

    await expect(useCase.execute(state)).resolves.toMatchObject({
      citations: [],
      coverage: { mode: 'NOT_REQUIRED', coverage: 1 },
    });
    expect(attributionService.attribute).not.toHaveBeenCalled();
  });

  it('falls back to verifier-supported evidence when attribution returns no usable selection', async () => {
    const attributionService: ICitationAttributionService = {
      attribute: jest.fn().mockResolvedValue({
        selections: [],
        claims: [
          {
            claim: 'The visible error is supported.',
            supported: false,
            evidenceIds: [],
          },
        ],
        factualClaimCount: 1,
        supportedClaimCount: 0,
        coverage: 0,
      }),
    };
    const useCase = new BuildRagCitationsUseCase(attributionService);
    const state = buildState();
    state.verification = {
      passed: true,
      confidence: 0.95,
      issues: [],
      requiresRevision: false,
      supportedClaimMappings: [
        {
          claim: 'The visible error is supported.',
          evidenceIds: ['e0'],
        },
      ],
      contradictions: [],
    };

    await expect(useCase.execute(state)).resolves.toMatchObject({
      citations: [expect.objectContaining({ reelId: 'r1' })],
      coverage: {
        mode: 'FALLBACK',
        coverage: 1,
        factualClaimCount: 1,
        supportedClaimCount: 1,
        diagnostics: {
          decisionSource: 'FALLBACK',
          selectedEvidenceIds: ['e0'],
          providerStatus: 'SUCCESS',
        },
      },
    });
  });

  it('attributes citations for METADATA evidence when evidenceText is empty but title is present', async () => {
    const attribute = jest.fn().mockImplementation(() =>
      Promise.resolve({
        selections: [{ evidenceId: 'e0', confidence: 0.98 }],
        claims: [
          {
            claim: 'This Reel is titled Pet Chat Group Episode 22.',
            supported: true,
            evidenceIds: ['e0'],
          },
        ],
        factualClaimCount: 1,
        supportedClaimCount: 1,
        coverage: 1,
      }),
    );
    const attributionService: ICitationAttributionService = { attribute };
    const useCase = new BuildRagCitationsUseCase(attributionService);
    const state = buildState();
    state.rerankedChunks = [
      {
        chunkId: 'reel:r1:doc',
        reelId: 'r1',
        title: 'Pet Chat Group Episode 22',
        tags: [],
        chunkText: '',
        evidenceText: undefined,
        evidenceType: 'METADATA',
        startTime: null,
        endTime: null,
        distance: null,
        score: 0.9,
      },
    ];
    state.answer = 'This Reel is titled Pet Chat Group Episode 22.';

    const result = await useCase.execute(state);

    expect(attribute).toHaveBeenCalledWith(
      expect.objectContaining({
        candidates: [
          expect.objectContaining({
            evidenceId: 'e0',
            evidenceType: 'METADATA',
            evidenceText: 'Pet Chat Group Episode 22',
            title: 'Pet Chat Group Episode 22',
          }),
        ],
      }),
    );
    expect(result.citations).toHaveLength(1);
    expect(result.citations[0].evidenceType).toBe('METADATA');
  });
});
