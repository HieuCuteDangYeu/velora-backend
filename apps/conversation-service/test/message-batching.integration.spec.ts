import { Prisma, PrismaClient } from '@prisma/conversation-client';
import { randomUUID } from 'node:crypto';
import { Message } from '../src/domain/entities/message.entity';
import { PrismaChatRepository } from '../src/infrastructure/repositories/prisma-chat.repository';

const uri = process.env.OUTBOX_TEST_DATABASE_URL;
const integration = uri ? it : it.skip;

integration(
  'batches real Mongo writes without losing identity, membership or rollback safety',
  async () => {
    if (
      !/^velora_outbox_test_[a-f0-9]{16}$/.test(new URL(uri!).pathname.slice(1))
    ) {
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
        ],
      });
      const room = await prisma.conversation.create({
        data: {
          creatorId: 'alice',
          participantIds: ['alice', 'bob', 'observer'],
          isGroup: true,
        },
      });
      const input = (key: string, senderId = 'alice') =>
        new Message({
          conversationId: room.id,
          senderId,
          clientMessageId: key,
          content: key,
          type: 'text',
        });
      const encryption = {
        encrypt: (value: string) => `encrypted:${value}`,
        decrypt: (value: string) => value.replace('encrypted:', ''),
      };
      const gatedRepository = (failBatch?: 'conflict' | 'insert') => {
        let release!: () => void;
        const blocked = new Promise<void>((resolve) => {
          release = resolve;
        });
        let entered!: () => void;
        const ready = new Promise<void>((resolve) => {
          entered = resolve;
        });
        const sizes: number[] = [];
        const insertedIds: string[][] = [];
        let first = true;
        let injected = false;
        const transaction = async (
          action: (tx: Prisma.TransactionClient) => Promise<unknown>,
          options: { maxWait: number; timeout: number },
        ) => {
          const result = await prisma.$transaction(
            (tx) =>
              action({
                $runCommandRaw: (command: Prisma.InputJsonObject) =>
                  tx.$runCommandRaw(command),
                conversation: tx.conversation,
                message: {
                  ...tx.message,
                  createMany: (args: {
                    data: Prisma.MessageCreateManyInput[];
                  }) => {
                    sizes.push(args.data.length);
                    insertedIds.push(args.data.map((value) => value.id!));
                    if (args.data.length > 1 && failBatch && !injected) {
                      injected = true;
                      if (failBatch === 'conflict')
                        throw new Prisma.PrismaClientKnownRequestError(
                          'Injected rolled-back conflict',
                          { code: 'P2034', clientVersion: '5.22.0' },
                        );
                      throw new Error('Injected batch insert failure');
                    }
                    return tx.message.createMany(args);
                  },
                },
              } as unknown as Prisma.TransactionClient),
            options,
          );
          // Block after the first real commit so the test can deterministically enqueue backlog.
          if (first) {
            first = false;
            entered();
            await blocked;
          }
          return result;
        };
        const repository = new PrismaChatRepository(
          { $transaction: transaction, message: prisma.message } as never,
          { del: () => Promise.resolve(1) } as never,
          encryption,
          {} as never,
          {} as never,
        );
        const send = (message: Message) =>
          repository.createMessageIdempotently(message, {
            enqueueNotification: true,
          });
        return { send, ready, release: () => release(), sizes, insertedIds };
      };

      const batch = gatedRepository();
      const first = batch.send(input('first'));
      await batch.ready;
      const queued = Array.from({ length: 12 }, (_, index) =>
        batch.send(input(`batch-${index}`, index % 2 ? 'bob' : 'alice')),
      );
      await Promise.resolve();
      await Promise.resolve();
      batch.release();
      const results = await Promise.all([first, ...queued]);
      expect(batch.sizes).toEqual([1, 10, 2]);
      expect(results.every((result) => result.created)).toBe(true);
      expect(await prisma.message.count()).toBe(13);
      const stored = await prisma.message.findMany({
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      });
      expect(stored.map((value) => value.clientMessageId)).toEqual([
        'first',
        ...Array.from({ length: 12 }, (_, index) => `batch-${index}`),
      ]);
      for (const value of stored) {
        expect(value.content).toBe(`encrypted:${value.clientMessageId}`);
        expect(value.notificationRecipientIds).toEqual(
          ['alice', 'bob', 'observer'].filter((id) => id !== value.senderId),
        );
        expect(value.notificationNextAttemptAt).toBeInstanceOf(Date);
      }
      const preview = await prisma.conversation.findUniqueOrThrow({
        where: { id: room.id },
      });
      expect(preview.lastMessage).toBe(stored[12].clientMessageId);
      expect(preview.lastMessageAt).toEqual(stored[12].createdAt);

      const replayBatch = gatedRepository();
      const beforeReplay = replayBatch.send(input('before-replay'));
      await replayBatch.ready;
      const replayed = [
        replayBatch.send(input('fresh-a')),
        replayBatch.send(
          new Message({
            ...input('first'),
            content: 'must not replace original',
          }),
        ),
        replayBatch.send(input('fresh-b')),
      ];
      await Promise.resolve();
      await Promise.resolve();
      replayBatch.release();
      const replayResults = await Promise.all([beforeReplay, ...replayed]);
      expect(replayResults.map((result) => result.created)).toEqual([
        true,
        true,
        false,
        true,
      ]);
      expect(replayResults[2].message.id).toBe(results[0].message.id);
      expect(replayResults[2].message.content).toBe('first');
      expect(replayBatch.sizes).toEqual([1, 3, 1, 1, 1]);
      expect(await prisma.message.count()).toBe(16);
      expect(
        (
          await prisma.conversation.findUniqueOrThrow({
            where: { id: room.id },
          })
        ).lastMessage,
      ).toBe('fresh-b');

      const membershipBatch = gatedRepository();
      const beforeRemoval = membershipBatch.send(input('before-removal'));
      await membershipBatch.ready;
      const pending = ['alice', 'outsider', 'bob', 'alice'].map(
        (senderId, index) =>
          membershipBatch.send(input(`membership-${index}`, senderId)),
      );
      const settled = Promise.allSettled(pending);
      await Promise.resolve();
      await Promise.resolve();
      await prisma.conversation.update({
        where: { id: room.id },
        data: { participantIds: ['alice', 'observer'] },
      });
      membershipBatch.release();
      await beforeRemoval;
      const outcomes = await settled;
      expect(outcomes.map((result) => result.status)).toEqual([
        'fulfilled',
        'rejected',
        'rejected',
        'fulfilled',
      ]);
      expect(outcomes[1]).toMatchObject({ reason: { status: 403 } });
      expect(outcomes[2]).toMatchObject({ reason: { status: 403 } });
      expect(await prisma.message.count()).toBe(19);
      expect(
        await prisma.message.count({
          where: { clientMessageId: { in: ['membership-1', 'membership-2'] } },
        }),
      ).toBe(0);
      expect(
        (
          await prisma.message.findFirstOrThrow({
            where: { clientMessageId: 'membership-3' },
          })
        ).notificationRecipientIds,
      ).toEqual(['observer']);

      const broken = gatedRepository('insert');
      const beforeFailure = broken.send(input('before-failure'));
      await broken.ready;
      const failed = Promise.allSettled([
        broken.send(input('must-rollback-a')),
        broken.send(input('must-rollback-b')),
      ]);
      await Promise.resolve();
      await Promise.resolve();
      broken.release();
      await beforeFailure;
      expect((await failed).map((result) => result.status)).toEqual([
        'rejected',
        'rejected',
      ]);
      expect(broken.sizes).toEqual([1, 2]);
      expect(await prisma.message.count()).toBe(20);
      expect(
        (
          await prisma.conversation.findUniqueOrThrow({
            where: { id: room.id },
          })
        ).lastMessage,
      ).toBe('before-failure');

      const conflicted = gatedRepository('conflict');
      const beforeConflict = conflicted.send(input(randomUUID()));
      await conflicted.ready;
      const retry = [
        conflicted.send(input('conflict-a')),
        conflicted.send(input('conflict-b')),
      ];
      await Promise.resolve();
      await Promise.resolve();
      conflicted.release();
      await Promise.all([beforeConflict, ...retry]);
      expect(conflicted.sizes).toEqual([1, 2, 2]);
      expect(conflicted.insertedIds[1]).toEqual(conflicted.insertedIds[2]);
      expect(await prisma.message.count()).toBe(23);
      expect(
        (
          await prisma.conversation.findUniqueOrThrow({
            where: { id: room.id },
          })
        ).lastMessage,
      ).toBe('conflict-b');
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
