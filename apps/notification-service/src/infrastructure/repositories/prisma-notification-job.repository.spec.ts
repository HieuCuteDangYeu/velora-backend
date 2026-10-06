import { PrismaNotificationJobRepository } from './prisma-notification-job.repository';

type QueryCondition = {
  status?: string;
  nextAttemptAt?: { lte: Date };
  updatedAt?: { lte: Date };
  expiresAt?: { gt: Date } | null;
};

type FindManyInput = {
  where: { AND: Array<{ OR: QueryCondition[] }> };
  orderBy: Array<
    { expiresAt: { sort: 'asc'; nulls: 'last' } } | { createdAt: 'asc' }
  >;
};

describe('PrismaNotificationJobRepository', () => {
  it('reuses one durable lifecycle job for a redelivered event', async () => {
    const create = jest.fn();
    const upsert = jest.fn().mockResolvedValue({
      id: 'job-1',
      type: 'CALL_STATE_UPDATE',
      recipientUserId: 'user-1',
      actorUserId: null,
      conversationId: 'conversation-1',
      messageId: null,
      callId: 'call-1',
      title: 'Call update',
      body: '',
      dataJson: null,
      expiresAt: null,
      status: 'processing',
      attemptCount: 1,
      nextAttemptAt: null,
    });
    const repository = new PrismaNotificationJobRepository({
      notificationJob: { create, upsert },
    } as never);

    await repository.create({
      type: 'CALL_STATE_UPDATE',
      recipientUserId: 'user-1',
      callId: 'call-1',
      title: 'Call update',
      body: '',
      idempotencyKey: 'call-state:call-1:user-1:revision:4',
    });

    expect(create).not.toHaveBeenCalled();
    expect(upsert).toHaveBeenCalledWith({
      where: { idempotencyKey: 'call-state:call-1:user-1:revision:4' },
      create: expect.objectContaining({
        idempotencyKey: 'call-state:call-1:user-1:revision:4',
        status: 'pending',
      }),
      update: {},
    });
  });

  it('atomically claims pending, due failed and stale processing jobs in one SQL operation', async () => {
    const queryRaw = jest.fn().mockResolvedValue([]);
    const findUniqueOrThrow = jest.fn();
    const repository = new PrismaNotificationJobRepository({
      $queryRaw: queryRaw,
      notificationJob: { findUniqueOrThrow },
    } as never);
    const before = Date.now();
    await expect(repository.claimForProcessing('job-1')).resolves.toBeNull();
    expect(findUniqueOrThrow).not.toHaveBeenCalled();
    const [strings, now, id, dueAt, leaseExpiry] = queryRaw.mock.calls[0] as [
      TemplateStringsArray,
      Date,
      string,
      Date,
      Date,
    ];
    const sql = strings.join('?');
    expect(sql).toContain('attempt_count = attempt_count + 1');
    expect(sql).toContain("status = 'pending'");
    expect(sql).toContain("status = 'failed' AND next_attempt_at <=");
    expect(sql).toContain("status = 'processing' AND updated_at <=");
    expect(sql).toContain('RETURNING id, type');
    expect(id).toBe('job-1');
    expect(now).toEqual(dueAt);
    expect(leaseExpiry.getTime()).toBeGreaterThanOrEqual(before - 300_100);
    expect(leaseExpiry.getTime()).toBeLessThanOrEqual(Date.now() - 299_900);
  });

  it('returns the claimed job and batches durable message identities without resetting replays', async () => {
    const record = {
      id: 'job-1',
      type: 'NEW_MESSAGE',
      status: 'processing',
      attemptCount: 1,
    };
    const createMany = jest.fn().mockResolvedValue({ count: 1 });
    const findUniqueOrThrow = jest.fn().mockResolvedValue(record);
    const repository = new PrismaNotificationJobRepository({
      $queryRaw: jest.fn().mockResolvedValue([record]),
      notificationJob: { createMany, findUniqueOrThrow },
    } as never);
    await expect(repository.claimForProcessing('job-1')).resolves.toEqual(
      expect.objectContaining(record),
    );
    expect(findUniqueOrThrow).not.toHaveBeenCalled();
    const input = {
      type: 'NEW_MESSAGE' as const,
      recipientUserId: 'user',
      title: 'Chat',
      body: 'Hello',
      idempotencyKey: 'identity',
    };
    await expect(repository.enqueueMany([input])).resolves.toBe(1);
    expect(createMany).toHaveBeenCalledWith({
      data: [expect.objectContaining({ ...input, status: 'pending' })],
      skipDuplicates: true,
    });
    createMany.mockClear();
    await expect(repository.enqueueMany([])).resolves.toBe(0);
    expect(createMany).not.toHaveBeenCalled();
  });

  it('reclaims only notification jobs whose processing lease has expired', async () => {
    const findMany = jest.fn().mockResolvedValue([]);
    const repository = new PrismaNotificationJobRepository({
      notificationJob: { findMany },
    } as never);
    const before = Date.now();

    await repository.findRetryable(20);

    const where = (findMany.mock.calls[0]?.[0] as FindManyInput).where;
    const reclaimCondition = where.AND[0].OR.find(
      (condition: { status?: string }) => condition.status === 'processing',
    );
    const leaseExpiry = reclaimCondition.updatedAt.lte;

    expect(leaseExpiry).toBeInstanceOf(Date);
    expect(leaseExpiry.getTime()).toBeGreaterThanOrEqual(before - 300_100);
    expect(leaseExpiry.getTime()).toBeLessThanOrEqual(Date.now() - 299_900);
  });

  it('prioritizes expiring notification jobs before durable non-expiring jobs', async () => {
    const findMany = jest.fn().mockResolvedValue([]);
    const repository = new PrismaNotificationJobRepository({
      notificationJob: { findMany },
    } as never);

    await repository.findRetryable(20);

    const input = findMany.mock.calls[0]?.[0] as FindManyInput;
    expect(input.orderBy).toEqual([
      { expiresAt: { sort: 'asc', nulls: 'last' } },
      { createdAt: 'asc' },
    ]);
  });
});
