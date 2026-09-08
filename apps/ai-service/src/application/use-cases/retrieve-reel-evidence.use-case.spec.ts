import { RetrieveReelEvidenceUseCase } from './retrieve-reel-evidence.use-case';
import type { RagRetrievalExecutionDiagnostics } from '@ai/domain/interfaces/rag-chat-workflow.interface';

const route = {
  intent: 'REEL_VIDEO_QUESTION' as const,
  needsRetrieval: true,
  needsUserMemory: false,
  needsConversationSummary: false,
  needsVerification: true,
  reelQuestionType: 'TRANSCRIPT_CONTENT' as const,
  requiredEvidence: ['TRANSCRIPT' as const],
  recommendationAction: { type: 'NONE' as const, reason: 'not needed' },
  reason: 'video question',
};

const plan = {
  mode: 'REEL_HYBRID' as const,
  query: 'How was Postgres configured?',
  queries: ['How was Postgres configured?'],
  searchLimit: 8,
  rerankLimit: 5,
  shouldRerank: true,
  reason: 'retrieve reel evidence',
};

const match = {
  chunkId: 'chunk-1',
  reelId: 'reel-1',
  title: 'Postgres tutorial',
  tags: ['postgresql'],
  chunkText: 'PostgreSQL setup steps',
  retrievalText: 'PostgreSQL setup steps',
  evidenceText: 'PostgreSQL setup steps',
  evidenceType: 'TRANSCRIPT' as const,
  startTime: 10,
  endTime: 20,
  distance: 0.1,
  score: 0.9,
  matchedBy: 'HYBRID' as const,
};

const enabledPolicy = {
  enabled: true,
  model: 'test/test/tool-model',
  maxSteps: 3,
  maxParallelCalls: 2,
  callTimeoutMs: 8_000,
};

const aiConfig = {
  maxCompletionTokens: jest.fn(() => 500),
};

describe('RetrieveReelEvidenceUseCase', () => {
  it('executes a model-selected high-level search through the retrieval engine port', async () => {
    const toolLlm = {
      complete: jest
        .fn()
        .mockResolvedValueOnce({
          toolCalls: [
            {
              id: 'call-1',
              name: 'search_reel_content',
              arguments: {
                query: 'postgres setup',
                mode: 'REEL_HYBRID',
                evidence: ['TRANSCRIPT'],
                limit: 5,
              },
            },
          ],
        })
        .mockResolvedValueOnce({ toolCalls: [], content: 'enough context' }),
    };
    const retrievalEngine = {
      plan: jest.fn().mockResolvedValue(plan),
      retrieve: jest.fn().mockResolvedValue([match]),
      rerank: jest.fn().mockResolvedValue([match]),
    };
    const content = {
      resolveReelContextAccess: jest.fn().mockResolvedValue(['reel-1']),
    };
    const useCase = new RetrieveReelEvidenceUseCase(
      retrievalEngine,
      content as never,
      toolLlm,
      enabledPolicy,
      aiConfig as never,
    );

    const result = await useCase.execute({
      userId: 'user-1',
      conversationId: 'conversation-1',
      accessibleReelIds: ['reel-1'],
      route,
      plan,
    });

    expect(result).toEqual([match]);
    expect(retrievalEngine.retrieve).toHaveBeenCalledWith(
      expect.objectContaining({
        accessibleReelIds: ['reel-1'],
        route: expect.objectContaining({ requiredEvidence: ['TRANSCRIPT'] }),
        plan: expect.objectContaining({
          query: 'postgres setup',
          mode: 'REEL_HYBRID',
          searchLimit: 5,
        }),
      }),
    );
    expect(toolLlm.complete).toHaveBeenCalledTimes(2);
    expect(toolLlm.complete).toHaveBeenCalledWith(
      expect.objectContaining({
        model: enabledPolicy.model,
        timeoutMs: enabledPolicy.callTimeoutMs,
      }),
    );
  });

  it('does not let get_reel_context widen the resolved reel access scope', async () => {
    const toolLlm = {
      complete: jest
        .fn()
        .mockResolvedValueOnce({
          toolCalls: [
            {
              id: 'call-1',
              name: 'get_reel_context',
              arguments: { reelId: 'private-reel', query: 'secret' },
            },
          ],
        })
        .mockResolvedValueOnce({ toolCalls: [] }),
    };
    const retrievalEngine = {
      plan: jest.fn().mockResolvedValue(plan),
      retrieve: jest.fn().mockResolvedValue([]),
      rerank: jest.fn().mockResolvedValue([]),
    };
    const useCase = new RetrieveReelEvidenceUseCase(
      retrievalEngine,
      { resolveReelContextAccess: jest.fn() } as never,
      toolLlm,
      enabledPolicy,
      aiConfig as never,
    );

    await useCase.execute({
      userId: 'user-1',
      conversationId: 'conversation-1',
      accessibleReelIds: ['reel-1'],
      route,
      plan: { ...plan, searchLimit: 3, rerankLimit: 3 },
    });

    expect(retrievalEngine.retrieve).toHaveBeenCalledTimes(1);
    expect(retrievalEngine.retrieve).toHaveBeenCalledWith(
      expect.objectContaining({ accessibleReelIds: ['reel-1'] }),
    );
  });

  it('delegates directly to the deterministic engine when tool calling is disabled', async () => {
    const retrievalEngine = {
      plan: jest.fn().mockResolvedValue(plan),
      retrieve: jest.fn().mockResolvedValue([match]),
      rerank: jest.fn().mockResolvedValue([match]),
    };
    const useCase = new RetrieveReelEvidenceUseCase(
      retrievalEngine,
      { resolveReelContextAccess: jest.fn() } as never,
      { complete: jest.fn() },
      { ...enabledPolicy, enabled: false },
      aiConfig as never,
    );

    await expect(
      useCase.execute({
        userId: 'user-1',
        conversationId: 'conversation-1',
        route,
        plan,
        accessibleReelIds: ['reel-1'],
      }),
    ).resolves.toEqual([match]);

    expect(retrievalEngine.retrieve).toHaveBeenCalledTimes(1);
  });

  it('records an empty access scope without invoking retrieval', async () => {
    const retrievalEngine = {
      plan: jest.fn().mockResolvedValue(plan),
      retrieve: jest.fn(),
      rerank: jest.fn(),
    };
    const diagnostics: RagRetrievalExecutionDiagnostics = {
      accessibleReelCount: 0,
      accessibleReelIds: [],
      queryCount: 0,
      queries: [],
      retrievedCount: 0,
      rerankedCount: 0,
    };
    const useCase = new RetrieveReelEvidenceUseCase(
      retrievalEngine,
      { resolveReelContextAccess: jest.fn() } as never,
      { complete: jest.fn() },
      enabledPolicy,
      aiConfig as never,
    );

    await expect(
      useCase.execute({
        userId: 'user-1',
        conversationId: 'conversation-1',
        route,
        plan,
        accessibleReelIds: [],
        diagnostics,
      }),
    ).resolves.toEqual([]);

    expect(retrievalEngine.retrieve).not.toHaveBeenCalled();
    expect(diagnostics).toEqual(
      expect.objectContaining({ accessibleReelCount: 0, queryCount: 0 }),
    );
  });

  it('records access-resolution failures without changing the thrown error', async () => {
    const retrievalEngine = {
      plan: jest.fn().mockResolvedValue(plan),
      retrieve: jest.fn(),
      rerank: jest.fn(),
    };
    const accessFailure = Object.assign(new Error('access unavailable'), {
      code: 'CONTENT_ACCESS_ERROR',
    });
    const diagnostics: RagRetrievalExecutionDiagnostics = {
      accessibleReelCount: 0,
      accessibleReelIds: [],
      queryCount: 0,
      queries: [],
      retrievedCount: 0,
      rerankedCount: 0,
    };
    const useCase = new RetrieveReelEvidenceUseCase(
      retrievalEngine,
      {
        resolveReelContextAccess: jest.fn().mockRejectedValue(accessFailure),
      } as never,
      { complete: jest.fn() },
      enabledPolicy,
      aiConfig as never,
    );

    await expect(
      useCase.execute({
        userId: 'user-1',
        conversationId: 'conversation-1',
        route,
        plan,
        diagnostics,
      }),
    ).rejects.toBe(accessFailure);
    expect(diagnostics).toEqual(
      expect.objectContaining({
        failedStage: 'ACCESS_RESOLUTION',
        errorCode: 'CONTENT_ACCESS_ERROR',
      }),
    );
  });
});
