import { createHash } from 'crypto';
import { ReelCommentRepository } from './reel-comment.repository';

describe('ReelCommentRepository', () => {
  const input = {
    reelId: 'r',
    authorId: 'a',
    parentId: null,
    clientRequestId: 'key',
    text: 'hello',
  };
  const fingerprint = createHash('sha256')
    .update(JSON.stringify(['r', null, 'hello']))
    .digest('hex');
  const tx = {
    reelComment: {
      create: jest.fn(),
      findUnique: jest.fn(),
      findFirst: jest.fn(),
      update: jest.fn(),
      updateMany: jest.fn(),
    },
    reel: { update: jest.fn() },
    $queryRaw: jest.fn(),
  };
  const prisma = {
    reelComment: { findUnique: jest.fn(), findMany: jest.fn() },
    $transaction: jest.fn((fn) => fn(tx)),
  };
  const repo = new ReelCommentRepository(prisma as any);
  beforeEach(() => jest.clearAllMocks());
  it('returns matching retries and rejects a changed payload', async () => {
    prisma.reelComment.findUnique
      .mockResolvedValueOnce({ id: 'c', fingerprint })
      .mockResolvedValueOnce({ id: 'c', fingerprint });
    await expect(repo.create(input)).resolves.toMatchObject({ id: 'c' });
    await expect(
      repo.create({ ...input, text: 'changed' }),
    ).rejects.toMatchObject({ statusCode: 409 });
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });
  it('creates replies and increments both counters inside the transaction', async () => {
    prisma.reelComment.findUnique.mockResolvedValue(null);
    tx.reelComment.findFirst.mockResolvedValue({ id: 'parent' });
    tx.reelComment.create.mockResolvedValue({ id: 'reply' });
    await repo.create({ ...input, parentId: 'parent' });
    expect(tx.$queryRaw).toHaveBeenCalled();
    expect(tx.reel.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: { commentCount: { increment: 1 } } }),
    );
    expect(tx.reelComment.update).toHaveBeenCalledWith({
      where: { id: 'parent' },
      data: { replyCount: { increment: 1 } },
    });
  });
  it('decrements counters once for a conditional deletion', async () => {
    tx.reelComment.findFirst.mockResolvedValue({
      id: 'reply',
      reelId: 'r',
      authorId: 'a',
      parentId: 'parent',
    });
    tx.reelComment.updateMany
      .mockResolvedValueOnce({ count: 1 })
      .mockResolvedValueOnce({ count: 0 });
    const args = { id: 'reply', reelId: 'r', actorId: 'a', ownerId: 'owner' };
    await repo.delete(args);
    await repo.delete(args);
    expect(tx.reel.update).toHaveBeenCalledTimes(1);
    expect(tx.reelComment.update).toHaveBeenCalledTimes(1);
  });
  it('paginates by timestamp and id with a bounded extra row', async () => {
    const createdAt = new Date('2026-01-01T00:00:00.000Z');
    prisma.reelComment.findMany.mockResolvedValue([
      { id: 'b', createdAt },
      { id: 'a', createdAt },
    ]);
    const result = await repo.list({ reelId: 'r', parentId: null, limit: 1 });
    expect(result.nextCursor).toBe('2026-01-01T00:00:00.000Z|b');
    expect(prisma.reelComment.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        take: 2,
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      }),
    );
  });
});
