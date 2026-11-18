import { BOT_USER_ID } from '@common/constants/seed.constants';
import { IoAdapter } from '@nestjs/platform-socket.io';
import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import { io, type Socket } from 'socket.io-client';
import { of } from 'rxjs';
import type { Server as HttpServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { BuildBotMemoryContextUseCase } from '../../application/use-cases/build-bot-memory-context.use-case';
import { BuildCompletedTurnMemoryContextUseCase } from '../../application/use-cases/build-completed-turn-memory-context.use-case';
import { ProcessBotReplyUseCase } from '../../application/use-cases/process-bot-reply.use-case';
import { SendMessageUseCase } from '../../application/use-cases/send-message.use-case';
import { TriggerBotReplyUseCase } from '../../application/use-cases/trigger-bot-reply.use-case';
import { Conversation } from '../../domain/entities/conversation.entity';
import { Message } from '../../domain/entities/message.entity';
import { ConversationPrometheusMetricsService } from '../metrics/conversation-prometheus-metrics.service';
import { ChatGateway } from './chat.gateway';

const USER = '11111111-1111-4111-8111-111111111111';
const CONVERSATION_ID = '507f1f77bcf86cd799439011';
const CDN = 'https://cdn.example.com';

/**
 * A real Socket.IO WebSocket connection to the real ChatGateway: the client authenticates with a
 * token, joins the bot conversation, emits `send_message` with a photo and caption, and receives
 * the events the mobile app listens for. Only storage, token verification, the AI service and the
 * rate limiter are faked.
 */
describe('photo to Velora AI over a real WebSocket', () => {
  let app: INestApplication;
  let socket: Socket;
  const aiService = {
    askQuestionStream: jest.fn(),
    emitConversationTurnCompleted: jest.fn(),
  };

  const waitFor = <T>(event: string): Promise<T> =>
    new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error(`no ${event} event within 5s`)),
        5_000,
      );
      socket.once(event, (payload: T) => {
        clearTimeout(timer);
        resolve(payload);
      });
    });

  beforeAll(async () => {
    process.env.R2_PUBLIC_DOMAIN = CDN;
    const conversation = new Conversation({
      id: CONVERSATION_ID,
      participantIds: [USER, BOT_USER_ID],
      isGroup: false,
      createdAt: new Date('2026-11-18T00:00:00.000Z'),
      updatedAt: new Date('2026-11-18T00:00:00.000Z'),
    });
    const chatRepository = {
      assertConversationParticipant: jest.fn().mockResolvedValue(undefined),
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
    const processBotReply = new ProcessBotReplyUseCase(
      chatRepository as never,
      aiService,
      new BuildBotMemoryContextUseCase(chatRepository as never),
      new BuildCompletedTurnMemoryContextUseCase(),
    );

    const moduleRef = await Test.createTestingModule({
      providers: [
        ChatGateway,
        {
          provide: SendMessageUseCase,
          useValue: new SendMessageUseCase(chatRepository as never),
        },
        {
          provide: TriggerBotReplyUseCase,
          useValue: new TriggerBotReplyUseCase(
            chatRepository as never,
            processBotReply,
            {
              consume: jest
                .fn()
                .mockResolvedValue({ allowed: true, retryAfterSeconds: 0 }),
            },
            { start: jest.fn(), stop: jest.fn() },
          ),
        },
        {
          provide: ConversationPrometheusMetricsService,
          useValue: {
            measurePhase: (_phase: string, action: () => unknown) => action(),
            recordMessageCreated: jest.fn(),
            recordSendMessage: jest.fn(),
          },
        },
        { provide: 'IChatRepository', useValue: chatRepository },
        {
          provide: 'AUTH_SERVICE_RMQ',
          useValue: {
            send: jest
              .fn()
              .mockReturnValue(of({ id: USER, email: 'u@example.com' })),
          },
        },
        {
          provide: 'REDIS_CLIENT',
          useValue: {
            del: jest.fn().mockResolvedValue(1),
            get: jest.fn().mockResolvedValue(null),
            set: jest.fn().mockResolvedValue('OK'),
          },
        },
      ],
    }).compile();

    app = moduleRef.createNestApplication();
    app.useWebSocketAdapter(new IoAdapter(app));
    await app.listen(0, '127.0.0.1');
    const { port } = (
      app.getHttpServer() as HttpServer
    ).address() as AddressInfo;

    socket = io(`http://127.0.0.1:${port}`, {
      transports: ['websocket'],
      auth: { token: 'valid-token' },
      reconnection: false,
    });
    await waitFor('connect');
    socket.emit('join_conversation', CONVERSATION_ID);
    await new Promise((resolve) => setTimeout(resolve, 150));
  });

  afterAll(async () => {
    socket?.close();
    await app?.close();
  });

  const photo = (clientMessageId: string) => ({
    conversationId: CONVERSATION_ID,
    clientMessageId,
    type: 'image',
    content: 'find reels like this',
    media: {
      fileKey: `chat-images/${USER}/0a1b-22.jpeg`,
      fileUrl: `${CDN}/chat-images/${USER}/0a1b-22.jpeg`,
      mimeType: 'image/jpeg',
      status: 'ready',
    },
  });

  it('acknowledges the photo message and streams the bot reply back as new_message', async () => {
    aiService.askQuestionStream.mockResolvedValue({
      answer: 'Here are some reels you might like:',
    });
    const synced = waitFor<{ id: string; type: string }>('message_synced');
    const reply = waitFor<{ senderId: string; content: string }>('new_message');

    socket.emit('send_message', photo('client-photo-1'));

    expect(await synced).toMatchObject({
      id: 'photo-message-1',
      type: 'image',
    });
    expect(await reply).toMatchObject({
      senderId: BOT_USER_ID,
      content: 'Here are some reels you might like:',
    });
    expect(aiService.askQuestionStream).toHaveBeenCalledWith(
      expect.objectContaining({
        message: 'find reels like this',
        userId: USER,
        images: [
          {
            fileKey: `chat-images/${USER}/0a1b-22.jpeg`,
            mimeType: 'image/jpeg',
          },
        ],
      }),
    );
  });

  it('tells the client over the socket when the AI could not read the photo', async () => {
    aiService.askQuestionStream.mockResolvedValue({
      answer: null,
      error: { code: 'IMAGE_UNREADABLE', message: 'detail' },
    });
    const failed = waitFor<{
      clientMessageId: string;
      error: { code: string; message: string };
    }>('bot_reply_failed');

    socket.emit('send_message', photo('client-photo-2'));

    expect(await failed).toMatchObject({
      clientMessageId: 'client-photo-2',
      error: {
        code: 'IMAGE_UNREADABLE',
        message: 'Velora AI could not read that photo. Try a different one.',
      },
    });
  });
});
