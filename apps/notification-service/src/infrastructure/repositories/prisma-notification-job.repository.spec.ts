import { Prisma } from '@prisma/notification-client';
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
  it('samples unfinished jobs in one indexed-status query through its owned client', async () => {
    const old = new Date('2026-10-09T00:00:00Z');
    const queryRaw = jest.fn().mockResolvedValue([
      {
        status: 'pending',
        count: BigInt(3),
        oldest: new Date('2026-10-09T01:00:00Z'),
      },
      { status: 'processing', count: BigInt(1), oldest: old },
    ]);
    const repository = new PrismaNotificationJobRepository({
      $queryRaw: queryRaw,
    } as never);
    await expect(repository.readBacklog()).resolves.toEqual({
      counts: { pending: 3, failed: 0, processing: 1 },
      oldestCreatedAt: old,
    });
    expect(queryRaw).toHaveBeenCalledTimes(1);
    const [strings, now] = queryRaw.mock.calls[0];
    const sql = (strings as TemplateStringsArray).join('?');
    expect(sql).toContain("status IN ('pending', 'failed', 'processing')");
    expect(sql).toContain('expires_at IS NULL OR expires_at >');
    expect(sql).toContain('GROUP BY status');
    expect(sql).not.toContain('next_attempt_at');
    expect(sql).not.toContain('updated_at');
    expect(now).toBeInstanceOf(Date);
  });

  it('reports zero counts and no oldest job for a successful empty snapshot', async () => {
    const repository = new PrismaNotificationJobRepository({
      $queryRaw: jest.fn().mockResolvedValue([]),
    } as never);
    await expect(repository.readBacklog()).resolves.toEqual({
      counts: { pending: 0, failed: 0, processing: 0 },
      oldestCreatedAt: null,
    });
  });

  it.each([
    { status: 'sent', count: BigInt(1), oldest: new Date() },
    { status: 'pending', count: BigInt(-1), oldest: new Date() },
    {
      status: 'pending',
      count: BigInt('9007199254740992'),
      oldest: new Date(),
    },
    { status: 'pending', count: BigInt(1), oldest: new Date(NaN) },
  ])(
    'rejects malformed snapshot data without returning a false zero',
    async (row) => {
      const repository = new PrismaNotificationJobRepository({
        $queryRaw: jest.fn().mockResolvedValue([row]),
      } as never);
      await expect(repository.readBacklog()).rejects.toThrow(
        'Invalid notification backlog snapshot',
      );
    },
  );

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

  it('returns the claimed snapshot without a second read', async () => {
    const record = {
      id: 'job-1',
      type: 'NEW_MESSAGE',
      status: 'processing',
      attemptCount: 1,
    };
    const findUniqueOrThrow = jest.fn().mockResolvedValue(record);
    const repository = new PrismaNotificationJobRepository({
      $queryRaw: jest.fn().mockResolvedValue([record]),
      notificationJob: { findUniqueOrThrow },
    } as never);
    await expect(repository.claimForProcessing('job-1')).resolves.toEqual(
      expect.objectContaining(record),
    );
    expect(findUniqueOrThrow).not.toHaveBeenCalled();
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
  describe('durable batch intake', () => {
    const input = {
      type: 'NEW_MESSAGE' as const,
      recipientUserId: 'user-1',
      actorUserId: 'actor-1',
      conversationId: 'conversation-1',
      messageId: 'message-1',
      title: "Chat '); DROP TABLE notification_jobs; --",
      body: 'Hello',
      dataJson: { type: 'NEW_MESSAGE', quote: "a'b" },
      idempotencyKey: 'identity-1',
    };

    it('inserts all recipients atomically with parameterized values and never resets a replay', async () => {
      const executeRaw = jest.fn().mockResolvedValue(2);
      const createMany = jest.fn();
      const repository = new PrismaNotificationJobRepository({
        $executeRaw: executeRaw,
        notificationJob: { createMany },
      } as never);
      const before = Date.now();
      await expect(
        repository.enqueueMany([
          input,
          { ...input, recipientUserId: 'user-2', idempotencyKey: 'identity-2' },
        ]),
      ).resolves.toBe(2);
      expect(executeRaw).toHaveBeenCalledTimes(1);
      expect(createMany).not.toHaveBeenCalled();
      const query = executeRaw.mock.calls[0][0] as Prisma.Sql;
      expect(query.text).toContain('INSERT INTO notification_jobs');
      expect(query.text).toContain('ON CONFLICT (idempotency_key) DO NOTHING');
      expect(query.text).not.toMatch(/DO UPDATE|BEGIN|COMMIT/);
      expect(query.text).not.toContain(input.title);
      expect(query.text).not.toContain(input.body);
      expect(query.text).toContain('::jsonb');
      for (const [i, row] of [
        input,
        { ...input, recipientUserId: 'user-2', idempotencyKey: 'identity-2' },
      ].entries()) {
        const values = query.values.slice(i * 14, (i + 1) * 14);
        expect(values[0]).toMatch(/^[0-9a-f-]{36}$/);
        expect(values.slice(1, 12)).toEqual([
          row.type,
          row.recipientUserId,
          row.actorUserId,
          row.conversationId,
          row.messageId,
          null,
          row.title,
          row.body,
          JSON.stringify(row.dataJson),
          null,
          row.idempotencyKey,
        ]);
        expect(values[12]).toBeInstanceOf(Date);
        expect((values[12] as Date).getTime()).toBeGreaterThanOrEqual(before);
        expect(values[13]).toEqual(values[12]);
      }
      expect(query.values[0]).not.toEqual(query.values[14]);
    });

    it('preserves optional fields, call expiry and null identities without inventing JSON data', async () => {
      const executeRaw = jest.fn().mockResolvedValue(1);
      const repository = new PrismaNotificationJobRepository({
        $executeRaw: executeRaw,
      } as never);
      const expiresAt = new Date('2030-01-01T00:00:00Z');
      await repository.enqueueMany([
        {
          type: 'INCOMING_CALL',
          recipientUserId: 'callee',
          callId: 'call-1',
          title: 'Call',
          body: '',
          expiresAt,
        },
      ]);
      const query = executeRaw.mock.calls[0][0] as Prisma.Sql;
      expect(query.values.slice(1, 12)).toEqual([
        'INCOMING_CALL',
        'callee',
        null,
        null,
        null,
        'call-1',
        'Call',
        '',
        null,
        expiresAt,
        null,
      ]);
    });

    it('returns zero for a replay and propagates ambiguous intake failures to the outbox', async () => {
      const executeRaw = jest
        .fn()
        .mockResolvedValueOnce(0)
        .mockRejectedValueOnce(new Error('connection lost'));
      const repository = new PrismaNotificationJobRepository({
        $executeRaw: executeRaw,
      } as never);
      await expect(repository.enqueueMany([input])).resolves.toBe(0);
      await expect(repository.enqueueMany([input])).rejects.toThrow(
        'connection lost',
      );
    });

    it('does not touch the database for an empty batch', async () => {
      const executeRaw = jest.fn();
      const repository = new PrismaNotificationJobRepository({
        $executeRaw: executeRaw,
      } as never);
      await expect(repository.enqueueMany([])).resolves.toBe(0);
      expect(executeRaw).not.toHaveBeenCalled();
    });

    it('keeps transactional Prisma chunking for oversized recipient batches', async () => {
      const executeRaw = jest.fn();
      const createMany = jest.fn().mockResolvedValue({ count: 1_001 });
      const repository = new PrismaNotificationJobRepository({
        $executeRaw: executeRaw,
        notificationJob: { createMany },
      } as never);
      const inputs = Array.from({ length: 1_001 }, (_, i) => ({
        ...input,
        idempotencyKey: `identity-${i}`,
      }));
      await expect(repository.enqueueMany(inputs)).resolves.toBe(1_001);
      expect(executeRaw).not.toHaveBeenCalled();
      expect(createMany).toHaveBeenCalledWith({
        data: inputs.map((row) => ({ ...row, status: 'pending' })),
        skipDuplicates: true,
      });
    });
  });
});
