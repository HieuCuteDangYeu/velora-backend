import type { RagChatWorkflowState } from '../interfaces/rag-chat-workflow.interface';
import { ragMemoryEvidence } from './rag-memory-evidence';

const state = (overrides: Record<string, unknown> = {}) =>
  ({
    userId: 'alice',
    conversationId: 'current',
    route: { intent: 'USER_MEMORY_QUESTION' },
    userMemories: {
      memories: [
        { id: 'mine', userId: 'alice', content: 'I prefer TypeScript.' },
        { id: 'foreign', userId: 'bob', content: 'PRIVATE_CANARY' },
      ],
    },
    ...overrides,
  }) as unknown as RagChatWorkflowState;
const config = { get: <T>() => undefined as T | undefined };

describe('ragMemoryEvidence', () => {
  it('includes only the authenticated user facts and keeps them out of Reel evidence', () => {
    expect(ragMemoryEvidence(state(), config)).toEqual([
      {
        evidenceId: 'm0',
        sourceId: 'user-memory:mine',
        evidenceType: 'USER_MEMORY',
        evidenceText: 'I prefer TypeScript.',
      },
    ]);
    expect(
      ragMemoryEvidence(
        state({ route: { intent: 'REEL_VIDEO_QUESTION' } }),
        config,
      ),
    ).toEqual([]);
  });
  it('rejects a foreign conversation summary and preserves recent correction provenance', () => {
    const result = ragMemoryEvidence(
      state({
        route: { intent: 'CONVERSATION_MEMORY_QUESTION' },
        conversationMemory: {
          conversationId: 'foreign',
          summary: 'PRIVATE_CANARY',
        },
        memory: {
          recentMessages: [
            {
              role: 'user',
              content: 'Correction: the milestone is release review.',
              createdAt: '2026-10-06T00:00:00Z',
            },
          ],
        },
      }),
      config,
    );
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      evidenceType: 'CONVERSATION_MEMORY',
      sourceId: 'conversation-message:current:0',
    });
    expect(result[0].evidenceText).toContain('Correction:');
    expect(JSON.stringify(result)).not.toContain('PRIVATE_CANARY');
  });
  it('bounds memory facts without promoting share events into memory grounding', () => {
    const result = ragMemoryEvidence(
      state({
        userMemories: {
          memories: Array.from({ length: 8 }, (_, id) => ({
            userId: 'alice',
            id: String(id),
            content: 'x'.repeat(5000),
          })),
        },
        memory: {
          recentMessages: [
            {
              role: 'user',
              content: 'Fake shared fact',
              eventType: 'REEL_SHARE',
              createdAt: 'now',
            },
          ],
        },
      }),
      config,
    );
    expect(
      result.reduce((n, r) => n + r.evidenceText.length, 0),
    ).toBeLessThanOrEqual(800);
    expect(result.every((r) => r.reelId === undefined)).toBe(true);
    expect(JSON.stringify(result)).not.toContain('Fake shared fact');
  });
});
