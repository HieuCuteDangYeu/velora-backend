import { ChatBusyError } from '@ai/domain/errors/chat-busy.error';
import { ChatImageUnreadableError } from '@ai/domain/errors/chat-image-unreadable.error';
import { AskQuestionResponseSchema } from '@common/ai/dtos/ask-question-response.dto';
import { AiController } from './ai.controller';

const controllerWith = (streamChatUseCase: { execute: jest.Mock }) =>
  new AiController(
    // embedding, batch embedding, token count, transcription x2, visual analysis
    ...(Array(6).fill(undefined) as [never, never, never, never, never, never]),
    streamChatUseCase as never,
    // turn completed, reel metadata, memory backfill, text relevance, subtitle translation
    undefined as never,
    undefined as never,
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

describe('AiController stream question photos', () => {
  const photo = { fileKey: 'chat-images/u/abc.jpeg', mimeType: 'image/jpeg' };

  it('passes the photos to the turn and accepts an empty caption', async () => {
    const execute = jest.fn().mockResolvedValue({ answer: 'ok' });

    await controllerWith({ execute }).handleStreamQuestion({
      ...payload,
      message: '',
      images: [photo],
    } as never);

    expect(execute).toHaveBeenCalledWith(
      expect.objectContaining({ message: '', images: [photo] }),
    );
  });

  it.each([
    ['an empty message with no photo', { message: '  ' }],
    [
      'an unsupported mime type',
      { images: [{ ...photo, mimeType: 'image/gif' }] },
    ],
    ['a photo without a key', { images: [{ mimeType: 'image/jpeg' }] }],
    ['too many photos', { images: [photo, photo, photo, photo] }],
  ])('rejects %s', async (_label, extra) => {
    const execute = jest.fn();

    await expect(
      controllerWith({ execute }).handleStreamQuestion({
        ...payload,
        ...extra,
      } as never),
    ).rejects.toMatchObject({ error: { statusCode: 400 } });
    expect(execute).not.toHaveBeenCalled();
  });

  it('answers an unreadable photo with a typed IMAGE_UNREADABLE response', async () => {
    const response = await controllerWith({
      execute: jest
        .fn()
        .mockRejectedValue(new ChatImageUnreadableError('NOT_OWNED')),
    }).handleStreamQuestion({ ...payload, images: [photo] } as never);

    expect(response).toEqual({
      error: {
        code: 'IMAGE_UNREADABLE',
        message: 'Velora AI could not read that image. Try another photo.',
      },
    });
    expect(AskQuestionResponseSchema.safeParse(response).success).toBe(true);
  });
});

describe('AiController rerank texts', () => {
  const controller = (execute: jest.Mock) =>
    new AiController(
      ...(Array(10).fill(undefined) as [
        never,
        never,
        never,
        never,
        never,
        never,
        never,
        never,
        never,
        never,
      ]),
      { execute } as never,
      undefined as never,
    );

  it('scores a valid request through the use case', async () => {
    const execute = jest.fn().mockResolvedValue({ scores: [0.4] });

    await expect(
      controller(execute).handleRerankTexts({ queryText: 'q', texts: ['a'] }),
    ).resolves.toEqual({ scores: [0.4] });
    expect(execute).toHaveBeenCalledWith({ queryText: 'q', texts: ['a'] });
  });

  it.each([
    ['an empty query', { queryText: ' ', texts: ['a'] }],
    ['no texts', { queryText: 'q', texts: [] }],
    ['too many texts', { queryText: 'q', texts: Array(51).fill('a') }],
    ['a blank text', { queryText: 'q', texts: ['a', ' '] }],
    ['a non-positive budget', { queryText: 'q', texts: ['a'], budgetMs: 0 }],
  ])(
    'rejects %s with a 400 before touching the scorer',
    async (_name, body) => {
      const execute = jest.fn();

      await expect(
        controller(execute).handleRerankTexts(body),
      ).rejects.toMatchObject({ error: { statusCode: 400 } });
      expect(execute).not.toHaveBeenCalled();
    },
  );

  it('reports a scorer failure as 503 so the caller can fall back', async () => {
    const spy = jest.spyOn(console, 'error').mockImplementation();

    await expect(
      controller(
        jest.fn().mockRejectedValue(new Error('TEI reranker RERANKER_TIMEOUT')),
      ).handleRerankTexts({ queryText: 'q', texts: ['a'] }),
    ).rejects.toMatchObject({ error: { statusCode: 503 } });
    spy.mockRestore();
  });
});
