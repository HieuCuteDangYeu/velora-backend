import { MemoryAgentUseCase } from './memory-agent.use-case';

describe('MemoryAgentUseCase Reel evidence isolation', () => {
  it.each([false, true])(
    'honors the router user-memory decision: %s',
    async (includeUserMemory) => {
      const user = { execute: jest.fn().mockResolvedValue({ memories: [] }) };
      const conversation = { execute: jest.fn() };
      const result = await new MemoryAgentUseCase(
        user as never,
        conversation as never,
      ).execute({
        userId: 'u',
        conversationId: 'c',
        message: 'What is in this Reel?',
        route: {
          intent: 'REEL_VIDEO_QUESTION',
          needsUserMemory: includeUserMemory,
          needsConversationSummary: false,
        } as never,
      });
      expect(result.selection.includeUserMemory).toBe(includeUserMemory);
      expect(user.execute).toHaveBeenCalledTimes(includeUserMemory ? 1 : 0);
      expect(conversation.execute).not.toHaveBeenCalled();
      expect(result.selection.includeRecentHistory).toBe(true);
    },
  );
});
