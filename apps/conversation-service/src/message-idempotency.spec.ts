import { ForbiddenException, Logger, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/conversation-client';
import { Message } from './domain/entities/message.entity';
import { Conversation } from './domain/entities/conversation.entity';
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

const createStoredConversation = () => ({
  id: 'conversation-1',
  creatorId: 'sender-1',
  participantIds: ['sender-1'],
  name: null,
  picture: null,
  memberJoinedAt: null,
  isGroup: false,
  lastMessage: 'hello',
  lastMessageAt: new Date('2026-07-15T00:00:00.000Z'),
  createdAt: new Date('2026-07-15T00:00:00.000Z'),
  updatedAt: new Date('2026-07-15T00:00:00.000Z'),
});

const prismaError = (code: string) =>
  new Prisma.PrismaClientKnownRequestError('private query detail', {
    code,
    clientVersion: '5.22.0',
  });
const transactionHarness = ($transaction: jest.Mock) => {
  const models = {
    conversation: {
      findUnique: jest.fn().mockResolvedValue(createStoredConversation()),
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
    },
    message: {
      createMany: jest.fn().mockResolvedValue({ count: 1 }),
      findFirst: jest.fn().mockResolvedValue(createStoredMessage()),
    },
  };
  const prisma = {
    ...models,
    $transaction: jest.fn(
      async (
        action: (tx: typeof models) => Promise<unknown>,
        options: unknown,
      ) => {
        const result = await action(models);
        await $transaction(action, options);
        return result;
      },
    ),
  };
  const redis = { del: jest.fn() };
  const encryption = {
    encrypt: jest.fn((s: string) => `encrypted:${s}`),
    decrypt: jest.fn((s: string) => s.replace('encrypted:', '')),
  };
  const repository = new PrismaChatRepository(
    prisma as never,
    redis as never,
    encryption,
    {} as never,
    {} as never,
  );
  return { repository, prisma, redis, encryption };
};

describe('message transaction conflicts', () => {
  it('returns the same initial fields written to Mongo without a read-back', async () => {
    const { repository, prisma } = transactionHarness(jest.fn());
    const input = createMessage();
    input.type = undefined as never;
    input.signalType = undefined as never;
    input.registrationId = 0;
    const result = await repository.createMessageIdempotently(input);
    const insert = prisma.message.createMany.mock.calls[0][0] as {
      data: ReturnType<typeof createStoredMessage>[];
    };
    expect(insert.data[0]).toMatchObject({
      type: 'text',
      signalType: 1,
      registrationId: 0,
      media: null,
      metadata: null,
      recalledAt: null,
      replyToId: null,
      replyPreview: null,
      reactions: null,
      readBy: [],
    });
    expect(result.message).toMatchObject({
      id: insert.data[0].id,
      createdAt: insert.data[0].createdAt,
      type: 'text',
      signalType: 1,
      registrationId: 0,
      readBy: [],
    });
    expect(prisma.message.findFirst).not.toHaveBeenCalled();
  });

  it('returns the transaction snapshot with the committed preview and explicit timestamps', async () => {
    const transaction = jest
      .fn()
      .mockResolvedValue([createStoredMessage(), createStoredConversation()]);
    const { repository, prisma } = transactionHarness(transaction);
    const result = await repository.createMessageIdempotently(createMessage());
    expect(result.conversation).toEqual(
      expect.objectContaining({
        id: 'conversation-1',
        participantIds: ['sender-1'],
        lastMessage: 'hello',
      }),
    );
    expect(prisma.conversation.findUnique).toHaveBeenCalledTimes(1);
    expect(prisma.conversation.updateMany).toHaveBeenCalledWith({
      where: { id: 'conversation-1' },
      data: {
        lastMessage: 'hello',
        lastMessageAt: expect.any(Date),
        updatedAt: expect.any(Date),
      },
    });
    expect(result.conversation?.updatedAt).toEqual(
      prisma.conversation.updateMany.mock.calls[0][0].data.updatedAt,
    );
    expect(transaction).toHaveBeenCalledWith(expect.any(Function), {
      maxWait: 2000,
      timeout: 5000,
    });
  });

  it.each([
    [
      'removed participant',
      { participantIds: ['other-user'] },
      ForbiddenException,
    ],
    ['missing conversation', null, NotFoundException],
  ])(
    'rejects %s at persistence before any mutation',
    async (_case, record, error) => {
      const transaction = jest.fn();
      const { repository, prisma, redis } = transactionHarness(transaction);
      prisma.conversation.findUnique.mockResolvedValue(record);
      await expect(
        repository.createMessageIdempotently(createMessage()),
      ).rejects.toBeInstanceOf(error);
      expect(prisma.message.createMany).not.toHaveBeenCalled();
      expect(prisma.conversation.updateMany).not.toHaveBeenCalled();
      expect(prisma.$transaction).toHaveBeenCalledTimes(1);
      expect(transaction).not.toHaveBeenCalled();
      expect(redis.del).not.toHaveBeenCalled();
    },
  );

  it('aborts the transaction when preview update finds no conversation', async () => {
    const commit = jest.fn();
    const { repository, prisma, redis } = transactionHarness(commit);
    prisma.conversation.updateMany.mockResolvedValue({ count: 0 });
    await expect(
      repository.createMessageIdempotently(createMessage()),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(prisma.message.createMany).toHaveBeenCalledTimes(1);
    expect(commit).not.toHaveBeenCalled();
    expect(redis.del).not.toHaveBeenCalled();
  });

  it('aborts an unexpected empty insert before preview or post-commit work', async () => {
    const commit = jest.fn();
    const { repository, prisma, redis } = transactionHarness(commit);
    prisma.message.createMany.mockResolvedValue({ count: 0 });
    await expect(
      repository.createMessageIdempotently(createMessage()),
    ).rejects.toMatchObject({ status: 500 });
    expect(prisma.conversation.updateMany).not.toHaveBeenCalled();
    expect(commit).not.toHaveBeenCalled();
    expect(redis.del).not.toHaveBeenCalled();
  });

  it('checks fresh membership after waiting for another room write', async () => {
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    let markEntered!: () => void;
    const entered = new Promise<void>((resolve) => {
      markEntered = resolve;
    });
    const { repository, prisma } = transactionHarness(jest.fn());
    prisma.conversation.updateMany.mockImplementationOnce(async () => {
      markEntered();
      await blocked;
      return { count: 1 };
    });
    const first = repository.createMessageIdempotently(createMessage());
    const second = repository.createMessageIdempotently(createMessage());
    const settled = Promise.allSettled([first, second]);
    // Wait until the first transaction has read membership and reached its write.
    await entered;
    prisma.conversation.findUnique.mockResolvedValue({
      ...createStoredConversation(),
      participantIds: ['other-user'],
    });
    release();
    const results = await settled;
    expect(results[0].status).toBe('fulfilled');
    expect(results[1]).toEqual({
      status: 'rejected',
      reason: expect.any(ForbiddenException),
    });
    expect(prisma.message.createMany).toHaveBeenCalledTimes(1);
  });

  it('authorizes reply hydration before reading the reply target', async () => {
    const { repository, prisma } = transactionHarness(jest.fn());
    prisma.conversation.findUnique.mockResolvedValue({
      ...createStoredConversation(),
      participantIds: ['other-user'],
    });
    const preview = jest.spyOn(repository as never, 'buildReplyPreview');
    const message = createMessage();
    message.replyToId = 'reply-target';
    await expect(
      repository.createMessageIdempotently(message),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(preview).not.toHaveBeenCalled();
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it('serializes writes to one conversation while allowing other conversations to proceed', async () => {
    let releaseFirst!: () => void;
    const blocked = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    let active = 0;
    let peak = 0;
    let calls = 0;
    const transaction = jest.fn(async () => {
      const call = ++calls;
      active += 1;
      peak = Math.max(peak, active);
      if (call === 1) await blocked;
      active -= 1;
      return [createStoredMessage(), createStoredConversation()];
    });
    const { repository } = transactionHarness(transaction);
    const first = repository.createMessageIdempotently(createMessage());
    const second = repository.createMessageIdempotently(createMessage());
    const otherMessage = createMessage();
    otherMessage.conversationId = 'conversation-2';
    await repository.createMessageIdempotently(otherMessage);
    expect(transaction).toHaveBeenCalledTimes(2);
    expect(peak).toBe(2);
    releaseFirst();
    await Promise.all([first, second]);
    expect(transaction).toHaveBeenCalledTimes(3);
    expect((repository as any).messageTransactions.size).toBe(0);
  });

  it('releases a failed transaction so the next send can commit', async () => {
    const failure = prismaError('P1001');
    const transaction = jest
      .fn()
      .mockRejectedValueOnce(failure)
      .mockResolvedValueOnce([
        createStoredMessage(),
        createStoredConversation(),
      ]);
    const { repository } = transactionHarness(transaction);
    const results = await Promise.allSettled([
      repository.createMessageIdempotently(createMessage()),
      repository.createMessageIdempotently(createMessage()),
    ]);
    expect(results[0]).toEqual({ status: 'rejected', reason: failure });
    expect(results[1].status).toBe('fulfilled');
    expect(transaction).toHaveBeenCalledTimes(2);
    expect((repository as any).messageTransactions.size).toBe(0);
  });

  it('rejects excess queued writes before database mutation and clears the queue after draining', async () => {
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    const transaction = jest.fn(async () => {
      await blocked;
      return [createStoredMessage(), createStoredConversation()];
    });
    const { repository, prisma } = transactionHarness(transaction);
    const writes = Array.from({ length: 101 }, () =>
      repository.createMessageIdempotently(createMessage()),
    );
    const settled = Promise.allSettled(writes);
    await expect(writes[100]).rejects.toMatchObject({ status: 429 });
    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
    release();
    const results = await settled;
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(100);
    expect(transaction).toHaveBeenCalledTimes(100);
    expect((repository as any).messageTransactions.size).toBe(0);
  });

  it('retries the complete rolled-back transaction with the same identity, then runs post-commit work once', async () => {
    const transaction = jest
      .fn()
      .mockRejectedValueOnce(prismaError('P2034'))
      .mockRejectedValueOnce(prismaError('P2034'))
      .mockResolvedValue([createStoredMessage(), createStoredConversation()]);
    const { repository, prisma, redis, encryption } =
      transactionHarness(transaction);
    const result = await repository.createMessageIdempotently(createMessage());
    expect(result.created).toBe(true);
    expect(transaction).toHaveBeenCalledTimes(3);
    expect(prisma.message.createMany).toHaveBeenCalledTimes(3);
    for (const [args] of prisma.message.createMany.mock.calls)
      expect(args.data[0].clientMessageId).toBe('client-message-1');
    const ids = prisma.message.createMany.mock.calls.map(
      ([args]) => (args as { data: Array<{ id: string }> }).data[0].id,
    );
    expect(new Set(ids).size).toBe(1);
    expect(ids[0]).toMatch(/^[a-f0-9]{24}$/);
    expect(result.message.id).toBe(ids[0]);
    expect(encryption.encrypt).toHaveBeenCalledTimes(1);
    expect(redis.del).toHaveBeenCalledTimes(1);
  });

  it('stops after six conflicted attempts without running post-commit work', async () => {
    const conflict = prismaError('P2034');
    const transaction = jest.fn().mockRejectedValue(conflict);
    const { repository, redis } = transactionHarness(transaction);
    await expect(
      repository.createMessageIdempotently(createMessage()),
    ).rejects.toBe(conflict);
    expect(transaction).toHaveBeenCalledTimes(6);
    expect(redis.del).not.toHaveBeenCalled();
  });

  it.each(['P1001', 'P2010'])(
    'does not retry ambiguous or unrelated database errors (%s)',
    async (code) => {
      const error = prismaError(code);
      const transaction = jest.fn().mockRejectedValue(error);
      const { repository } = transactionHarness(transaction);
      await expect(
        repository.createMessageIdempotently(createMessage()),
      ).rejects.toBe(error);
      expect(transaction).toHaveBeenCalledTimes(1);
    },
  );

  it('retains unique-conflict reconciliation after a transaction retry', async () => {
    const transaction = jest
      .fn()
      .mockRejectedValueOnce(prismaError('P2034'))
      .mockRejectedValueOnce(prismaError('P2002'));
    const { repository, prisma, redis } = transactionHarness(transaction);
    const result = await repository.createMessageIdempotently(createMessage());
    expect(result.created).toBe(false);
    expect(result.message.id).toBe('message-1');
    expect(transaction).toHaveBeenCalledTimes(2);
    expect(prisma.message.findFirst).toHaveBeenCalledTimes(1);
    expect(redis.del).not.toHaveBeenCalled();
  });

  it('does not retry failures after a successful commit', async () => {
    const transaction = jest
      .fn()
      .mockResolvedValue([createStoredMessage(), createStoredConversation()]);
    const { repository } = transactionHarness(transaction);
    const failure = prismaError('P2034');
    jest
      .spyOn(repository as never, 'syncPendingMediaTracking')
      .mockRejectedValueOnce(failure as never);
    await expect(
      repository.createMessageIdempotently(createMessage()),
    ).rejects.toBe(failure);
    expect(transaction).toHaveBeenCalledTimes(1);
  });

  it('logs only a safe error code and phase when the socket send fails', async () => {
    const warn = jest
      .spyOn(Logger.prototype, 'warn')
      .mockImplementation(() => {});
    try {
      const gateway = new ChatGateway(
        { execute: jest.fn().mockRejectedValue(prismaError('P2034')) } as never,
        {} as never,
        {} as never,
        {
          recordSendMessage: jest.fn(),
          measurePhase: jest.fn((_phase, action: () => unknown) => action()),
        } as never,
        {
          assertConversationParticipant: jest.fn().mockResolvedValue(undefined),
        } as never,
        {} as never,
        {} as never,
      );
      const emit = jest.fn();
      gateway.server = { to: jest.fn().mockReturnValue({ emit }) } as never;
      await gateway.handleMessage(
        createMessage() as never,
        { id: 'socket-1', data: { userId: 'sender-1' } } as never,
      );
      expect(warn).toHaveBeenCalledWith(
        'send_message failed phase=persist code=P2034 acknowledged=false',
      );
      expect(JSON.stringify(warn.mock.calls)).not.toContain(
        'private query detail',
      );
      expect(emit).toHaveBeenCalledWith('message_failed', {
        conversationId: 'conversation-1',
        clientMessageId: 'client-message-1',
      });
    } finally {
      warn.mockRestore();
    }
  });
});

describe('message idempotency', () => {
  it('reuses the committed snapshot in HTTP delivery and keeps it out of the response', async () => {
    const snapshot = new Conversation(createStoredConversation());
    const repository = {
      findConversation: jest.fn(),
      populateConversationParticipants: jest.fn().mockResolvedValue(snapshot),
    };
    const notifyNewMessage = jest.fn().mockResolvedValue(undefined);
    const controller = new ConversationMicroserviceController(
      {
        execute: jest.fn().mockResolvedValue({
          message: createMessage(),
          created: true,
          conversation: snapshot,
        }),
      } as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {
        emitToConversation: jest.fn(),
        emitConversationMessageActivity: jest.fn(),
      } as never,
      { execute: jest.fn().mockResolvedValue({}) } as never,
      { notifyNewMessage } as never,
      repository as never,
      {} as never,
    );
    const response = await controller.handleCreateMessage(
      createMessage() as never,
    );
    expect(repository.findConversation).not.toHaveBeenCalled();
    expect(repository.populateConversationParticipants).toHaveBeenCalledWith(
      snapshot,
    );
    expect(notifyNewMessage).toHaveBeenCalledWith(
      snapshot,
      expect.any(Message),
      'sender-1',
    );
    expect(response).toEqual({
      message: expect.objectContaining({ id: 'message-1' }),
      created: true,
    });
    expect(response).not.toHaveProperty('conversation');
  });

  it('enriches a per-send snapshot through User RPC without reading Mongo or caching it', async () => {
    const findUnique = jest.fn();
    const findUsersByIds = jest
      .fn()
      .mockResolvedValue([{ id: 'sender-1', name: 'Sender' }]);
    const repository = new PrismaChatRepository(
      { conversation: { findUnique } } as never,
      {} as never,
      {} as never,
      { findUsersByIds } as never,
      {} as never,
    );
    for (let i = 0; i < 2; i++) {
      const snapshot = new Conversation(createStoredConversation());
      await expect(
        repository.populateConversationParticipants(snapshot),
      ).resolves.toMatchObject({
        participants: [{ id: 'sender-1', name: 'Sender' }],
      });
    }
    expect(findUsersByIds).toHaveBeenCalledTimes(2);
    expect(findUnique).not.toHaveBeenCalled();
  });

  it('ACKs before participant enrichment and reuses the transaction snapshot for delivery', async () => {
    const order: string[] = [];
    const snapshot = new Conversation(createStoredConversation());
    const sendMessageUseCase = {
      execute: jest.fn().mockResolvedValue({
        message: createMessage(),
        created: true,
        conversation: snapshot,
      }),
    };
    const chatRepository = {
      assertConversationParticipant: jest.fn(),
      findConversation: jest.fn(),
      populateConversationParticipants: jest.fn(
        (conversation: Conversation) => {
          order.push('participants');
          return Promise.resolve(conversation);
        },
      ),
    };
    const notificationService = {
      notifyNewMessage: jest.fn().mockResolvedValue(undefined),
    };
    const triggerBotReplyUseCase = { execute: jest.fn().mockResolvedValue({}) };
    const gateway = new ChatGateway(
      sendMessageUseCase as never,
      triggerBotReplyUseCase as never,
      notificationService as never,
      {
        measurePhase: jest.fn((_phase, action: () => unknown) => action()),
        recordMessageCreated: jest.fn(),
        recordSendMessage: jest.fn(),
      } as never,
      chatRepository as never,
      {} as never,
      {} as never,
    );
    gateway.server = {
      to: jest.fn().mockReturnValue({ emit: jest.fn() }),
    } as never;
    await gateway.handleMessage(
      createMessage() as never,
      {
        id: 'socket-1',
        data: { userId: 'sender-1' },
        emit: jest.fn(() => order.push('ACK')),
        to: jest.fn().mockReturnValue({ emit: jest.fn() }),
      } as never,
    );
    expect(order).toEqual(['ACK', 'participants']);
    expect(chatRepository.assertConversationParticipant).not.toHaveBeenCalled();
    expect(chatRepository.findConversation).not.toHaveBeenCalled();
    expect(
      chatRepository.populateConversationParticipants,
    ).toHaveBeenCalledWith(snapshot);
    expect(notificationService.notifyNewMessage).toHaveBeenCalledWith(
      snapshot,
      expect.any(Message),
      'sender-1',
    );
    expect(triggerBotReplyUseCase.execute).toHaveBeenCalledWith(
      expect.any(Message),
      'sender-1',
      snapshot,
    );
  });

  it('still reports a persistence membership rejection without ACK or peer fanout', async () => {
    const metrics = {
      measurePhase: jest.fn((_phase, action: () => unknown) => action()),
      recordSendMessage: jest.fn(),
    };
    const gateway = new ChatGateway(
      {
        execute: jest.fn().mockRejectedValue(new ForbiddenException()),
      } as never,
      {} as never,
      {} as never,
      metrics as never,
      {} as never,
      {} as never,
      {} as never,
    );
    const emit = jest.fn();
    gateway.server = { to: jest.fn().mockReturnValue({ emit }) } as never;
    const socket = {
      id: 'socket-1',
      data: { userId: 'sender-1' },
      emit: jest.fn(),
      to: jest.fn(),
    };
    await gateway.handleMessage(createMessage() as never, socket as never);
    expect(socket.emit).not.toHaveBeenCalled();
    expect(socket.to).not.toHaveBeenCalled();
    expect(emit).toHaveBeenCalledWith(
      'message_failed',
      expect.objectContaining({ clientMessageId: 'client-message-1' }),
    );
    expect(metrics.recordSendMessage).toHaveBeenCalledWith(
      'rejected',
      expect.any(Number),
    );
  });

  it('resolves a concurrent insert conflict to the original message', async () => {
    const duplicateError = prismaError('P2002');
    const { repository, prisma } = transactionHarness(jest.fn());
    prisma.message.createMany
      .mockResolvedValueOnce({ count: 1 })
      .mockRejectedValueOnce(duplicateError);
    prisma.message.findFirst.mockImplementation(() => {
      const insert = prisma.message.createMany.mock.calls[0][0] as {
        data: ReturnType<typeof createStoredMessage>[];
      };
      return Promise.resolve(insert.data[0]);
    });

    const [first, retry] = await Promise.all([
      repository.createMessageIdempotently(createMessage()),
      repository.createMessageIdempotently(createMessage()),
    ]);

    expect([first.created, retry.created].sort()).toEqual([false, true]);
    expect(first.message.id).toMatch(/^[a-f0-9]{24}$/);
    expect(retry.message.id).toBe(first.message.id);
    expect(prisma.message.createMany).toHaveBeenCalledTimes(2);
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
      measurePhase: jest.fn((_phase, action: () => unknown) => action()),
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
      measurePhase: jest.fn((_phase, action: () => unknown) => action()),
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
