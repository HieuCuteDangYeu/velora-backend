import { Message } from '../../domain/entities/message.entity';
import {
  DuplicateClientMessageError,
  MessageWriteConflictError,
} from './native-message-writer';
import { WriteRouterUnavailableError } from './conversation-write-router';
import { PrismaChatRepository } from './prisma-chat.repository';

const CONVERSATION_ID = '6af774b69b6c568d77df5413';

const stored = (over: Record<string, unknown> = {}) => ({
  id: '6afd4932debb2ed2c205d92b',
  type: 'text',
  clientMessageId: 'client-1',
  content: 'cipher',
  media: null,
  metadata: null,
  senderId: 'alice',
  isRecalled: false,
  recalledAt: null,
  replyToId: null,
  replyPreview: null,
  conversationId: CONVERSATION_ID,
  reactions: null,
  readBy: [],
  notificationClaimId: null,
  notificationAttemptCount: 0,
  createdAt: new Date(1),
  notificationRecipientIds: [],
  notificationNextAttemptAt: null,
  ...over,
});
const conversation = { id: CONVERSATION_ID, participantIds: ['alice', 'bob'] };

function makeRepository(nativeWriter: { write: jest.Mock } | null) {
  const prisma = {
    $transaction: jest.fn(),
    message: { findFirst: jest.fn() },
  };
  const redis = {
    set: jest.fn(() => Promise.resolve('OK')),
    eval: jest.fn(() => Promise.resolve(1)),
    del: jest.fn(() => Promise.resolve(1)),
  };
  const repository = new PrismaChatRepository(
    prisma as never,
    redis as never,
    {
      encrypt: (value: string) => `enc:${value}`,
      decrypt: (v: string) => v,
    },
    {} as never,
    {} as never,
    undefined,
    undefined,
    nativeWriter as never,
  );
  return { repository, prisma, redis };
}

const newMessage = () =>
  new Message({
    conversationId: CONVERSATION_ID,
    senderId: 'alice',
    content: 'hello',
    type: 'text',
    clientMessageId: 'client-1',
    createdAt: new Date(),
  });

describe('PrismaChatRepository native message writer', () => {
  beforeEach(() => jest.spyOn(Math, 'random').mockReturnValue(0));
  afterEach(() => jest.restoreAllMocks());

  it('writes through the native writer and never opens a Prisma transaction', async () => {
    const write = jest.fn().mockResolvedValue([[stored(), conversation]]);
    const { repository, prisma } = makeRepository({ write });

    const result = await repository.createMessageIdempotently(newMessage());

    expect(write).toHaveBeenCalledTimes(1);
    expect(prisma.$transaction).not.toHaveBeenCalled();
    expect(result.created).toBe(true);
    expect(result.message.content).toBe('hello');
  });

  it('retries a write conflict and then succeeds', async () => {
    const write = jest
      .fn()
      .mockRejectedValueOnce(new MessageWriteConflictError())
      .mockRejectedValueOnce(new MessageWriteConflictError())
      .mockResolvedValue([[stored(), conversation]]);
    const { repository } = makeRepository({ write });

    const result = await repository.createMessageIdempotently(newMessage());

    expect(write).toHaveBeenCalledTimes(3);
    expect(result.created).toBe(true);
  });

  it('gives up after the same number of attempts as the Prisma path', async () => {
    const write = jest.fn().mockRejectedValue(new MessageWriteConflictError());
    const { repository } = makeRepository({ write });

    await expect(
      repository.createMessageIdempotently(newMessage()),
    ).rejects.toBeInstanceOf(MessageWriteConflictError);
    expect(write).toHaveBeenCalledTimes(6);
  });

  it('does not retry any other failure', async () => {
    const write = jest.fn().mockRejectedValue(new Error('commit unknown'));
    const { repository } = makeRepository({ write });

    await expect(
      repository.createMessageIdempotently(newMessage()),
    ).rejects.toThrow('commit unknown');
    expect(write).toHaveBeenCalledTimes(1);
  });

  it('answers a duplicate client key with the stored message, created=false', async () => {
    const write = jest
      .fn()
      .mockRejectedValue(new DuplicateClientMessageError());
    const { repository, prisma } = makeRepository({ write });
    prisma.message.findFirst.mockResolvedValue(
      stored({ content: 'enc:hello', id: '6afd4932debb2ed2c205d92f' }),
    );

    const result = await repository.createMessageIdempotently(newMessage());

    expect(result.created).toBe(false);
    expect(result.message.id).toBe('6afd4932debb2ed2c205d92f');
    expect(prisma.message.findFirst).toHaveBeenCalledWith({
      where: {
        conversationId: CONVERSATION_ID,
        senderId: 'alice',
        clientMessageId: 'client-1',
      },
    });
  });

  it('keeps using Prisma when no native writer is configured', async () => {
    const { repository, prisma } = makeRepository(null);
    prisma.$transaction.mockResolvedValue([[stored(), conversation]]);

    const result = await repository.createMessageIdempotently(newMessage());

    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
    expect(result.created).toBe(true);
  });

  describe('single writer per conversation', () => {
    const withRouter = (
      router: { selfId: string; ownerOf: jest.Mock; forward: jest.Mock },
      write: jest.Mock,
    ) => {
      const made = makeRepository({ write });
      (made.repository as unknown as { writeRouter: unknown }).writeRouter =
        router;
      return made;
    };

    it('hands the write to the owner replica and does not write locally', async () => {
      const write = jest.fn();
      const forward = jest.fn().mockResolvedValue([[stored(), conversation]]);
      const router = {
        selfId: 'r1',
        ownerOf: jest.fn(() => 'r2'),
        forward,
      };
      const { repository, redis } = withRouter(router, write);

      const result = await repository.createMessageIdempotently(newMessage());

      expect(forward).toHaveBeenCalledWith('r2', [
        expect.objectContaining({ preview: 'hello' }),
      ]);
      expect(write).not.toHaveBeenCalled();
      expect(redis.set).not.toHaveBeenCalled();
      expect(result.created).toBe(true);
    });

    it('writes locally when this replica owns the conversation', async () => {
      const write = jest.fn().mockResolvedValue([[stored(), conversation]]);
      const forward = jest.fn();
      const router = {
        selfId: 'r1',
        ownerOf: jest.fn(() => 'r1'),
        forward,
      };
      const { repository } = withRouter(router, write);

      await repository.createMessageIdempotently(newMessage());

      expect(forward).not.toHaveBeenCalled();
      expect(write).toHaveBeenCalledTimes(1);
    });

    it('writes locally when the owner cannot be reached', async () => {
      const write = jest.fn().mockResolvedValue([[stored(), conversation]]);
      const forward = jest
        .fn()
        .mockRejectedValue(new WriteRouterUnavailableError('gone'));
      const router = {
        selfId: 'r1',
        ownerOf: jest.fn(() => 'r2'),
        forward,
      };
      const { repository } = withRouter(router, write);

      const result = await repository.createMessageIdempotently(newMessage());

      expect(forward).toHaveBeenCalledTimes(1);
      expect(write).toHaveBeenCalledTimes(1);
      expect(result.created).toBe(true);
    });

    it('passes the owner’s refusal on to the sender', async () => {
      const write = jest.fn();
      const forward = jest
        .fn()
        .mockRejectedValue(new MessageWriteConflictError());
      const router = {
        selfId: 'r1',
        ownerOf: jest.fn(() => 'r2'),
        forward,
      };
      const { repository } = withRouter(router, write);

      await expect(
        repository.createMessageIdempotently(newMessage()),
      ).rejects.toBeInstanceOf(MessageWriteConflictError);
      expect(write).not.toHaveBeenCalled();
    });
  });
});
