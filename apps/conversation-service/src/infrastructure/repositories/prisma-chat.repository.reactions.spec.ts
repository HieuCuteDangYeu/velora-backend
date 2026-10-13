import {
  BadRequestException,
  ConflictException,
  NotFoundException,
} from '@nestjs/common';
import { PrismaChatRepository } from './prisma-chat.repository';

type StoredMessage = {
  id: string;
  conversationId: string;
  senderId: string;
  isRecalled: boolean;
  reactions: Record<string, unknown> | null;
};

type RawFilter = {
  _id: { $oid: string };
  isRecalled?: boolean;
  reactions?: { $type: string } | null;
};

type RawUpdate = {
  $set?: Record<string, unknown>;
  $unset?: Record<string, unknown>;
};

const MESSAGE_ID = '507f1f77bcf86cd799439011';
const CONVERSATION_ID = '507f1f77bcf86cd799439012';

/**
 * A one-collection stand-in that implements only the filters and operators the
 * reaction code issues, each applied atomically like a Mongo single-document
 * update. It lets the tests interleave callers the way real members do.
 */
const createHarness = (initial: Partial<StoredMessage> = {}) => {
  const message: StoredMessage = {
    id: MESSAGE_ID,
    conversationId: CONVERSATION_ID,
    senderId: 'sender',
    isRecalled: false,
    reactions: null,
    ...initial,
  };
  const rawCommands: Array<{ q: RawFilter; u: RawUpdate }> = [];
  let beforeEachRaw: (() => Promise<void>) | null = null;

  const matches = (filter: RawFilter) => {
    if (filter._id.$oid !== message.id) return false;
    if (
      filter.isRecalled !== undefined &&
      filter.isRecalled !== message.isRecalled
    ) {
      return false;
    }
    if (filter.reactions === null) return message.reactions === null;
    if (filter.reactions?.$type === 'object') {
      return (
        message.reactions !== null && typeof message.reactions === 'object'
      );
    }
    return true;
  };

  const prisma = {
    message: {
      findUnique: jest.fn(() => Promise.resolve({ ...message })),
    },
    $runCommandRaw: jest.fn(
      async (command: { updates: Array<{ q: RawFilter; u: RawUpdate }> }) => {
        await beforeEachRaw?.();
        const { q, u } = command.updates[0];
        rawCommands.push({ q, u });
        if (!matches(q)) return { n: 0, nModified: 0, ok: 1 };

        for (const [path, value] of Object.entries(u.$set ?? {})) {
          if (path === 'reactions') {
            message.reactions = value as Record<string, unknown>;
          } else {
            message.reactions![path.replace('reactions.', '')] = value;
          }
        }
        for (const path of Object.keys(u.$unset ?? {})) {
          delete message.reactions![path.replace('reactions.', '')];
        }
        return { n: 1, nModified: 1, ok: 1 };
      },
    ),
  };

  const repository = new PrismaChatRepository(
    prisma as never,
    { del: jest.fn() } as never,
    { decrypt: jest.fn(), encrypt: jest.fn() },
    { findUsersByIds: jest.fn().mockResolvedValue([]) } as never,
  ) as unknown as {
    addReaction: (m: string, u: string, e: string) => Promise<unknown>;
    removeReaction: (m: string, u: string) => Promise<unknown>;
  };

  const internals = repository as unknown as Record<string, unknown>;
  internals.assertConversationParticipant = jest
    .fn()
    .mockResolvedValue(undefined);
  internals.clearConversationCache = jest.fn().mockResolvedValue(undefined);
  internals.hydrateReactionUpdateMessage = jest.fn((value: unknown) =>
    Promise.resolve(value),
  );

  return {
    message,
    prisma,
    rawCommands,
    repository,
    onEachRaw: (hook: () => Promise<void>) => {
      beforeEachRaw = hook;
    },
  };
};

const emojiOf = (message: StoredMessage, userId: string) =>
  (message.reactions?.[userId] as { emoji: string } | undefined)?.emoji;

describe('PrismaChatRepository reactions', () => {
  it('sets only the caller key on an existing reaction map', async () => {
    const { message, rawCommands, repository } = createHarness({
      reactions: { alice: { emoji: '👍', createdAt: 't0' } },
    });

    await repository.addReaction(MESSAGE_ID, 'bob', '❤️');

    expect(rawCommands).toHaveLength(1);
    expect(Object.keys(rawCommands[0].u.$set!)).toEqual(['reactions.bob']);
    expect(emojiOf(message, 'alice')).toBe('👍');
    expect(emojiOf(message, 'bob')).toBe('❤️');
  });

  it('creates the map when the message has no reactions yet', async () => {
    const { message, repository } = createHarness({ reactions: null });

    await repository.addReaction(MESSAGE_ID, 'alice', '🔥');

    expect(emojiOf(message, 'alice')).toBe('🔥');
  });

  it('keeps every reaction when members react at the same moment', async () => {
    const harness = createHarness({ reactions: null });
    // Yield before each command so all callers read the same initial state,
    // the interleaving that used to lose all but one reaction.
    harness.onEachRaw(() => new Promise((resolve) => setImmediate(resolve)));

    await Promise.all(
      ['alice', 'bob', 'carol', 'dave'].map((userId, index) =>
        harness.repository.addReaction(
          MESSAGE_ID,
          userId,
          ['👍', '❤️', '😂', '🔥'][index],
        ),
      ),
    );

    expect(Object.keys(harness.message.reactions ?? {}).sort()).toEqual([
      'alice',
      'bob',
      'carol',
      'dave',
    ]);
    expect(emojiOf(harness.message, 'carol')).toBe('😂');
  });

  it('replaces a members own reaction instead of adding another', async () => {
    const { message, repository } = createHarness({
      reactions: { alice: { emoji: '👍', createdAt: 't0' } },
    });

    await repository.addReaction(MESSAGE_ID, 'alice', '😂');

    expect(Object.keys(message.reactions ?? {})).toEqual(['alice']);
    expect(emojiOf(message, 'alice')).toBe('😂');
  });

  it('refuses reactions on a recalled message without writing', async () => {
    const { message, repository } = createHarness({
      isRecalled: true,
      reactions: null,
    });

    await expect(
      repository.addReaction(MESSAGE_ID, 'alice', '👍'),
    ).rejects.toThrow(BadRequestException);
    expect(message.reactions).toBeNull();
  });

  it('refuses a message that disappeared and one that cannot be updated', async () => {
    const missing = createHarness();
    missing.prisma.message.findUnique.mockResolvedValueOnce(null as never);
    await expect(
      missing.repository.addReaction(MESSAGE_ID, 'alice', '👍'),
    ).rejects.toThrow(NotFoundException);

    const stuck = createHarness();
    stuck.prisma.$runCommandRaw.mockResolvedValue({ n: 0, ok: 1 });
    await expect(
      stuck.repository.addReaction(MESSAGE_ID, 'alice', '👍'),
    ).rejects.toThrow(ConflictException);
    // Two updates per attempt, three attempts, then it gives up.
    expect(stuck.prisma.$runCommandRaw).toHaveBeenCalledTimes(6);
  });

  it('rejects emoji and user ids that are empty, oversized or unsafe in a path', async () => {
    const { prisma, repository } = createHarness();

    await expect(
      repository.addReaction(MESSAGE_ID, 'alice', '   '),
    ).rejects.toThrow(BadRequestException);
    await expect(
      repository.addReaction(MESSAGE_ID, 'alice', 'x'.repeat(33)),
    ).rejects.toThrow(BadRequestException);
    await expect(
      repository.addReaction(MESSAGE_ID, 'a.b', '👍'),
    ).rejects.toThrow(BadRequestException);
    await expect(
      repository.addReaction(MESSAGE_ID, 'a$b', '👍'),
    ).rejects.toThrow(BadRequestException);
    await expect(
      repository.addReaction('not-an-id', 'alice', '👍'),
    ).rejects.toThrow(BadRequestException);
    expect(prisma.$runCommandRaw).not.toHaveBeenCalled();
  });

  it('removes only the callers key, and removing a missing key is a no-op', async () => {
    const { message, rawCommands, repository } = createHarness({
      reactions: {
        alice: { emoji: '👍', createdAt: 't0' },
        bob: { emoji: '❤️', createdAt: 't1' },
      },
    });

    await repository.removeReaction(MESSAGE_ID, 'alice');
    expect(Object.keys(rawCommands[0].u.$unset!)).toEqual(['reactions.alice']);
    expect(Object.keys(message.reactions ?? {})).toEqual(['bob']);

    await repository.removeReaction(MESSAGE_ID, 'nobody');
    expect(Object.keys(message.reactions ?? {})).toEqual(['bob']);
  });

  it('removal tolerates a message with no reaction map', async () => {
    const { message, repository } = createHarness({ reactions: null });

    await repository.removeReaction(MESSAGE_ID, 'alice');

    expect(message.reactions).toBeNull();
  });
});
