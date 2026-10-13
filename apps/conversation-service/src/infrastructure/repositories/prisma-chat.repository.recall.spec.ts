import { PrismaChatRepository } from './prisma-chat.repository';

const MESSAGE_ID = '507f1f77bcf86cd799439011';
const CONVERSATION_ID = '507f1f77bcf86cd799439012';
const SENDER_ID = '507f191e810c19729de860ea';
const MARKER_KEY = `chat:media:recall-cleanup:${MESSAGE_ID}`;

const mediaMessage = (overrides: Record<string, unknown> = {}) => ({
  id: MESSAGE_ID,
  conversationId: CONVERSATION_ID,
  senderId: SENDER_ID,
  clientMessageId: 'client-1',
  content: 'encrypted-original-content',
  type: 'image',
  signalType: 0,
  media: {
    fileKey: `chat-images/${SENDER_ID}/photo.jpg`,
    fileUrl: 'https://cdn.velora.test/photo.jpg',
  },
  metadata: null,
  registrationId: null,
  createdAt: new Date(),
  isRecalled: false,
  recalledAt: null,
  replyToId: null,
  replyPreview: null,
  reactions: null,
  readBy: [],
  ...overrides,
});

const createHarness = (
  options: {
    message?: Record<string, unknown>;
    transaction?: () => Promise<unknown>;
    deleteMedia?: () => Promise<void>;
  } = {},
) => {
  const events: string[] = [];
  const message = options.message ?? mediaMessage();
  const recalled = { ...message, isRecalled: true, recalledAt: new Date() };

  const prisma = {
    conversation: {
      findUnique: jest.fn().mockResolvedValue({ participantIds: [SENDER_ID] }),
    },
    message: { findUnique: jest.fn().mockResolvedValue(message) },
    $transaction: jest.fn(async () => {
      events.push('transaction');
      if (options.transaction) {
        return options.transaction();
      }
      return { updatedMessage: recalled, updatedReplyMessageIds: [] };
    }),
  };
  const redis = {
    set: jest.fn(() => {
      events.push('marker-set');
      return Promise.resolve('OK');
    }),
    del: jest.fn((key: string) => {
      events.push(key === MARKER_KEY ? 'marker-del' : 'cache-del');
      return Promise.resolve(1);
    }),
    hdel: jest.fn().mockResolvedValue(1),
  };
  const chatMediaService = {
    deleteRecalledChatMedia: jest.fn(async () => {
      events.push('media-delete');
      await options.deleteMedia?.();
    }),
  };
  const repository = new PrismaChatRepository(
    prisma as never,
    redis as never,
    { decrypt: jest.fn((v: string) => v), encrypt: jest.fn((v: string) => v) },
    { findUsersByIds: jest.fn() } as never,
    chatMediaService,
  );

  return { chatMediaService, events, prisma, redis, repository };
};

describe('PrismaChatRepository recall ordering', () => {
  afterEach(() => {
    jest.useRealTimers();
  });

  it('deletes the media only after the recall transaction commits', async () => {
    const { chatMediaService, events, repository } = createHarness();

    const result = await repository.recallMessage(MESSAGE_ID, SENDER_ID);

    expect(result.message).toMatchObject({ isRecalled: true });
    expect(chatMediaService.deleteRecalledChatMedia).toHaveBeenCalledWith({
      userId: SENDER_ID,
      fileKeys: [`chat-images/${SENDER_ID}/photo.jpg`],
    });
    expect(events.slice(0, 4)).toEqual([
      'marker-set',
      'transaction',
      'media-delete',
      'marker-del',
    ]);
  });

  it('keeps the media and clears the marker when the transaction fails', async () => {
    const { chatMediaService, events, repository } = createHarness({
      transaction: () => Promise.reject(new Error('transaction timed out')),
    });

    await expect(
      repository.recallMessage(MESSAGE_ID, SENDER_ID),
    ).rejects.toThrow('transaction timed out');

    expect(chatMediaService.deleteRecalledChatMedia).not.toHaveBeenCalled();
    expect(events).toEqual(['marker-set', 'transaction', 'marker-del']);
  });

  it('gives the transaction room for messages with many replies', async () => {
    const { prisma, repository } = createHarness();

    await repository.recallMessage(MESSAGE_ID, SENDER_ID);

    expect(prisma.$transaction).toHaveBeenCalledWith(expect.any(Function), {
      maxWait: 2000,
      timeout: 15000,
    });
  });

  it('still reports the recall when deletion fails and retries it in the background', async () => {
    jest.useFakeTimers();
    let failures = 1;
    const { chatMediaService, events, repository } = createHarness({
      deleteMedia: () => {
        if (failures > 0) {
          failures -= 1;
          return Promise.reject(new Error('media service down'));
        }
        return Promise.resolve();
      },
    });

    const result = await repository.recallMessage(MESSAGE_ID, SENDER_ID);

    expect(result.message).toMatchObject({ isRecalled: true });
    expect(chatMediaService.deleteRecalledChatMedia).toHaveBeenCalledTimes(1);
    expect(events).not.toContain('marker-del');

    await jest.advanceTimersByTimeAsync(5000);

    expect(chatMediaService.deleteRecalledChatMedia).toHaveBeenCalledTimes(2);
    expect(events).toContain('marker-del');
  });

  it('stops retrying after the last attempt and leaves the marker for operators', async () => {
    jest.useFakeTimers();
    const { chatMediaService, events, repository } = createHarness({
      deleteMedia: () => Promise.reject(new Error('media service down')),
    });

    await repository.recallMessage(MESSAGE_ID, SENDER_ID);
    await jest.advanceTimersByTimeAsync(5000 + 30_000 + 120_000);
    await jest.advanceTimersByTimeAsync(10 * 60 * 1000);

    // The inline attempt plus three scheduled retries.
    expect(chatMediaService.deleteRecalledChatMedia).toHaveBeenCalledTimes(4);
    expect(events).not.toContain('marker-del');
  });

  it('does not touch the media service or Redis markers for text messages', async () => {
    const { chatMediaService, events, repository } = createHarness({
      message: mediaMessage({ type: 'text', media: null }),
    });

    await repository.recallMessage(MESSAGE_ID, SENDER_ID);

    expect(chatMediaService.deleteRecalledChatMedia).not.toHaveBeenCalled();
    expect(events).not.toContain('marker-set');
  });

  it('survives a Redis outage while writing the marker', async () => {
    const { chatMediaService, redis, repository } = createHarness();
    redis.set.mockRejectedValueOnce(new Error('redis down'));

    await expect(
      repository.recallMessage(MESSAGE_ID, SENDER_ID),
    ).resolves.toBeDefined();
    expect(chatMediaService.deleteRecalledChatMedia).toHaveBeenCalledTimes(1);
  });
});
