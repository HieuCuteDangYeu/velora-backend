import { ChatBusyError } from '@ai/domain/errors/chat-busy.error';
import { StreamChatUseCase } from './stream-chat.use-case';

const input = {
  message: 'hello',
  userId: 'user-1',
  conversationId: 'conversation-1',
};

describe('StreamChatUseCase', () => {
  it('runs the workflow through admission and returns its result', async () => {
    const execute = jest
      .fn()
      .mockResolvedValue({ answer: 'Hi!', citations: [{ reelId: 'r' }] });
    let admitted = 0;
    const run = <T>(task: () => Promise<T>) => {
      admitted += 1;
      return task();
    };
    const useCase = new StreamChatUseCase({ execute }, { run });

    await expect(useCase.execute(input)).resolves.toEqual({
      answer: 'Hi!',
      citations: [{ reelId: 'r' }],
      recommendedReels: [],
      suggestedQueries: [],
    });
    expect(admitted).toBe(1);
    expect(execute).toHaveBeenCalledWith({ ...input, memory: undefined });
  });

  it('never starts the workflow when the turn is refused', async () => {
    const execute = jest.fn();
    const useCase = new StreamChatUseCase(
      { execute },
      {
        run: () => Promise.reject(new ChatBusyError(12)),
      },
    );

    await expect(useCase.execute(input)).rejects.toMatchObject({
      code: 'AI_BUSY',
      retryAfterSeconds: 12,
    });
    expect(execute).not.toHaveBeenCalled();
  });
});
