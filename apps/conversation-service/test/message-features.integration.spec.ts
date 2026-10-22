import { Prisma, PrismaClient } from '@prisma/conversation-client';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { Conversation } from '../src/domain/entities/conversation.entity';
import {
  PrismaChatRepository,
  UNREAD_COUNT_WINDOW,
} from '../src/infrastructure/repositories/prisma-chat.repository';
import { PrismaConversationChatRepository } from '../src/infrastructure/repositories/prisma-conversation-chat.repository';

const uri = process.env.OUTBOX_TEST_DATABASE_URL;
const integration = uri ? it : it.skip;

const reactionsOf = (message: { reactions: Prisma.JsonValue | null }) =>
  (message.reactions ?? {}) as Record<string, { emoji: string }>;

/**
 * Real-Mongo checks for the chat behaviours the unit tests can only fake:
 * atomic reactions, recall with many replies, the bounded unread count, the
 * conversation list order and the lastMessageAt backfill script. It needs an
 * isolated database, which it drops at the end.
 */
integration(
  'keeps reactions, recalls, unread counts and list order correct on real Mongo',
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
          {
            name: 'history',
            key: { conversationId: 1, createdAt: -1, _id: -1 },
          },
        ],
      });

      const deleted: Array<{ userId: string; fileKeys: string[] }> = [];
      const redis = {
        del: jest.fn().mockResolvedValue(1),
        hdel: jest.fn().mockResolvedValue(1),
        set: jest.fn().mockResolvedValue('OK'),
      };
      const encryption = {
        encrypt: (value: string) => `encrypted:${value}`,
        decrypt: (value: string) => value.replace('encrypted:', ''),
      };
      const userService = { findUsersByIds: jest.fn().mockResolvedValue([]) };
      const chatMediaService = {
        deleteRecalledChatMedia: jest.fn((input: (typeof deleted)[number]) => {
          deleted.push(input);
          return Promise.resolve();
        }),
      };
      const repository = new PrismaConversationChatRepository(
        prisma as never,
        redis as never,
        encryption,
        userService as never,
        chatMediaService,
      );
      const baseRepository = new PrismaChatRepository(
        prisma as never,
        redis as never,
        encryption,
        userService as never,
        chatMediaService,
      );

      const members = Array.from({ length: 8 }, (_, i) => `user-${i}`);
      const room = await prisma.conversation.create({
        data: {
          creatorId: members[0],
          participantIds: members,
          isGroup: true,
          lastMessageAt: new Date(),
        },
      });
      const newMessage = (overrides: Record<string, unknown> = {}) =>
        prisma.message.create({
          data: {
            conversationId: room.id,
            senderId: members[0],
            clientMessageId: randomUUID(),
            type: 'text',
            content: 'hello',
            ...overrides,
          },
        });

      // --- Reactions: every concurrent member keeps their reaction -----------
      const target = await newMessage();
      await Promise.all(
        members.map((userId, index) =>
          repository.addReaction(
            target.id,
            userId,
            ['👍', '❤️', '😂', '🔥'][index % 4],
          ),
        ),
      );
      let stored = await prisma.message.findUniqueOrThrow({
        where: { id: target.id },
      });
      expect(Object.keys(reactionsOf(stored)).sort()).toEqual(
        [...members].sort(),
      );

      await repository.addReaction(target.id, members[1], '😮');
      await repository.removeReaction(target.id, members[2]);
      await repository.removeReaction(target.id, members[2]); // already removed: a no-op
      stored = await prisma.message.findUniqueOrThrow({
        where: { id: target.id },
      });
      expect(reactionsOf(stored)[members[1]].emoji).toBe('😮');
      expect(reactionsOf(stored)[members[2]]).toBeUndefined();
      expect(Object.keys(reactionsOf(stored))).toHaveLength(members.length - 1);

      // A message that has no reaction map yet (null) and one that never had the field.
      const fresh = await newMessage();
      await repository.addReaction(fresh.id, members[3], '🔥');
      expect(
        reactionsOf(
          await prisma.message.findUniqueOrThrow({ where: { id: fresh.id } }),
        ),
      ).toEqual({ [members[3]]: expect.objectContaining({ emoji: '🔥' }) });

      // --- Recall: no reactions afterwards, replies updated, media after commit
      const sourceMedia = {
        fileKey: `chat-images/${members[0]}/pic.jpg`,
        fileUrl: 'https://cdn.velora.test/pic.jpg',
      };
      const original = await newMessage({
        type: 'image',
        media: sourceMedia,
      });
      const REPLIES = 40;
      const withoutPreview = (index: number) => index % 10 === 0;
      for (let index = 0; index < REPLIES; index += 1) {
        await newMessage({
          senderId: members[1 + (index % 3)],
          replyToId: original.id,
          replyPreview: withoutPreview(index)
            ? null
            : {
                senderName: `Sender ${index % 3}`,
                content: 'hello',
                type: 'image',
                thumbnailUri: 'https://cdn.velora.test/pic.jpg',
                mediaWidth: 640,
              },
        });
      }
      const recallStartedAt = Date.now();
      const recalled = await repository.recallMessage(original.id, members[0]);
      const recallMs = Date.now() - recallStartedAt;

      // Only replies that had a valid preview are rewritten and reported.
      expect(recalled.updatedReplyMessageIds).toHaveLength(
        REPLIES - Math.ceil(REPLIES / 10),
      );
      // One command instead of a round trip per reply; it used to take 7.7s
      // for 40 replies and now has to stay well under the old 5s limit.
      expect(recallMs).toBeLessThan(5000);
      expect(deleted).toEqual([
        { userId: members[0], fileKeys: [sourceMedia.fileKey] },
      ]);
      expect(recalled.message.media).toBeUndefined();
      const recalledRecord = await prisma.message.findUniqueOrThrow({
        where: { id: original.id },
      });
      expect(recalledRecord.isRecalled).toBe(true);
      expect(recalledRecord.media).toBeNull();
      await expect(
        repository.addReaction(original.id, members[4], '👍'),
      ).rejects.toThrow('recalled');
      expect(
        (await prisma.message.findUniqueOrThrow({ where: { id: original.id } }))
          .reactions,
      ).toBeNull();
      const replies = await prisma.message.findMany({
        where: { replyToId: original.id },
        orderBy: { createdAt: 'asc' },
      });
      expect(replies).toHaveLength(REPLIES);
      replies.forEach((reply, index) => {
        if (withoutPreview(index)) {
          expect(reply.replyPreview).toBeNull();
          expect(recalled.updatedReplyMessageIds).not.toContain(reply.id);
        } else {
          // Own senderName kept; media metadata dropped; text-only.
          expect(reply.replyPreview).toEqual({
            senderName: `Sender ${index % 3}`,
            content: 'Tin nhắn đã thu hồi',
            type: 'text',
          });
          expect(recalled.updatedReplyMessageIds).toContain(reply.id);
        }
      });

      // --- Unread counts are bounded and exact within the window ------------
      const busy = await prisma.conversation.create({
        data: {
          creatorId: 'other',
          participantIds: ['me', 'other'],
          isGroup: false,
          lastMessageAt: new Date(Date.now() + 1000),
        },
      });
      const base = Date.now() - 10 * 60_000;
      await prisma.message.createMany({
        data: Array.from({ length: UNREAD_COUNT_WINDOW + 30 }, (_, index) => ({
          conversationId: busy.id,
          senderId: 'other',
          clientMessageId: `unread-${index}`,
          type: 'text',
          content: 'x',
          createdAt: new Date(base + index * 1000),
          readBy: [],
        })),
      });
      const quiet = await prisma.conversation.create({
        data: {
          creatorId: 'other',
          participantIds: ['me', 'other'],
          isGroup: false,
          lastMessageAt: new Date(Date.now() + 500),
        },
      });
      await prisma.message.createMany({
        data: Array.from({ length: 5 }, (_, index) => ({
          conversationId: quiet.id,
          senderId: 'other',
          clientMessageId: `read-${index}`,
          type: 'text',
          content: 'x',
          createdAt: new Date(base + index * 1000),
          readBy: [{ userId: 'me', at: new Date() }],
        })),
      });

      // --- New conversations sort by creation time, not last ----------------
      const createdNow = await repository.createConversation(
        new Conversation({
          creatorId: 'me',
          participantIds: ['me', 'someone'],
          isGroup: false,
          createdAt: new Date(Date.now() + 5000),
          updatedAt: new Date(Date.now() + 5000),
        }),
      );
      // A row written before the fix, with a null lastMessageAt.
      const legacyEmpty = await prisma.conversation.create({
        data: {
          creatorId: 'me',
          participantIds: ['me', 'legacy'],
          isGroup: false,
          lastMessageAt: null,
        },
      });

      const beforeBackfill =
        await baseRepository.findConversationsByUserId('me');
      const unreadById = Object.fromEntries(
        beforeBackfill.map((c) => [c.id, c.unreadCount]),
      );
      expect(unreadById[busy.id]).toBe(UNREAD_COUNT_WINDOW);
      expect(unreadById[quiet.id]).toBe(0);
      // The new conversation is listed ahead of the legacy empty one, which
      // sorts last.
      const order = beforeBackfill.map((c) => c.id);
      expect(order.indexOf(createdNow.id)).toBeLessThan(
        order.indexOf(legacyEmpty.id),
      );
      expect(order[order.length - 1]).toBe(legacyEmpty.id);

      // --- Backfill script: refuses without CONFIRM, then fills only nulls ---
      const script = join(
        __dirname,
        '../../../scripts/backfill-conversation-last-message-at.cjs',
      );
      const run = (confirm: boolean) =>
        spawnSync('node', [script], {
          env: {
            ...process.env,
            CONVERSATION_DATABASE_URL: uri!,
            ...(confirm
              ? { CONFIRM: 'BACKFILL_CONVERSATION_LAST_MESSAGE_AT' }
              : { CONFIRM: '' }),
          },
          encoding: 'utf8',
        });
      const refused = run(false);
      expect(refused.status).not.toBe(0);
      expect(refused.stdout).toContain('with a null lastMessageAt: 1');
      expect(
        (
          await prisma.conversation.findUniqueOrThrow({
            where: { id: legacyEmpty.id },
          })
        ).lastMessageAt,
      ).toBeNull();

      const busyBefore = (
        await prisma.conversation.findUniqueOrThrow({ where: { id: busy.id } })
      ).lastMessageAt;
      const applied = run(true);
      expect(applied.status).toBe(0);
      const legacyAfter = await prisma.conversation.findUniqueOrThrow({
        where: { id: legacyEmpty.id },
      });
      expect(legacyAfter.lastMessageAt).toEqual(legacyAfter.createdAt);
      expect(
        (
          await prisma.conversation.findUniqueOrThrow({
            where: { id: busy.id },
          })
        ).lastMessageAt,
      ).toEqual(busyBefore);
      expect(run(true).status).toBe(0);

      console.log(
        `recall of a message with ${REPLIES} replies took ${recallMs} ms`,
      );
    } finally {
      try {
        if (created) await prisma.$runCommandRaw({ dropDatabase: 1 });
      } finally {
        await prisma.$disconnect();
      }
    }
  },
  180_000,
);
