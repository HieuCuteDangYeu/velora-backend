import { AskQuestionPayloadSchema } from '@common/ai/dtos/ask-question.dto';
import { BOT_USER_ID } from '@common/constants/seed.constants';
import { BuildBotMemoryContextUseCase } from '../../application/use-cases/build-bot-memory-context.use-case';
import { BuildCompletedTurnMemoryContextUseCase } from '../../application/use-cases/build-completed-turn-memory-context.use-case';
import { ProcessBotReplyUseCase } from '../../application/use-cases/process-bot-reply.use-case';
import { SendMessageUseCase } from '../../application/use-cases/send-message.use-case';
import { TriggerBotReplyUseCase } from '../../application/use-cases/trigger-bot-reply.use-case';
import { Conversation } from '../../domain/entities/conversation.entity';
import { Message } from '../../domain/entities/message.entity';
import { ChatGateway } from './chat.gateway';

const USER = '11111111-1111-4111-8111-111111111111';
const CONVERSATION_ID = '507f1f77bcf86cd799439011';
const CDN = 'https://cdn.example.com';

const imagePayload = (overrides: Record<string, unknown> = {}) => ({
  conversationId: CONVERSATION_ID,
  clientMessageId: 'client-photo-1',
  type: 'image',
  content: 'find reels like this',
  media: {
    fileKey: `chat-images/${USER}/0a1b-22.jpeg`,
    fileUrl: `${CDN}/chat-images/${USER}/0a1b-22.jpeg`,
    mimeType: 'image/jpeg',
    status: 'ready',
  },
  ...overrides,
});

/**
 * The real gateway handler, validator and bot-turn use cases for a photo sent over
 * `send_message`; only storage, the AI service and the rate limiter are faked.
 */
const build = (aiResult: object) => {
  process.env.R2_PUBLIC_DOMAIN = CDN;
  const conversation = new Conversation({
    id: CONVERSATION_ID,
    participantIds: [USER, BOT_USER_ID],
    isGroup: false,
    createdAt: new Date('2026-11-18T00:00:00.000Z'),
    updatedAt: new Date('2026-11-18T00:00:00.000Z'),
  });
  const chatRepository = {
    createMessageIdempotently: jest.fn((message: Message) =>
      Promise.resolve({
        message: new Message({ ...message, id: 'photo-message-1' }),
        created: true,
        conversation,
      }),
    ),
    createMessage: jest.fn((message: Message) =>
      Promise.resolve(new Message({ ...message, id: 'bot-message-1' })),
    ),
    populateConversationParticipants: jest.fn((c: Conversation) =>
      Promise.resolve(c),
    ),
    findConversation: jest.fn().mockResolvedValue(conversation),
    findMessagesByConversationId: jest.fn().mockResolvedValue([]),
    findMessageById: jest.fn(),
  };
  const aiService = {
    askQuestionStream: jest.fn().mockResolvedValue(aiResult),
    emitConversationTurnCompleted: jest.fn(),
  };
  const limiter = {
    consume: jest
      .fn()
      .mockResolvedValue({ allowed: true, retryAfterSeconds: 0 }),
  };
  const typing = { start: jest.fn(), stop: jest.fn() };
  const process_ = new ProcessBotReplyUseCase(
    chatRepository as never,
    aiService,
    new BuildBotMemoryContextUseCase(chatRepository as never),
    new BuildCompletedTurnMemoryContextUseCase(),
  );
  const gateway = new ChatGateway(
    new SendMessageUseCase(chatRepository as never),
    new TriggerBotReplyUseCase(
      chatRepository as never,
      process_,
      limiter,
      typing,
    ),
    {
      measurePhase: jest.fn((_phase, action: () => unknown) => action()),
      recordMessageCreated: jest.fn(),
      recordSendMessage: jest.fn(),
    } as never,
    chatRepository as never,
    {} as never,
    {} as never,
  );
  const roomEmit = jest.fn();
  gateway.server = {
    to: jest.fn().mockReturnValue({
      emit: roomEmit,
      except: jest.fn().mockReturnValue({ emit: roomEmit }),
    }),
  } as never;
  const socket = {
    id: 'socket-1',
    data: { userId: USER },
    emit: jest.fn(),
    to: jest.fn().mockReturnValue({ emit: roomEmit }),
  };
  const settle = () => new Promise((resolve) => setImmediate(resolve));
  return { gateway, socket, roomEmit, aiService, limiter, typing, settle };
};

describe('send_message with a photo to Velora AI', () => {
  it('stores the photo, hands the AI the photo and caption, and streams the reply back', async () => {
    const { gateway, socket, roomEmit, aiService, limiter, typing, settle } =
      build({ answer: 'Here are some reels you might like:' });

    await gateway.handleMessage(imagePayload() as never, socket as never);
    await settle();

    expect(socket.emit).toHaveBeenCalledWith(
      'message_synced',
      expect.objectContaining({ type: 'image' }),
    );
    expect(limiter.consume).toHaveBeenCalledWith(USER, { withImage: true });
    expect(aiService.askQuestionStream).toHaveBeenCalledWith(
      expect.objectContaining({
        message: 'find reels like this',
        userId: USER,
        conversationId: CONVERSATION_ID,
        images: [
          {
            fileKey: `chat-images/${USER}/0a1b-22.jpeg`,
            mimeType: 'image/jpeg',
          },
        ],
      }),
    );
    // RabbitMQ carries JSON: what ai-service receives must still satisfy its payload contract.
    const sent = aiService.askQuestionStream.mock.calls[0][0] as object;
    expect(
      AskQuestionPayloadSchema.safeParse(JSON.parse(JSON.stringify(sent)))
        .success,
    ).toBe(true);
    // The bot shows as typing for the whole turn, including the photo being read.
    expect(typing.start).toHaveBeenCalledWith(CONVERSATION_ID);
    expect(typing.stop).toHaveBeenCalledWith(CONVERSATION_ID);
    expect(typing.start.mock.invocationCallOrder[0]).toBeLessThan(
      aiService.askQuestionStream.mock.invocationCallOrder[0],
    );
    expect(roomEmit).toHaveBeenCalledWith(
      'new_message',
      expect.objectContaining({
        senderId: BOT_USER_ID,
        content: 'Here are some reels you might like:',
      }),
    );
  });

  it('sends the AI no words for a bare photo', async () => {
    const { gateway, socket, aiService, settle } = build({ answer: 'ok' });

    await gateway.handleMessage(
      imagePayload({ content: '[Hình ảnh]' }) as never,
      socket as never,
    );
    await settle();

    expect(aiService.askQuestionStream).toHaveBeenCalledWith(
      expect.objectContaining({ message: '', images: expect.any(Array) }),
    );
    expect(
      AskQuestionPayloadSchema.safeParse(
        JSON.parse(
          JSON.stringify(aiService.askQuestionStream.mock.calls[0][0]),
        ),
      ).success,
    ).toBe(true);
    expect(aiService.emitConversationTurnCompleted).not.toHaveBeenCalled();
  });

  it('tells the client when the AI could not read the photo', async () => {
    const { gateway, socket, roomEmit, settle } = build({
      answer: null,
      error: { code: 'IMAGE_UNREADABLE', message: 'detail' },
    });

    await gateway.handleMessage(imagePayload() as never, socket as never);
    await settle();

    expect(roomEmit).toHaveBeenCalledWith(
      'bot_reply_failed',
      expect.objectContaining({
        userMessageId: 'photo-message-1',
        clientMessageId: 'client-photo-1',
        error: {
          code: 'IMAGE_UNREADABLE',
          message: 'Velora AI could not read that photo. Try a different one.',
        },
      }),
    );
  });

  it("never lets the AI read someone else's upload", async () => {
    const { gateway, socket, aiService, limiter, settle } = build({
      answer: 'ok',
    });

    await gateway.handleMessage(
      imagePayload({
        media: {
          fileKey: 'chat-images/another-user/abc.jpeg',
          fileUrl: `${CDN}/chat-images/another-user/abc.jpeg`,
          mimeType: 'image/jpeg',
        },
      }) as never,
      socket as never,
    );
    await settle();

    expect(socket.emit).toHaveBeenCalledWith(
      'message_synced',
      expect.anything(),
    );
    expect(limiter.consume).not.toHaveBeenCalled();
    expect(aiService.askQuestionStream).not.toHaveBeenCalled();
  });

  it('rejects a photo whose URL is not on the media CDN before anything is stored', async () => {
    const { gateway, socket, roomEmit, aiService, settle } = build({
      answer: 'ok',
    });

    await gateway.handleMessage(
      imagePayload({
        media: {
          fileKey: `chat-images/${USER}/0a1b-22.jpeg`,
          fileUrl: 'https://evil.example/x.jpeg',
          mimeType: 'image/jpeg',
        },
      }) as never,
      socket as never,
    );
    await settle();

    expect(roomEmit).toHaveBeenCalledWith(
      'message_failed',
      expect.objectContaining({ clientMessageId: 'client-photo-1' }),
    );
    expect(socket.emit).not.toHaveBeenCalledWith(
      'message_synced',
      expect.anything(),
    );
    expect(aiService.askQuestionStream).not.toHaveBeenCalled();
  });
});
