import { BadRequestException } from '@nestjs/common';
import { MessageSchema } from '@common/conversation/dtos/message.dto';

import { Message } from '../../domain/entities/message.entity';
import { ChatMapper } from './chat.mapper';
import { PrismaChatRepository } from './prisma-chat.repository';

import type { MessageReplyPreview } from '../../domain/entities/message.entity';

type ReplyPreviewHarness = {
  buildReplyPreview: (
    replyToId: string | undefined,
    conversationId: string,
  ) => Promise<MessageReplyPreview | undefined>;
  mergeReplyPreviewContent: (
    value: unknown,
    content: string,
  ) => MessageReplyPreview | undefined;
  normalizeReplyPreview: (value: unknown) => MessageReplyPreview | undefined;
};

const createRepositoryHarness = ({
  replyTarget,
}: {
  replyTarget?: Record<string, unknown> | null;
}) => {
  const prisma = {
    message: {
      findUnique: jest.fn().mockResolvedValue(replyTarget ?? null),
    },
  };
  const redis = {
    del: jest.fn(),
    expire: jest.fn(),
    get: jest.fn(),
    hset: jest.fn(),
    pipeline: jest.fn(),
  };
  const encryptionRepository = {
    decrypt: jest.fn((value: string) => value),
    encrypt: jest.fn((value: string) => value),
  };
  const userService = {
    findUsersByIds: jest.fn().mockResolvedValue([
      {
        id: 'sender-1',
        email: 'sender@example.com',
        name: 'Sender Name',
      },
    ]),
  };

  return {
    prisma,
    repository: new PrismaChatRepository(
      prisma as never,
      redis as never,
      encryptionRepository,
      userService as never,
    ) as unknown as ReplyPreviewHarness,
  };
};

describe('PrismaChatRepository reply previews', () => {
  it('includes image thumbnail and dimensions when replying to an image', async () => {
    const { repository } = createRepositoryHarness({
      replyTarget: {
        id: 'image-message',
        conversationId: 'conversation-1',
        senderId: 'sender-1',
        content: '[Hinh anh]',
        type: 'image',
        signalType: 0,
        isRecalled: false,
        media: {
          fileUrl: 'https://cdn.velora.test/chat/image.jpg',
          width: 1200,
          height: 900,
        },
      },
    });

    await expect(
      repository.buildReplyPreview('image-message', 'conversation-1'),
    ).resolves.toEqual({
      senderName: 'Sender Name',
      content: '[Hình ảnh]',
      thumbnailUri: 'https://cdn.velora.test/chat/image.jpg',
      mediaWidth: 1200,
      mediaHeight: 900,
      type: 'image',
    });
  });

  it('includes video thumbnail and dimensions when replying to a video with a thumbnail', async () => {
    const { repository } = createRepositoryHarness({
      replyTarget: {
        id: 'video-message',
        conversationId: 'conversation-1',
        senderId: 'sender-1',
        content: '[Video]',
        type: 'video',
        signalType: 0,
        isRecalled: false,
        media: {
          fileUrl: 'https://cdn.velora.test/chat/video.mp4',
          thumbnailUrl: 'https://cdn.velora.test/chat/video-thumb.jpg',
          width: 1080,
          height: 1920,
        },
      },
    });

    await expect(
      repository.buildReplyPreview('video-message', 'conversation-1'),
    ).resolves.toEqual({
      senderName: 'Sender Name',
      content: '[Video]',
      thumbnailUri: 'https://cdn.velora.test/chat/video-thumb.jpg',
      mediaWidth: 1080,
      mediaHeight: 1920,
      type: 'video',
    });
  });

  it('does not use the video file URL as thumbnailUri when a video thumbnail is missing', async () => {
    const { repository } = createRepositoryHarness({
      replyTarget: {
        id: 'video-message',
        conversationId: 'conversation-1',
        senderId: 'sender-1',
        content: '[Video]',
        type: 'video',
        signalType: 0,
        isRecalled: false,
        media: {
          fileUrl: 'https://cdn.velora.test/chat/video.mp4',
          width: 1080,
          height: 1920,
        },
      },
    });

    await expect(
      repository.buildReplyPreview('video-message', 'conversation-1'),
    ).resolves.toEqual({
      senderName: 'Sender Name',
      content: '[Video]',
      mediaWidth: 1080,
      mediaHeight: 1920,
      type: 'video',
    });
  });

  it('returns a text-only preview when replying to a recalled media message', async () => {
    const { repository } = createRepositoryHarness({
      replyTarget: {
        id: 'image-message',
        conversationId: 'conversation-1',
        senderId: 'sender-1',
        content: '[Hinh anh]',
        type: 'image',
        signalType: 0,
        isRecalled: true,
        media: {
          fileUrl: 'https://cdn.velora.test/chat/image.jpg',
          width: 1200,
          height: 900,
        },
      },
    });

    await expect(
      repository.buildReplyPreview('image-message', 'conversation-1'),
    ).resolves.toEqual({
      senderName: 'Sender Name',
      content: 'Tin nhắn đã thu hồi',
      type: 'text',
    });
  });

  it('rejects reply targets from another conversation', async () => {
    const { repository } = createRepositoryHarness({
      replyTarget: {
        id: 'image-message',
        conversationId: 'other-conversation',
        senderId: 'sender-1',
        content: '[Hinh anh]',
        type: 'image',
        signalType: 0,
        isRecalled: false,
      },
    });

    await expect(
      repository.buildReplyPreview('image-message', 'conversation-1'),
    ).rejects.toThrow(BadRequestException);
  });

  it('normalizes stored reply previews without dropping media metadata', () => {
    const { repository } = createRepositoryHarness({});

    expect(
      repository.normalizeReplyPreview({
        senderName: 'Sender Name',
        content: '[Video]',
        thumbnailUri: 'https://cdn.velora.test/chat/video-thumb.jpg',
        mediaWidth: 1080,
        mediaHeight: 1920,
        type: 'video',
      }),
    ).toEqual({
      senderName: 'Sender Name',
      content: '[Video]',
      thumbnailUri: 'https://cdn.velora.test/chat/video-thumb.jpg',
      mediaWidth: 1080,
      mediaHeight: 1920,
      type: 'video',
    });
  });

  it('normalizes recalled reply previews to text-only metadata', () => {
    const { repository } = createRepositoryHarness({});

    expect(
      repository.normalizeReplyPreview({
        senderName: 'Sender Name',
        content: 'Tin nhắn đã thu hồi',
        thumbnailUri: 'https://cdn.velora.test/chat/video-thumb.jpg',
        mediaWidth: 1080,
        mediaHeight: 1920,
        type: 'video',
      }),
    ).toEqual({
      senderName: 'Sender Name',
      content: 'Tin nhắn đã thu hồi',
      type: 'text',
    });
  });

  it('drops media metadata when recall updates an existing reply preview', () => {
    const { repository } = createRepositoryHarness({});

    expect(
      repository.mergeReplyPreviewContent(
        {
          senderName: 'Sender Name',
          content: '[Video]',
          thumbnailUri: 'https://cdn.velora.test/chat/video-thumb.jpg',
          mediaWidth: 1080,
          mediaHeight: 1920,
          type: 'video',
        },
        'Tin nhắn đã thu hồi',
      ),
    ).toEqual({
      senderName: 'Sender Name',
      content: 'Tin nhắn đã thu hồi',
      type: 'text',
    });
  });
});

describe('ChatMapper reply previews', () => {
  it('preserves media metadata from persisted reply previews', () => {
    const message = ChatMapper.toDomain({
      id: 'reply-message',
      conversationId: 'conversation-1',
      senderId: 'sender-2',
      clientMessageId: null,
      content: 'Nice video',
      type: 'text',
      signalType: 0,
      media: null,
      registrationId: null,
      createdAt: new Date('2026-06-02T00:00:00.000Z'),
      isRecalled: false,
      recalledAt: null,
      replyToId: 'video-message',
      replyPreview: {
        senderName: 'Sender Name',
        content: '[Video]',
        thumbnailUri: 'https://cdn.velora.test/chat/video-thumb.jpg',
        mediaWidth: 1080,
        mediaHeight: 1920,
        type: 'video',
      },
      readBy: [],
      reactions: null,
    });

    expect(message.replyPreview).toEqual({
      senderName: 'Sender Name',
      content: '[Video]',
      thumbnailUri: 'https://cdn.velora.test/chat/video-thumb.jpg',
      mediaWidth: 1080,
      mediaHeight: 1920,
      type: 'video',
    });
  });

  it('returns reply preview metadata in outgoing DTOs', () => {
    const message = new Message({
      id: 'reply-message',
      conversationId: 'conversation-1',
      senderId: 'sender-2',
      content: 'Nice video',
      type: 'text',
      signalType: 0,
      createdAt: new Date('2026-06-02T00:00:00.000Z'),
      replyToId: 'video-message',
      replyPreview: {
        senderName: 'Sender Name',
        content: '[Video]',
        thumbnailUri: 'https://cdn.velora.test/chat/video-thumb.jpg',
        mediaWidth: 1080,
        mediaHeight: 1920,
        type: 'video',
      },
      readBy: [],
    });

    expect(ChatMapper.toDto(message).replyPreview).toEqual({
      senderName: 'Sender Name',
      content: '[Video]',
      thumbnailUri: 'https://cdn.velora.test/chat/video-thumb.jpg',
      mediaWidth: 1080,
      mediaHeight: 1920,
      type: 'video',
    });
  });
});

describe('recalled message privacy', () => {
  it('never serializes legacy content or media from a recalled message', () => {
    const dto = ChatMapper.toDto(
      new Message({
        id: 'message-1',
        conversationId: 'conversation-1',
        senderId: 'sender-1',
        content: 'sensitive legacy content',
        media: {
          fileKey: 'chat-images/sender-1/private.jpg',
          fileUrl: 'https://cdn.velora.test/private.jpg',
        },
        metadata: {
          kind: 'velora_ai_reel_recommendations',
        },
        type: 'image',
        signalType: 0,
        createdAt: new Date('2026-06-02T00:00:00.000Z'),
        isRecalled: true,
        replyPreview: {
          senderName: 'Sender Name',
          content: 'sensitive reply preview',
          type: 'text',
        },
        reactions: {
          'user-2': {
            emoji: '👍',
            createdAt: '2026-06-02T00:00:00.000Z',
          },
        },
      }),
    );

    expect(dto).toMatchObject({
      content: 'Tin nhắn đã thu hồi',
      isRecalled: true,
    });
    expect(dto.media).toBeUndefined();
    expect(dto.metadata).toBeUndefined();
    expect(dto.replyPreview).toBeUndefined();
    expect(dto.reactions).toBeUndefined();
  });

  it('reads recalled history from the database and redacts a legacy record', async () => {
    const redis = {
      del: jest.fn(),
      expire: jest.fn(),
      get: jest.fn(),
      hset: jest.fn(),
      hdel: jest.fn(),
      lrange: jest.fn(),
      pipeline: jest.fn(),
    };
    const prisma = {
      message: {
        findMany: jest.fn().mockResolvedValue([
          {
            id: 'legacy-recalled-message',
            conversationId: 'conversation-1',
            senderId: 'sender-1',
            clientMessageId: null,
            content: 'encrypted-legacy-secret',
            type: 'text',
            signalType: 0,
            media: {
              fileKey: 'chat-images/sender-1/private.jpg',
              fileUrl: 'https://cdn.velora.test/private.jpg',
            },
            metadata: null,
            registrationId: null,
            createdAt: new Date('2026-06-02T00:00:00.000Z'),
            isRecalled: true,
            recalledAt: new Date('2026-06-02T00:01:00.000Z'),
            replyToId: null,
            replyPreview: null,
            reactions: null,
            readBy: [],
          },
        ]),
      },
    };
    const encryptionRepository = {
      decrypt: jest.fn(() => 'decrypted legacy secret'),
      encrypt: jest.fn((value: string) => value),
    };
    const repository = new PrismaChatRepository(
      prisma as never,
      redis as never,
      encryptionRepository,
      { findUsersByIds: jest.fn() } as never,
      { deleteRecalledChatMedia: jest.fn() },
    );

    await expect(
      repository.findMessagesByConversationId('conversation-1', 20),
    ).resolves.toMatchObject([
      {
        content: 'Tin nhắn đã thu hồi',
        isRecalled: true,
      },
    ]);
    expect(encryptionRepository.decrypt).not.toHaveBeenCalled();
    expect(redis.lrange).not.toHaveBeenCalled();
  });

  it('replaces persisted data and deletes owned chat objects when recalling', async () => {
    const messageId = '507f1f77bcf86cd799439011';
    const senderId = '507f191e810c19729de860ea';
    const originalMessage = {
      id: messageId,
      conversationId: '507f1f77bcf86cd799439012',
      senderId,
      clientMessageId: null,
      content: 'encrypted-original-content',
      type: 'image',
      signalType: 0,
      media: {
        fileKey: `chat-images/${senderId}/private.jpg`,
        fileUrl: 'https://cdn.velora.test/private.jpg',
        thumbnailKey: `chat-thumbnails/${senderId}/private.jpg`,
        thumbnailUrl: 'https://cdn.velora.test/private-thumb.jpg',
      },
      metadata: { kind: 'velora_ai_reel_recommendations' },
      registrationId: 1,
      createdAt: new Date(),
      isRecalled: false,
      recalledAt: null,
      replyToId: null,
      replyPreview: null,
      reactions: {
        'user-2': { emoji: '👍', createdAt: new Date().toISOString() },
      },
      readBy: [],
    };
    let updateInput: unknown;
    const update = jest.fn((input: unknown) => {
      updateInput = input;
      return Promise.resolve({
        ...originalMessage,
        content: 'encrypted-recalled-content',
        media: null,
        metadata: null,
        registrationId: null,
        isRecalled: true,
        recalledAt: new Date(),
        replyPreview: null,
        reactions: null,
      });
    });
    const tx = {
      message: {
        findMany: jest.fn().mockResolvedValue([]),
        findFirst: jest.fn().mockResolvedValue({ id: 'another-message' }),
        update,
      },
      conversation: { update: jest.fn() },
    };
    const runTransaction = (callback: (transaction: typeof tx) => unknown) =>
      callback(tx);
    const prisma = {
      conversation: {
        findUnique: jest.fn().mockResolvedValue({ participantIds: [senderId] }),
      },
      message: {
        findUnique: jest.fn().mockResolvedValue(originalMessage),
      },
      $transaction: jest.fn(runTransaction),
    };
    const redis = {
      del: jest.fn(),
      hdel: jest.fn(),
    };
    const encryptionRepository = {
      decrypt: jest.fn((value: string) => value),
      encrypt: jest.fn((value: string) => `encrypted:${value}`),
    };
    const chatMediaService = { deleteRecalledChatMedia: jest.fn() };
    const repository = new PrismaChatRepository(
      prisma as never,
      redis as never,
      encryptionRepository,
      { findUsersByIds: jest.fn() } as never,
      chatMediaService,
    );

    const result = await repository.recallMessage(messageId, senderId);

    expect(chatMediaService.deleteRecalledChatMedia).toHaveBeenCalledWith({
      userId: senderId,
      fileKeys: [
        `chat-images/${senderId}/private.jpg`,
        `chat-thumbnails/${senderId}/private.jpg`,
      ],
    });
    const updateCall = updateInput as
      | { data: Record<string, unknown> }
      | undefined;
    expect(updateCall?.data).toMatchObject({
      content: 'encrypted:Tin nhắn đã thu hồi',
      media: null,
      metadata: null,
      registrationId: null,
      replyPreview: null,
      reactions: null,
      isRecalled: true,
    });
    expect(result.message).toMatchObject({
      content: 'Tin nhắn đã thu hồi',
      isRecalled: true,
    });
    expect(result.message.media).toBeUndefined();
  });
});

describe('MessageDto reply previews', () => {
  it('accepts reply preview media metadata in outgoing message payloads', () => {
    expect(
      MessageSchema.parse({
        id: 'reply-message',
        conversationId: 'conversation-1',
        senderId: 'sender-2',
        clientMessageId: 'client-message-1',
        content: 'Nice video',
        type: 'text',
        signalType: 0,
        createdAt: '2026-06-02T00:00:00.000Z',
        replyToId: 'video-message',
        replyPreview: {
          senderName: 'Sender Name',
          content: '[Video]',
          thumbnailUri: 'https://cdn.velora.test/chat/video-thumb.jpg',
          mediaWidth: 1080,
          mediaHeight: 1920,
          type: 'video',
        },
        createdAtMs: 1780358400000,
        readBy: [],
      }).replyPreview,
    ).toEqual({
      senderName: 'Sender Name',
      content: '[Video]',
      thumbnailUri: 'https://cdn.velora.test/chat/video-thumb.jpg',
      mediaWidth: 1080,
      mediaHeight: 1920,
      type: 'video',
    });
  });
});
