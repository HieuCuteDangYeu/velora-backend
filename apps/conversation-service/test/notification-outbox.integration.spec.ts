import { PrismaClient } from '@prisma/conversation-client';
import { randomUUID } from 'node:crypto';
import { Message } from '../src/domain/entities/message.entity';
import { PrismaChatRepository } from '../src/infrastructure/repositories/prisma-chat.repository';
import { MessageNotificationOutboxWorker } from '../src/infrastructure/workers/message-notification-outbox.worker';

// Opt-in only, and refuse the application's actual database even by mistake.
const uri = process.env.OUTBOX_TEST_DATABASE_URL;
const integration = uri ? it : it.skip;

integration(
  'commits/rolls back intents and atomically claims them in real Mongo',
  async () => {
    const database = new URL(uri!).pathname.slice(1);
    if (!/^velora_outbox_test_[a-f0-9]{16}$/.test(database)) {
      throw new Error(
        'Use a new isolated velora_outbox_test_<16 hex> database',
      );
    }
    const prisma = new PrismaClient({ datasources: { db: { url: uri! } } });
    let created = false;
    try {
      await prisma.$runCommandRaw({ create: 'conversations' });
      created = true;
      await prisma.$runCommandRaw({ create: 'messages' });
      await prisma.$runCommandRaw({
        createIndexes: 'messages',
        indexes: [
          {
            name: 'message_identity',
            unique: true,
            key: { conversationId: 1, senderId: 1, clientMessageId: 1 },
          },
          {
            name: 'messages_notification_outbox_due',
            key: { notificationNextAttemptAt: 1, _id: 1 },
          },
        ],
      });
      const conversation = await prisma.conversation.create({
        data: {
          creatorId: 'sender',
          participantIds: ['sender', 'member'],
          isGroup: true,
        },
      });
      const encryption = {
        encrypt: (text: string) => `encrypted:${text}`,
        decrypt: (text: string) => text.replace('encrypted:', ''),
      };
      const chats = {
        populateConversationParticipants: jest.fn((value) =>
          Promise.resolve(value),
        ),
      };
      const repository = new PrismaChatRepository(
        prisma as never,
        { del: jest.fn().mockResolvedValue(1) } as never,
        encryption,
        {} as never,
        {} as never,
      );
      const input = (clientMessageId: string) =>
        new Message({
          id: '',
          conversationId: conversation.id,
          senderId: 'sender',
          clientMessageId,
          content: 'fixture',
          type: 'text',
          signalType: 0,
          createdAt: new Date(),
        });
      const identity = randomUUID();
      const result = await repository.createMessageIdempotently(
        input(identity),
        { enqueueNotification: true },
      );
      const original = await prisma.message.findUniqueOrThrow({
        where: { id: result.message.id },
      });
      expect(original.notificationRecipientIds).toEqual(['member']);
      expect(original.content).toBe('encrypted:fixture');
      expect(original.notificationNextAttemptAt).toBeInstanceOf(Date);
      const replay = await repository.createMessageIdempotently(
        input(identity),
        { enqueueNotification: true },
      );
      expect(replay.created).toBe(false);
      expect(replay.message.id).toBe(original.id);
      expect(await prisma.message.count()).toBe(1);

      // Inject a preview failure after the real insert inside the transaction.
      const transaction = (action: (tx: unknown) => Promise<unknown>) =>
        prisma.$transaction((tx) =>
          action({
            ...tx,
            conversation: {
              ...tx.conversation,
              updateMany: () => Promise.resolve({ count: 0 }),
            },
          }),
        );
      const brokenRepository = new PrismaChatRepository(
        { $transaction: transaction } as never,
        {} as never,
        encryption,
        {} as never,
        {} as never,
      );
      await expect(
        brokenRepository.createMessageIdempotently(input(randomUUID()), {
          enqueueNotification: true,
        }),
      ).rejects.toThrow('Conversation not found');
      expect(await prisma.message.count()).toBe(1);

      const notifications = {
        notifyNewMessage: jest.fn().mockResolvedValue(undefined),
      };
      const metrics = {
        recordNotificationOutbox: jest.fn(),
        setNotificationOutboxPending: jest.fn(),
      };
      const worker = () =>
        new MessageNotificationOutboxWorker(
          prisma as never,
          notifications as never,
          chats as never,
          encryption,
          metrics as never,
        );
      await Promise.all([worker().runOnce(), worker().runOnce()]);
      expect(notifications.notifyNewMessage).toHaveBeenCalledTimes(1);
      const done = await prisma.message.findUniqueOrThrow({
        where: { id: original.id },
      });
      expect(done.notificationNextAttemptAt).toBeNull();
      expect(done.notificationAttemptCount).toBe(1);
      expect(done.notificationRecipientIds).toEqual([]);
      expect(
        await prisma.message.count({
          where: { notificationNextAttemptAt: { not: null } },
        }),
      ).toBe(0);
    } finally {
      try {
        if (created) await prisma.$runCommandRaw({ dropDatabase: 1 });
      } finally {
        await prisma.$disconnect();
      }
    }
  },
  60_000,
);
