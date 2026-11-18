import type { RagChatWorkflowState } from '@ai/domain/interfaces/rag-chat-workflow.interface';
import { RecallConversationContextUseCase } from './recall-conversation-context.use-case';

const older = [
  'I love making spaghetti carbonara on weekends',
  'How do I edit my profile?',
  'what tools do you have?',
].map((content, index) => ({
  role: 'user' as const,
  content,
  createdAt: `2026-11-19T00:00:0${index}Z`,
}));

const state = (overrides: Record<string, unknown> = {}) =>
  ({
    userId: 'alice',
    conversationId: 'c1',
    userMessage: 'what food did I mention earlier?',
    route: { intent: 'CONVERSATION_MEMORY_QUESTION' },
    memory: { recentMessages: [], olderMessages: older },
    ...overrides,
  }) as unknown as RagChatWorkflowState;

const unit = (opts: {
  batch?: (request: never) => Promise<unknown>;
  memories?: unknown;
  blocks?: (text: string) => boolean;
  timeout?: string;
}) => {
  const batch = {
    execute: jest.fn(
      opts.batch ??
        ((request: { items: Array<{ id: string; text: string }> }) =>
          Promise.resolve({
            // Meaning is faked by content, so the order candidates arrive in does not matter.
            embeddings: request.items.map((item) => ({
              id: item.id,
              dimensions: 2,
              values:
                item.id === 'question'
                  ? [1, 0]
                  : item.text.includes('spaghetti')
                    ? [0.9, 0.1]
                    : [0, 1],
            })),
            errors: [],
          })),
    ),
  };
  const memories = {
    execute: jest.fn(() =>
      Promise.resolve(
        opts.memories ?? {
          memories: [{ id: 'u1', userId: 'alice', content: 'Likes pasta' }],
        },
      ),
    ),
  };
  const screen = {
    blocks: jest.fn((texts: string[]) => opts.blocks?.(texts[0]) ?? false),
  };
  const config = {
    get: (key: string) =>
      key === 'AI_RECALL_EMBEDDING_TIMEOUT_MS' ? opts.timeout : undefined,
  };
  return {
    batch,
    memories,
    useCase: new RecallConversationContextUseCase(
      config as never,
      batch as never,
      memories as never,
      screen as never,
    ),
  };
};

describe('RecallConversationContextUseCase', () => {
  it('does nothing for other intents', async () => {
    const { useCase, batch, memories } = unit({});
    expect(
      await useCase.execute(
        state({
          route: { intent: 'NORMAL_CHAT' },
          userMessage: 'recommend videos about woodworking',
        }),
      ),
    ).toEqual({});
    expect(batch.execute).not.toHaveBeenCalled();
    expect(memories.execute).not.toHaveBeenCalled();
  });

  it('recalls the older message by meaning and adds the user facts', async () => {
    const { useCase } = unit({});
    const result = await useCase.execute(state());
    expect(result.recalledMessages?.map((m) => m.content)).toEqual([
      older[0].content,
    ]);
    expect(result.userMemories?.memories).toHaveLength(1);
    expect(result.memorySelection).toMatchObject({
      includeUserMemory: true,
      includeRecentHistory: true,
    });
  });

  it('falls back to word match when the embedding service fails', async () => {
    const { useCase } = unit({
      batch: () => Promise.reject(new Error('tei down')),
    });
    const result = await useCase.execute(
      state({ userMessage: 'do you remember the spaghetti?' }),
    );
    expect(result.recalledMessages?.map((m) => m.content)).toEqual([
      older[0].content,
    ]);
  });

  it('stops waiting for a slow embedding service and uses word match', async () => {
    const { useCase } = unit({
      batch: () => new Promise(() => undefined),
      timeout: '500',
    });
    const started = Date.now();
    const result = await useCase.execute(
      state({ userMessage: 'do you remember the spaghetti?' }),
    );
    expect(Date.now() - started).toBeLessThan(2_000);
    expect(result.recalledMessages).toHaveLength(1);
  });

  it('never recalls a message the memory guardrail blocks', async () => {
    const { useCase } = unit({ blocks: (text) => text.includes('spaghetti') });
    const result = await useCase.execute(state());
    expect(result.recalledMessages).toEqual([]);
  });

  it('keeps going without user memory when that lookup fails', async () => {
    const { useCase, memories } = unit({});
    memories.execute.mockRejectedValueOnce(new Error('db down'));
    const result = await useCase.execute(state());
    expect(result.userMemories).toBeUndefined();
    expect(result.recalledMessages).toHaveLength(1);
    expect(result.memorySelection).toMatchObject({ includeUserMemory: false });
  });

  it('reuses user memory already in state instead of searching again', async () => {
    const { useCase, memories } = unit({});
    const existing = {
      memories: [{ id: 'x', userId: 'alice', content: 'Likes tea' }],
    };
    const result = await useCase.execute(state({ userMemories: existing }));
    expect(memories.execute).not.toHaveBeenCalled();
    expect(result.userMemories).toBe(existing);
  });
});
