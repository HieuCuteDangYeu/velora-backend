import {
  CitationAttributionProviderError,
  type ICitationAttributionService,
} from '@ai/domain/interfaces/citation-attribution.service.interface';
import type { RagChatWorkflowState } from '@ai/domain/interfaces/rag-chat-workflow.interface';
import { BuildRagCitationsUseCase } from './build-rag-citations.use-case';

describe('BuildRagCitationsUseCase', () => {
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
});
