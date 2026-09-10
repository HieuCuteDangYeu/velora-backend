import { PrismaNotificationJobRepository } from './prisma-notification-job.repository';

type QueryCondition = {
  status?: string;
  nextAttemptAt?: { lte: Date };
  updatedAt?: { lte: Date };
  expiresAt?: { gt: Date } | null;
};

type UpdateManyInput = {
  where: { id: string; OR: QueryCondition[] };
  data: Record<string, unknown>;
};

type FindManyInput = {
  where: { AND: Array<{ OR: QueryCondition[] }> };
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

  it('atomically claims only jobs that are eligible for delivery', async () => {
    const updateMany = jest.fn().mockResolvedValue({ count: 0 });
    const findUniqueOrThrow = jest.fn();
    const repository = new PrismaNotificationJobRepository({
      notificationJob: { updateMany, findUniqueOrThrow },
    } as never);
    const before = Date.now();

    await expect(repository.claimForProcessing('job-1')).resolves.toBeNull();

    expect(findUniqueOrThrow).not.toHaveBeenCalled();
    expect(updateMany).toHaveBeenCalledTimes(1);
    const input = updateMany.mock.calls[0]?.[0] as UpdateManyInput;
    const eligibleStates = input.where.OR;
    const staleProcessing = eligibleStates.find(
      (condition: { status?: string }) => condition.status === 'processing',
    );

    expect(eligibleStates).toEqual(
      expect.arrayContaining([
        { status: 'pending' },
        expect.objectContaining({ status: 'failed' }),
      ]),
    );
    expect(staleProcessing.updatedAt.lte).toBeInstanceOf(Date);
    expect(staleProcessing.updatedAt.lte.getTime()).toBeGreaterThanOrEqual(
      before - 300_100,
    );
    expect(input.data).toEqual(
      expect.objectContaining({
        status: 'processing',
        attemptCount: { increment: 1 },
        updatedAt: expect.any(Date),
      }),
    );
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
});
