import { ChatBusyError } from '@ai/domain/errors/chat-busy.error';
import { AskQuestionResponseSchema } from '@common/ai/dtos/ask-question-response.dto';
import { AiController } from './ai.controller';

const controllerWith = (streamChatUseCase: { execute: jest.Mock }) =>
  new AiController(
    // embedding, batch embedding, token count, transcription x2, visual analysis
    ...(Array(6).fill(undefined) as [never, never, never, never, never, never]),
    streamChatUseCase as never,
    // turn completed, reel metadata, memory backfill
    undefined as never,
    undefined as never,
    undefined as never,
  );

const payload = { message: 'hi', userId: 'u', conversationId: 'c' };

describe('AiController stream question', () => {
  it('answers a refused turn with a typed AI_BUSY response and a retry hint', async () => {
    const response = await controllerWith({
      execute: jest.fn().mockRejectedValue(new ChatBusyError(15)),
    }).handleStreamQuestion(payload);

    expect(response).toEqual({
      error: {
        code: 'AI_BUSY',
        message: 'Velora AI is busy right now. Please try again in a moment.',
        retryAfterSeconds: 15,
      },
    });
    // It must satisfy the cross-service contract conversation-service validates against.
    expect(AskQuestionResponseSchema.safeParse(response).success).toBe(true);
  });

  it('still reports other failures as errors', async () => {
    const spy = jest.spyOn(console, 'error').mockImplementation();
    await expect(
      controllerWith({
        execute: jest.fn().mockRejectedValue(new Error('model failed')),
      }).handleStreamQuestion(payload as never),
    ).rejects.toMatchObject({ error: { statusCode: 500 } });
    spy.mockRestore();
  });

  it('returns an answer unchanged', async () => {
    await expect(
      controllerWith({
        execute: jest.fn().mockResolvedValue({ answer: 'Paris' }),
      }).handleStreamQuestion(payload as never),
    ).resolves.toMatchObject({ answer: 'Paris' });
  });
});
