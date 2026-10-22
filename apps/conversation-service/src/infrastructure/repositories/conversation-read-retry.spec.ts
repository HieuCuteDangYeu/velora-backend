import { ForbiddenException, Logger, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/conversation-client';
import { Message } from '../../domain/entities/message.entity';
import { PrismaChatRepository } from './prisma-chat.repository';

const ioTimeout = () =>
  new Prisma.PrismaClientUnknownRequestError(
    'Invalid prisma.conversation.findUnique() invocation: I/O error: Operation timed out (os error 110)',
    { clientVersion: 'test' },
  );
const row = () => ({
  id: '507f1f77bcf86cd799439012',
  creatorId: 'alice',
  participantIds: ['alice', 'bob'],
  isGroup: false,
  name: null,
  picture: null,
  memberJoinedAt: null,
  lastMessage: null,
  lastMessageAt: null,
  createdAt: new Date(),
  updatedAt: new Date(),
});
function harness() {
  const findUnique = jest.fn().mockResolvedValue(row());
  const transaction = jest.fn();
  const users = { findUsersByIds: jest.fn().mockResolvedValue([]) };
  const repository = new PrismaChatRepository(
    { conversation: { findUnique }, $transaction: transaction } as never,
    { del: jest.fn() } as never,
    { encrypt: (s) => s, decrypt: (s) => s },
    users as never,
    {} as never,
  );
  return { repository, findUnique, transaction, users };
}

describe('conversation read I/O recovery', () => {
  beforeEach(() => jest.spyOn(Logger.prototype, 'warn').mockImplementation());
  afterEach(() => jest.restoreAllMocks());

  it('retries the observed read timeout once, with a fresh Prisma operation', async () => {
    const h = harness();
    h.findUnique.mockRejectedValueOnce(ioTimeout());
    await expect(
      h.repository.findConversation(row().id),
    ).resolves.toMatchObject({
      participantIds: ['alice', 'bob'],
    });
    expect(h.findUnique).toHaveBeenCalledTimes(2);
    expect(h.findUnique.mock.calls[0]).toEqual(h.findUnique.mock.calls[1]);
    expect(h.users.findUsersByIds).toHaveBeenCalledTimes(1);
    expect(Logger.prototype.warn).toHaveBeenCalledWith(
      'Conversation read I/O timeout; retrying once',
    );
  });

  it('propagates the second failure without a third attempt', async () => {
    const h = harness();
    const second = ioTimeout();
    h.findUnique
      .mockRejectedValueOnce(ioTimeout())
      .mockRejectedValueOnce(second);
    await expect(h.repository.findConversation(row().id)).rejects.toBe(second);
    expect(h.findUnique).toHaveBeenCalledTimes(2);
    expect(h.users.findUsersByIds).not.toHaveBeenCalled();
  });

  it.each([
    new Error('I/O error: Operation timed out (os error 110)'),
    new Prisma.PrismaClientUnknownRequestError(
      'I/O error: connection reset (os error 104)',
      { clientVersion: 'test' },
    ),
    new Prisma.PrismaClientUnknownRequestError('Query decoding failed', {
      clientVersion: 'test',
    }),
    new Prisma.PrismaClientKnownRequestError('connection unavailable', {
      code: 'P1001',
      clientVersion: 'test',
    }),
    new ForbiddenException(),
  ])('does not retry unrelated errors (%s)', async (error) => {
    const h = harness();
    h.findUnique.mockRejectedValueOnce(error);
    await expect(h.repository.findConversation(row().id)).rejects.toBe(error);
    expect(h.findUnique).toHaveBeenCalledTimes(1);
  });

  it('does not retry a missing record', async () => {
    const h = harness();
    h.findUnique.mockResolvedValueOnce(null);
    await expect(h.repository.findConversation(row().id)).resolves.toBeNull();
    expect(h.findUnique).toHaveBeenCalledTimes(1);
  });

  it.each(['removed', 'missing'])(
    'keeps authorization fail-closed after recovery: %s',
    async (outcome) => {
      const h = harness();
      h.findUnique
        .mockRejectedValueOnce(ioTimeout())
        .mockResolvedValueOnce(
          outcome === 'missing' ? null : { participantIds: ['bob'] },
        );
      await expect(
        h.repository.assertConversationParticipant(row().id, 'alice'),
      ).rejects.toBeInstanceOf(
        outcome === 'missing' ? NotFoundException : ForbiddenException,
      );
      expect(h.findUnique).toHaveBeenCalledTimes(2);
      expect(h.transaction).not.toHaveBeenCalled();
    },
  );

  it('accepts a fresh membership read after a transient timeout', async () => {
    const h = harness();
    h.findUnique.mockRejectedValueOnce(ioTimeout());
    await expect(
      h.repository.assertConversationParticipant(row().id, 'alice'),
    ).resolves.toBeUndefined();
    expect(h.findUnique).toHaveBeenCalledTimes(2);
  });

  it('never replays an ambiguous write transaction for this read error', async () => {
    const h = harness();
    const error = ioTimeout();
    h.transaction.mockRejectedValue(error);
    await expect(
      h.repository.createMessageIdempotently(
        new Message({
          id: 'm',
          conversationId: row().id,
          senderId: 'alice',
          clientMessageId: 'identity',
          content: 'hello',
          type: 'text',
          createdAt: new Date(),
          readBy: [],
        }),
      ),
    ).rejects.toBe(error);
    expect(h.transaction).toHaveBeenCalledTimes(1);
    expect(h.findUnique).not.toHaveBeenCalled();
  });
});
