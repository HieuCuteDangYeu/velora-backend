import { Prisma } from '@prisma/conversation-client';
import { Message } from './domain/entities/message.entity';
import { ConversationMicroserviceController } from './infrastructure/controllers/conversation.controller';
import { ChatGateway } from './infrastructure/gateways/chat.gateway';
import { PrismaChatRepository } from './infrastructure/repositories/prisma-chat.repository';

const createMessage = () =>
  new Message({
    id: 'message-1',
    conversationId: 'conversation-1',
    senderId: 'sender-1',
    clientMessageId: 'client-message-1',
    content: 'hello',
    type: 'text',
    signalType: 0,
    createdAt: new Date('2026-07-15T00:00:00.000Z'),
    readBy: [],
  });

const createStoredMessage = () => ({
  id: 'message-1',
  conversationId: 'conversation-1',
  senderId: 'sender-1',
  clientMessageId: 'client-message-1',
  content: 'encrypted:hello',
  type: 'text',
  signalType: 0,
  media: null,
  metadata: null,
  registrationId: null,
  isRecalled: false,
  recalledAt: null,
  replyToId: null,
  replyPreview: null,
  reactions: null,
  createdAt: new Date('2026-07-15T00:00:00.000Z'),
  readBy: [],
});

describe('message idempotency', () => {
  it('resolves a concurrent insert conflict to the original message', async () => {
    const storedMessage = createStoredMessage();
    const duplicateError = new Prisma.PrismaClientKnownRequestError(
      'duplicate client message id',
      { code: 'P2002', clientVersion: '5.22.0' },
    );
    const prisma = {
      conversation: {
        findUnique: jest
          .fn()
          .mockResolvedValue({ participantIds: ['sender-1'] }),
        update: jest.fn().mockReturnValue({}),
      },
      message: {
        create: jest.fn().mockReturnValue({}),
        findFirst: jest.fn().mockResolvedValue(storedMessage),
      },
      $transaction: jest
        .fn()
        .mockResolvedValueOnce([storedMessage])
        .mockRejectedValueOnce(duplicateError),
    };
    const repository = new PrismaChatRepository(
      prisma as never,
      { del: jest.fn() } as never,
      {
        encrypt: jest.fn((content: string) => `encrypted:${content}`),
        decrypt: jest.fn((content: string) =>
          content.replace('encrypted:', ''),
        ),
      },
      {} as never,
      {} as never,
    );

    const [first, retry] = await Promise.all([
      repository.createMessageIdempotently(createMessage()),
      repository.createMessageIdempotently(createMessage()),
    ]);

    expect([first.created, retry.created].sort()).toEqual([false, true]);
    expect(first.message.id).toBe('message-1');
    expect(retry.message.id).toBe('message-1');
    expect(prisma.message.create).toHaveBeenCalledTimes(2);
    expect(prisma.message.findFirst).toHaveBeenCalledWith({
      where: {
        conversationId: 'conversation-1',
        senderId: 'sender-1',
        clientMessageId: 'client-message-1',
      },
    });
  });

  it('does not re-run HTTP socket, push, or bot side effects for a retry', async () => {
    const serverEmit = jest.fn();
    const serverTo = jest.fn().mockReturnValue({ emit: serverEmit });
    const sendMessageUseCase = {
      execute: jest.fn().mockResolvedValue({
        message: createMessage(),
        created: false,
      }),
    };
    const notificationService = { notifyNewMessage: jest.fn() };
    const triggerBotReplyUseCase = { execute: jest.fn() };
    const chatRepository = { findConversation: jest.fn() };
    const controller = new ConversationMicroserviceController(
      sendMessageUseCase as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      { server: { to: serverTo } } as never,
      triggerBotReplyUseCase as never,
      notificationService as never,
      chatRepository as never,
      {} as never,
    );

    const result = await controller.handleCreateMessage({
      conversationId: 'conversation-1',
      senderId: 'sender-1',
      clientMessageId: 'client-message-1',
      content: 'hello',
      type: 'text',
      signalType: 0,
    } as never);

    expect(result).toMatchObject({
      created: false,
      message: { id: 'message-1' },
    });
    expect(serverTo).not.toHaveBeenCalled();
    expect(chatRepository.findConversation).not.toHaveBeenCalled();
    expect(notificationService.notifyNewMessage).not.toHaveBeenCalled();
    expect(triggerBotReplyUseCase.execute).not.toHaveBeenCalled();
  });

  it('only reconciles the socket that retries a message', async () => {
    const senderEmit = jest.fn();
    const senderRoomEmit = jest.fn();
    const serverTo = jest.fn().mockReturnValue({ emit: jest.fn() });
    const sendMessageUseCase = {
      execute: jest.fn().mockResolvedValue({
        message: createMessage(),
        created: false,
      }),
    };
    const notificationService = { notifyNewMessage: jest.fn() };
    const triggerBotReplyUseCase = { execute: jest.fn() };
    const chatRepository = {
      assertConversationParticipant: jest.fn().mockResolvedValue(undefined),
      findConversation: jest.fn(),
    };
    const prometheusMetrics = {
      recordMessageCreated: jest.fn(),
      recordSendMessage: jest.fn(),
    };
    const gateway = new ChatGateway(
      sendMessageUseCase as never,
      triggerBotReplyUseCase as never,
      notificationService as never,
      prometheusMetrics as never,
      chatRepository as never,
      {} as never,
      {} as never,
    );
    gateway.server = { to: serverTo } as never;
    const socket = {
      id: 'socket-1',
      data: { userId: 'sender-1' },
      emit: senderEmit,
      to: jest.fn().mockReturnValue({ emit: senderRoomEmit }),
    };

    await gateway.handleMessage(
      {
        conversationId: 'conversation-1',
        clientMessageId: 'client-message-1',
        content: 'hello',
        type: 'text',
        signalType: 0,
      } as never,
      socket as never,
    );

    expect(senderEmit).toHaveBeenCalledWith(
      'message_synced',
      expect.objectContaining({ id: 'message-1' }),
    );
    expect(socket.to).not.toHaveBeenCalled();
    expect(senderRoomEmit).not.toHaveBeenCalled();
    expect(serverTo).not.toHaveBeenCalled();
    expect(chatRepository.findConversation).not.toHaveBeenCalled();
    expect(notificationService.notifyNewMessage).not.toHaveBeenCalled();
    expect(triggerBotReplyUseCase.execute).not.toHaveBeenCalled();
  });

  it('rejects a public socket send without an idempotency key', async () => {
    const senderEmit = jest.fn();
    const sendMessageUseCase = { execute: jest.fn() };
    const chatRepository = {
      assertConversationParticipant: jest.fn(),
    };
    const prometheusMetrics = {
      recordMessageCreated: jest.fn(),
      recordSendMessage: jest.fn(),
    };
    const gateway = new ChatGateway(
      sendMessageUseCase as never,
      {} as never,
      {} as never,
      prometheusMetrics as never,
      chatRepository as never,
      {} as never,
      {} as never,
    );
    const socket = {
      id: 'socket-1',
      data: { userId: 'sender-1' },
      emit: senderEmit,
    };

    await gateway.handleMessage(
      {
        conversationId: 'conversation-1',
        content: 'hello',
        type: 'text',
        signalType: 0,
      } as never,
      socket as never,
    );

    expect(senderEmit).toHaveBeenCalledWith('message_failed', {
      conversationId: 'conversation-1',
      clientMessageId: undefined,
    });
    expect(chatRepository.assertConversationParticipant).not.toHaveBeenCalled();
    expect(sendMessageUseCase.execute).not.toHaveBeenCalled();
  });
});
