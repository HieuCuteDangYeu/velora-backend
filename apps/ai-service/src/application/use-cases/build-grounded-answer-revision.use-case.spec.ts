import type { RagChatWorkflowState } from '@ai/domain/interfaces/rag-chat-workflow.interface';
import { BuildGroundedAnswerRevisionUseCase } from './build-grounded-answer-revision.use-case';

describe('BuildGroundedAnswerRevisionUseCase', () => {
  const structuredLlm = { generateObject: jest.fn() };
  const config = {
    model: jest.fn().mockReturnValue('@cf/test/answer-revision'),
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
      route: { intent: 'REEL_VIDEO_QUESTION' },
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

  beforeEach(() => jest.clearAllMocks());

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
    });
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
});
