import { PrismaClient } from '@prisma/conversation-client';
import { randomUUID } from 'node:crypto';
import { Message } from '../src/domain/entities/message.entity';
import { PrismaChatRepository } from '../src/infrastructure/repositories/prisma-chat.repository';
import {
  findDueNotificationIntents,
  readNotificationIntent,
} from '../src/infrastructure/repositories/notification-intent.reader';
import { MessageNotificationOutboxWorker } from '../src/infrastructure/workers/message-notification-outbox.worker';

const waitFor = async (ready: Promise<void>) => {
  let timer: NodeJS.Timeout | undefined;
  try {
    await Promise.race([
      ready,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error('Worker did not reach intake')),
          10_000,
        );
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
};

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
    const queries: string[] = [];
    const prisma = new PrismaClient({
      datasources: { db: { url: uri! } },
      log: [{ level: 'query', emit: 'event' }],
    });
    // Command prefixes only; never retain content/parameters in test evidence.
    prisma.$on('query', (event) => {
      queries.push(event.query.match(/^db\.[a-zA-Z.]+/)?.[0] ?? 'unknown');
    });
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
      const input = (clientMessageId: string, content = 'fixture') =>
        new Message({
          id: '',
          conversationId: conversation.id,
          senderId: 'sender',
          clientMessageId,
          content,
          type: 'text',
          signalType: 0,
          createdAt: new Date(),
        });
      const identity = randomUUID();
      queries.length = 0;
      const result = await repository.createMessageIdempotently(
        input(identity),
        { enqueueNotification: true },
      );
      expect(queries).toEqual(['db.runCommand', 'db.messages.insertMany']);
      const preview = await prisma.conversation.findUniqueOrThrow({
        where: { id: conversation.id },
      });
      expect(preview.lastMessage).toBe('fixture');
      expect(preview.lastMessageAt).toEqual(result.message.createdAt);
      const original = await prisma.message.findUniqueOrThrow({
        where: { id: result.message.id },
      });
      expect(original.notificationRecipientIds).toEqual(['member']);
      expect(original.content).toBe('encrypted:fixture');
      expect(original.notificationNextAttemptAt).toBeInstanceOf(Date);
      const replay = await repository.createMessageIdempotently(
        input(identity, 'must not replace preview'),
        { enqueueNotification: true },
      );
      expect(replay.created).toBe(false);
      expect(replay.message.id).toBe(original.id);
      expect(await prisma.message.count()).toBe(1);
      expect(
        await prisma.conversation.findUniqueOrThrow({
          where: { id: conversation.id },
        }),
      ).toEqual(preview);

      queries.length = 0;
      expect(await findDueNotificationIntents(prisma, new Date(), 20)).toEqual([
        { id: original.id },
      ]);
      expect(queries).toEqual(['db.messages.find']);
      expect(await findDueNotificationIntents(prisma, new Date(0), 20)).toEqual(
        [],
      );

      // Verify the real BSON projection and indexed join, not a mocked pipeline.
      const probeClaim = randomUUID();
      await prisma.message.update({
        where: { id: original.id },
        data: {
          notificationClaimId: probeClaim,
          notificationAttemptCount: 1,
        },
      });
      queries.length = 0;
      const intent = await readNotificationIntent(
        prisma,
        original.id,
        probeClaim,
      );
      expect(queries).toEqual(['db.messages.aggregate']);
      expect(intent).toMatchObject({
        id: original.id,
        conversationId: conversation.id,
        content: original.content,
        senderId: 'sender',
        signalType: 0,
        type: 'text',
        createdAt: original.createdAt,
        notificationRecipientIds: ['member'],
        notificationClaimId: probeClaim,
        conversation: {
          id: conversation.id,
          participantIds: ['sender', 'member'],
          isGroup: true,
          name: null,
        },
      });
      expect(
        await readNotificationIntent(prisma, original.id, 'stale-claim'),
      ).toBeNull();
      await prisma.message.update({
        where: { id: original.id },
        data: {
          notificationClaimId: null,
          notificationAttemptCount: 0,
        },
      });

      // Fail the real insert after findAndModify. The preview must roll back
      // together with the message and its notification intent.
      const transaction = (action: (tx: unknown) => Promise<unknown>) =>
        prisma.$transaction((tx) =>
          action({
            $runCommandRaw: (
              command: Parameters<typeof tx.$runCommandRaw>[0],
            ) => tx.$runCommandRaw(command),
            conversation: tx.conversation,
            message: {
              ...tx.message,
              createMany: () => {
                throw new Error('Injected message insert failure');
              },
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
        brokenRepository.createMessageIdempotently(
          input(randomUUID(), 'must roll back'),
          { enqueueNotification: true },
        ),
      ).rejects.toThrow('Injected message insert failure');
      expect(await prisma.message.count()).toBe(1);
      expect(
        await prisma.conversation.findUniqueOrThrow({
          where: { id: conversation.id },
        }),
      ).toEqual(preview);

      // Matching membership in the write must reject a removed sender, and
      // preserve 403 vs 404 without inserting or upserting anything.
      await prisma.conversation.update({
        where: { id: conversation.id },
        data: { participantIds: ['member'] },
      });
      await expect(
        repository.createMessageIdempotently(input(randomUUID())),
      ).rejects.toThrow('You are not allowed');
      await expect(
        repository.createMessageIdempotently(
          new Message({
            ...input(randomUUID()),
            conversationId: '000000000000000000000001',
          }),
        ),
      ).rejects.toThrow('Conversation not found');
      expect(await prisma.message.count()).toBe(1);
      expect(await prisma.conversation.count()).toBe(1);
      expect(
        (
          await prisma.conversation.findUniqueOrThrow({
            where: { id: conversation.id },
          })
        ).lastMessage,
      ).toBe('fixture');
      await prisma.conversation.update({
        where: { id: conversation.id },
        data: { participantIds: ['sender', 'member'] },
      });

      const notifications = {
        notifyNewMessage: jest.fn().mockResolvedValue(undefined),
      };
      const metrics = {
        measurePhase: jest.fn((_phase: string, action: () => unknown) =>
          action(),
        ),
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
      queries.length = 0;
      await Promise.all([worker().runOnce(), worker().runOnce()]);
      expect(notifications.notifyNewMessage).toHaveBeenCalledTimes(1);
      expect(queries).not.toContain('db.messages.updateMany');
      expect(
        queries.filter((query) => query === 'db.runCommand').length,
      ).toBeGreaterThanOrEqual(2);
      const done = await prisma.message.findUniqueOrThrow({
        where: { id: original.id },
      });
      expect(done.notificationNextAttemptAt).toBeNull();
      expect(done.notificationAttemptCount).toBe(1);
      expect(done.notificationRecipientIds).toEqual([]);
      expect(await findDueNotificationIntents(prisma, new Date(), 20)).toEqual(
        [],
      );
      await worker().runOnce();
      expect(notifications.notifyNewMessage).toHaveBeenCalledTimes(1);

      // Expire A's lease while its HTTP result is pending, then let B claim it.
      // A's actual Mongo completion/reschedule must not change B's lease.
      for (const outcome of ['success', 'failure']) {
        await prisma.message.update({
          where: { id: original.id },
          data: {
            notificationRecipientIds: ['member'],
            notificationNextAttemptAt: new Date(0),
          },
        });
        let firstStarted!: () => void;
        let secondStarted!: () => void;
        let finishFirst!: () => void;
        let failFirst!: (error: Error) => void;
        let finishSecond!: () => void;
        const firstReady = new Promise<void>((resolve) => {
          firstStarted = resolve;
        });
        const secondReady = new Promise<void>((resolve) => {
          secondStarted = resolve;
        });
        const firstResult = new Promise<void>((resolve, reject) => {
          finishFirst = resolve;
          failFirst = reject;
        });
        const secondResult = new Promise<void>((resolve) => {
          finishSecond = resolve;
        });
        notifications.notifyNewMessage
          .mockImplementationOnce(() => {
            firstStarted();
            return firstResult;
          })
          .mockImplementationOnce(() => {
            secondStarted();
            return secondResult;
          });
        const first = worker().runOnce();
        let second: Promise<void> | undefined;
        try {
          await waitFor(firstReady);
          const firstLease = await prisma.message.findUniqueOrThrow({
            where: { id: original.id },
          });
          await prisma.message.update({
            where: { id: original.id },
            data: { notificationNextAttemptAt: new Date(0) },
          });
          second = worker().runOnce();
          await waitFor(secondReady);
          const secondLease = await prisma.message.findUniqueOrThrow({
            where: { id: original.id },
          });
          expect(secondLease.notificationClaimId).not.toBe(
            firstLease.notificationClaimId,
          );
          if (outcome === 'success') finishFirst();
          else failFirst(new Error('HTTP result lost'));
          await first;
          const fenced = await prisma.message.findUniqueOrThrow({
            where: { id: original.id },
          });
          expect(fenced.notificationClaimId).toBe(
            secondLease.notificationClaimId,
          );
          expect(fenced.notificationNextAttemptAt).toEqual(
            secondLease.notificationNextAttemptAt,
          );
          expect(fenced.notificationRecipientIds).toEqual(['member']);
          finishSecond();
          await second;
          expect(
            (
              await prisma.message.findUniqueOrThrow({
                where: { id: original.id },
              })
            ).notificationNextAttemptAt,
          ).toBeNull();
        } finally {
          finishFirst();
          finishSecond();
          await Promise.allSettled([first, ...(second ? [second] : [])]);
        }
      }
      const beforeHistorical = notifications.notifyNewMessage.mock.calls.length;
      // Historical documents have absent fields, rather than explicit nulls.
      await prisma.$runCommandRaw({
        update: 'messages',
        updates: [
          {
            q: { _id: { $oid: original.id } },
            u: {
              $unset: {
                notificationNextAttemptAt: '',
                notificationClaimId: '',
                notificationRecipientIds: '',
                notificationAttemptCount: '',
              },
            },
          },
        ],
      });
      await worker().runOnce();
      expect(notifications.notifyNewMessage).toHaveBeenCalledTimes(
        beforeHistorical,
      );
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
