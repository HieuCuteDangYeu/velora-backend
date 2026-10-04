import { ContextToolAgentUseCase } from './context-tool-agent.use-case';
import { RerankRetrievedEvidenceUseCase } from './rerank-retrieved-evidence.use-case';
import type { RagChatWorkflowState } from '@ai/domain/interfaces/rag-chat-workflow.interface';

const match = {
  chunkId: 'chunk-1',
  reelId: 'reel-1',
  title: 'Docker tutorial',
  tags: [],
  chunkText: 'Docker packages applications and dependencies.',
  evidenceText: 'Docker packages applications and dependencies.',
  evidenceType: 'TRANSCRIPT' as const,
  startTime: 10,
  endTime: 15,
  distance: 0.1,
  score: 0.9,
  matchedBy: 'HYBRID' as const,
};

const route = {
  intent: 'REEL_VIDEO_QUESTION' as const,
  referenceTarget: 'SHARED_REEL' as const,
  needsRetrieval: true,
  needsUserMemory: false,
  needsConversationSummary: false,
  needsVerification: true,
  reelQuestionType: 'TRANSCRIPT_CONTENT' as const,
  requiredEvidence: ['TRANSCRIPT' as const],
  recommendationAction: { type: 'NONE' as const, reason: 'not needed' },
  toolPlan: {
    allowedTools: ['search_reel_content', 'get_reel_context'] as const,
    requiredTools: ['search_reel_content'] as const,
  },
  reason: 'reel question',
};

const config = {
  get: jest.fn().mockReturnValue(undefined),
  maxCompletionTokens: jest.fn().mockReturnValue(500),
};

const policy = {
  model: 'test/test/context-tool',
  maxSteps: 3,
  maxParallelCalls: 2,
  callTimeoutMs: 8_000,
};

const state = (overrides: Partial<RagChatWorkflowState> = {}) =>
  ({
    userId: 'user-1',
    conversationId: 'conversation-1',
    userMessage: 'What did the speaker say about Docker?',
    accessibleReelIds: ['reel-1'],
    hasSharedReelContext: true,
    route,
    retrievedChunks: [],
    rerankedChunks: [],
    retryCount: 0,
    retrievalRetryCount: 0,
    citationRetryCount: 0,
    draftHistory: [],
    draftRevision: 0,
    citationAttempts: [],
    nextDraftSource: 'INITIAL',
    finalFailureSource: 'UNKNOWN',
    ...overrides,
  }) as RagChatWorkflowState;

function buildAgent(
  overrides: {
    toolLlm?: { complete: jest.Mock };
    retrievalEngine?: {
      retrieve: jest.Mock;
      rerank: jest.Mock;
    };
    userMemory?: { execute: jest.Mock };
    conversationMemory?: { execute: jest.Mock };
  } = {},
) {
  const retrievalEngine = overrides.retrievalEngine ?? {
    retrieve: jest.fn().mockResolvedValue([match]),
    rerank: jest.fn().mockResolvedValue([match]),
  };
  const toolLlm = overrides.toolLlm ?? {
    complete: jest
      .fn()
      .mockResolvedValueOnce({
        toolCalls: [
          {
            id: 'call-1',
            name: 'search_reel_content',
            arguments: { query: 'Docker dependencies', limit: 5 },
          },
        ],
      })
      .mockResolvedValueOnce({ toolCalls: [] }),
  };
  const userMemory = overrides.userMemory ?? {
    execute: jest.fn().mockResolvedValue({ memories: [] }),
  };
  const conversationMemory = overrides.conversationMemory ?? {
    execute: jest.fn().mockResolvedValue({
      conversationId: 'conversation-1',
      summary: 'Conversation summary',
    }),
  };

  return {
    agent: new ContextToolAgentUseCase(
      toolLlm,
      retrievalEngine as never,
      new RerankRetrievedEvidenceUseCase(retrievalEngine as never),
      userMemory as never,
      conversationMemory as never,
      config as never,
      policy,
    ),
    toolLlm,
    retrievalEngine,
    userMemory,
    conversationMemory,
  };
}

describe('ContextToolAgentUseCase', () => {
  it('records bounded provider failure diagnostics without response content', async () => {
    const error = Object.assign(new Error('secret provider response'), {
      code: 'TOOL_PROVIDER_HTTP_ERROR',
      httpStatus: 429,
    });
    const built = buildAgent({
      toolLlm: { complete: jest.fn().mockRejectedValue(error) },
    });
    const result = await built.agent.execute(state());
    expect(result.contextToolExecution.failures).toEqual([
      {
        stage: 'TOOL_MODEL',
        errorCode: 'TOOL_PROVIDER_HTTP_ERROR',
        httpStatus: 429,
      },
    ]);
    expect(JSON.stringify(result.contextToolExecution)).not.toContain('secret');
  });
  it.each(['search_reel_content', 'get_reel_context'])(
    'preserves the original opening constraint through %s query rewrites',
    async (name) => {
      const built = buildAgent({
        toolLlm: {
          complete: jest
            .fn()
            .mockResolvedValueOnce({
              toolCalls: [
                {
                  id: 'call',
                  name,
                  arguments: {
                    reelId: 'reel-1',
                    query: 'Docker dependencies',
                    limit: 20,
                  },
                },
              ],
            })
            .mockResolvedValueOnce({ toolCalls: [] }),
        },
      });
      await built.agent.execute(
        state({ userMessage: 'What is the opening statement?' }),
      );
      expect(built.retrievalEngine.retrieve).toHaveBeenCalledWith(
        expect.objectContaining({
          accessibleReelIds: ['reel-1'],
          plan: expect.objectContaining({
            sourceOrder: 'ASC',
            searchLimit: 1,
            shouldRerank: false,
          }),
        }),
      );
    },
  );

  it('preserves opening order when the tool provider fails', async () => {
    const built = buildAgent({
      toolLlm: {
        complete: jest.fn().mockRejectedValue(new Error('unavailable')),
      },
    });
    await built.agent.execute(
      state({ userMessage: 'What is the first sentence?' }),
    );
    expect(built.retrievalEngine.retrieve).toHaveBeenCalledWith(
      expect.objectContaining({
        plan: expect.objectContaining({
          sourceOrder: 'ASC',
          shouldRerank: false,
        }),
      }),
    );
  });

  it('does not reinterpret a metadata question as transcript retrieval', async () => {
    const built = buildAgent();
    await built.agent.execute(
      state({
        route: {
          ...route,
          reelQuestionType: 'REEL_METADATA',
          requiredEvidence: ['METADATA'],
        },
      }),
    );
    expect(built.retrievalEngine.retrieve).toHaveBeenCalledWith(
      expect.objectContaining({
        route: expect.objectContaining({ requiredEvidence: ['METADATA'] }),
        plan: expect.objectContaining({ shouldRerank: false, searchLimit: 5 }),
      }),
    );
  });
  it('uses only router-approved Reel tools and reranks returned evidence', async () => {
    const built = buildAgent();

    const result = await built.agent.execute(state());

    expect(result.rerankedChunks).toEqual([match]);
    expect(built.retrievalEngine.retrieve).toHaveBeenCalledWith(
      expect.objectContaining({ accessibleReelIds: ['reel-1'] }),
    );
    expect(built.toolLlm.complete).toHaveBeenCalledWith(
      expect.objectContaining({
        model: 'test/test/context-tool',
        tools: expect.arrayContaining([
          expect.objectContaining({ name: 'search_reel_content' }),
          expect.objectContaining({ name: 'get_reel_context' }),
        ]),
        toolChoice: 'required',
      }),
    );
    expect(result.contextToolExecution.calls).toEqual([
      expect.objectContaining({
        toolName: 'search_reel_content',
        status: 'SUCCESS',
        itemCount: 1,
      }),
    ]);
  });

  it('injects the trusted user ID into memory search and does not expose Reel tools', async () => {
    const toolLlm = {
      complete: jest
        .fn()
        .mockResolvedValueOnce({
          toolCalls: [
            {
              id: 'call-1',
              name: 'search_user_memory',
              arguments: { query: 'preferred database', limit: 3 },
            },
          ],
        })
        .mockResolvedValueOnce({ toolCalls: [] }),
    };
    const userMemory = {
      execute: jest.fn().mockResolvedValue({
        memories: [
          {
            id: 'memory-1',
            userId: 'user-1',
            type: 'PREFERENCE',
            content: 'The user prefers PostgreSQL.',
            confidence: 0.9,
          },
        ],
      }),
    };
    const built = buildAgent({ toolLlm, userMemory });
    const memoryRoute = {
      ...route,
      intent: 'USER_MEMORY_QUESTION' as const,
      referenceTarget: 'USER_MEMORY' as const,
      needsRetrieval: false,
      requiredEvidence: ['USER_MEMORY' as const],
      toolPlan: {
        allowedTools: ['search_user_memory'] as const,
        requiredTools: ['search_user_memory'] as const,
      },
    };

    const result = await built.agent.execute(
      state({ route: memoryRoute, accessibleReelIds: [] }),
    );

    expect(userMemory.execute).toHaveBeenCalledWith({
      userId: 'user-1',
      queryText: 'preferred database',
      limit: 3,
    });
    expect(built.toolLlm.complete.mock.calls[0][0].tools).toEqual([
      expect.objectContaining({ name: 'search_user_memory' }),
    ]);
    expect(result.userMemories?.memories).toHaveLength(1);
    expect(built.retrievalEngine.retrieve).not.toHaveBeenCalled();
  });

  it('denies a Reel outside the resolved access scope', async () => {
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
    const built = buildAgent({ toolLlm });

    const result = await built.agent.execute(state());

    expect(built.retrievalEngine.retrieve).not.toHaveBeenCalled();
    expect(result.contextToolExecution.calls).toEqual([
      expect.objectContaining({
        toolName: 'get_reel_context',
        status: 'DENIED',
      }),
    ]);
  });

  it('falls back to retrieved chunks when reranking fails', async () => {
    const retrievalEngine = {
      retrieve: jest.fn().mockResolvedValue([match]),
      rerank: jest
        .fn()
        .mockRejectedValue(
          new Error('TEI reranker failed with status 429: Overloaded'),
        ),
    };
    const built = buildAgent({ retrievalEngine });

    const result = await built.agent.execute(state());

    expect(result.retrievedChunks).toHaveLength(1);
    expect(result.rerankedChunks).toHaveLength(1);
    expect(result.rerankedChunks[0].chunkId).toBe('chunk-1');
  });
});
