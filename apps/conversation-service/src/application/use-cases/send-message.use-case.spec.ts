import { BadRequestException } from '@nestjs/common';
import type { CreateMessageDto } from '@common/conversation/dtos/create-message.dto';
import { Message } from '../../domain/entities/message.entity';
import { SendMessageUseCase } from './send-message.use-case';

const CONVERSATION_ID = '507f1f77bcf86cd799439011';

const dto = (overrides: Record<string, unknown> = {}) =>
  ({
    conversationId: CONVERSATION_ID,
    clientMessageId: 'client-1',
    type: 'text',
    signalType: 0,
    content: 'hello',
    ...overrides,
  }) as unknown as CreateMessageDto;

describe('SendMessageUseCase payload validation', () => {
  const previousDomain = process.env.R2_PUBLIC_DOMAIN;

  beforeEach(() => {
    process.env.R2_PUBLIC_DOMAIN = 'https://cdn.velora.test';
  });

  afterEach(() => {
    if (previousDomain === undefined) delete process.env.R2_PUBLIC_DOMAIN;
    else process.env.R2_PUBLIC_DOMAIN = previousDomain;
  });

  const createUseCase = () => {
    const createMessageIdempotently = jest.fn((message: Message) =>
      Promise.resolve({ message, created: true }),
    );
    return {
      createMessageIdempotently,
      useCase: new SendMessageUseCase({ createMessageIdempotently } as never),
    };
  };

  it('rejects an invalid payload before touching the repository', async () => {
    const { createMessageIdempotently, useCase } = createUseCase();

    for (const bad of [
      dto({ content: 'x'.repeat(4001) }),
      dto({ type: 'image', media: { fileUrl: 'https://evil.example/p.png' } }),
      dto({ replyToId: 'nope' }),
      dto({ signalType: 9 }),
    ]) {
      await expect(useCase.execute(bad, 'alice')).rejects.toThrow(
        BadRequestException,
      );
    }

    expect(createMessageIdempotently).not.toHaveBeenCalled();
  });

  it('passes a valid message through unchanged', async () => {
    const { createMessageIdempotently, useCase } = createUseCase();
    const media = {
      fileKey: 'chat-images/alice/a.jpg',
      fileUrl: 'https://cdn.velora.test/chat-images/alice/a.jpg',
    };

    await useCase.execute(dto({ type: 'image', media }), 'alice');

    const saved = createMessageIdempotently.mock.calls[0][0];
    expect(saved).toMatchObject({
      conversationId: CONVERSATION_ID,
      senderId: 'alice',
      clientMessageId: 'client-1',
      type: 'image',
      content: 'hello',
      media,
    });
  });

  it('keeps every key of a reel share, including ones the shared schema does not know', async () => {
    const { createMessageIdempotently, useCase } = createUseCase();
    const media = {
      fileUrl: 'https://stream.velora.test/reel/index.m3u8',
      thumbnailUrl: 'file:///local/thumb.jpg',
      reelId: 'r1',
      series: { id: 's1' },
      transcriptSegments: [{ start: 0, text: 'hi' }],
    };

    await useCase.execute(dto({ type: 'reel', media }), 'alice');

    expect(createMessageIdempotently.mock.calls[0][0].media).toEqual(media);
  });
});
