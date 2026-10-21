import { InvalidCallHistoryCursorError } from '../../../src/domain/interfaces/call-history.repository.interface';
import { CallHistoryController } from '../../../src/infrastructure/controllers/call-history.controller';
import {
  decodeCursor,
  encodeCursor,
  PrismaCallHistoryRepository,
} from '../../../src/infrastructure/repositories/prisma-call-history.repository';

const startedAt = new Date('2026-10-22T10:00:00.000Z');

const record = {
  callId: 'call-1',
  conversationId: 'conversation-1',
  isGroupCall: false,
  callType: 'VOICE' as const,
  initiatorId: 'caller',
  outcome: 'MISSED' as const,
  terminalReason: 'no_answer',
  startedAt,
  endedAt: new Date('2026-10-22T10:00:30.000Z'),
  lifecycleRevision: 5,
  participants: [
    { userId: 'caller', role: 'CALLER' as const, result: 'CANCELLED' as const },
    { userId: 'callee', role: 'CALLEE' as const, result: 'MISSED' as const },
  ],
};

const createPrisma = (enabled = true) => {
  const tx = {
    callRecord: {
      findUnique: jest.fn().mockResolvedValue(null),
      upsert: jest.fn().mockResolvedValue(undefined),
    },
    callRecordParticipant: { upsert: jest.fn().mockResolvedValue(undefined) },
  };
  return {
    enabled,
    tx,
    $transaction: jest.fn((run: (client: typeof tx) => Promise<void>) =>
      run(tx),
    ),
    callRecordParticipant: {
      findMany: jest.fn(),
      count: jest.fn().mockResolvedValue(2),
      updateMany: jest.fn().mockResolvedValue({ count: 2 }),
    },
  };
};

describe('PrismaCallHistoryRepository', () => {
  it('writes the record and one row per participant', async () => {
    const prisma = createPrisma();
    const repository = new PrismaCallHistoryRepository(prisma as never);

    await repository.record(record);

    expect(prisma.tx.callRecord.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { callId: 'call-1' },
        create: expect.objectContaining({
          callId: 'call-1',
          outcome: 'MISSED',
        }),
      }),
    );
    expect(prisma.tx.callRecordParticipant.upsert).toHaveBeenCalledTimes(2);
    expect(prisma.tx.callRecordParticipant.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { callId_userId: { callId: 'call-1', userId: 'callee' } },
        // seenAt is never written by a replay.
        update: { role: 'CALLEE', result: 'MISSED', startedAt },
      }),
    );
  });

  it('ignores a replay that is not newer than the stored record', async () => {
    const prisma = createPrisma();
    prisma.tx.callRecord.findUnique.mockResolvedValue({ lifecycleRevision: 5 });
    const repository = new PrismaCallHistoryRepository(prisma as never);

    await repository.record(record);

    expect(prisma.tx.callRecord.upsert).not.toHaveBeenCalled();
  });

  it('does nothing without a configured database', async () => {
    const prisma = createPrisma(false);
    const repository = new PrismaCallHistoryRepository(prisma as never);

    await repository.record(record);
    await expect(
      repository.listForUser('callee', { limit: 10 }),
    ).resolves.toEqual({
      items: [],
      nextCursor: null,
    });
    await expect(repository.countUnseenMissed('callee')).resolves.toBe(0);
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it('pages newest first and maps the call from the user point of view', async () => {
    const prisma = createPrisma();
    const row = (callId: string, at: Date) => ({
      callId,
      userId: 'callee',
      role: 'CALLEE',
      result: 'MISSED',
      startedAt: at,
      seenAt: null,
      record: {
        ...record,
        callId,
        startedAt: at,
        groupName: null,
        groupAvatarUrl: null,
        answeredAt: null,
        durationSec: null,
        createdAt: at,
        participants: [
          { callId, userId: 'callee', role: 'CALLEE', result: 'MISSED' },
          { callId, userId: 'caller', role: 'CALLER', result: 'CANCELLED' },
        ],
      },
    });
    const second = new Date('2026-10-22T09:00:00.000Z');
    prisma.callRecordParticipant.findMany.mockResolvedValue([
      row('call-1', startedAt),
      row('call-0', second),
    ]);
    const repository = new PrismaCallHistoryRepository(prisma as never);

    const page = await repository.listForUser('callee', { limit: 1 });

    expect(prisma.callRecordParticipant.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { userId: 'callee' },
        orderBy: [{ startedAt: 'desc' }, { callId: 'desc' }],
        take: 2,
      }),
    );
    expect(page.items).toEqual([
      {
        callId: 'call-1',
        conversationId: 'conversation-1',
        callType: 'VOICE',
        isGroupCall: false,
        initiatorId: 'caller',
        outcome: 'MISSED',
        terminalReason: 'no_answer',
        role: 'CALLEE',
        result: 'MISSED',
        startedAt: '2026-10-22T10:00:00.000Z',
        endedAt: '2026-10-22T10:00:30.000Z',
        peerUserIds: ['caller'],
      },
    ]);
    expect(decodeCursor(page.nextCursor!)).toEqual({
      startedAt,
      callId: 'call-1',
    });
  });

  it('continues after the cursor', async () => {
    const prisma = createPrisma();
    prisma.callRecordParticipant.findMany.mockResolvedValue([]);
    const repository = new PrismaCallHistoryRepository(prisma as never);

    await repository.listForUser('callee', {
      cursor: encodeCursor(startedAt, 'call-1'),
      limit: 30,
    });

    expect(
      prisma.callRecordParticipant.findMany.mock.calls[0][0].where,
    ).toEqual({
      userId: 'callee',
      OR: [
        { startedAt: { lt: startedAt } },
        { startedAt, callId: { lt: 'call-1' } },
      ],
    });
  });

  it('rejects a malformed cursor', () => {
    expect(() => decodeCursor('not-a-cursor')).toThrow(
      InvalidCallHistoryCursorError,
    );
  });

  it('counts and clears only unseen missed calls', async () => {
    const prisma = createPrisma();
    const repository = new PrismaCallHistoryRepository(prisma as never);
    const seenAt = new Date();

    await expect(repository.countUnseenMissed('callee')).resolves.toBe(2);
    await expect(repository.markMissedSeen('callee', seenAt)).resolves.toBe(2);

    const where = { userId: 'callee', result: 'MISSED', seenAt: null };
    expect(prisma.callRecordParticipant.count).toHaveBeenCalledWith({ where });
    expect(prisma.callRecordParticipant.updateMany).toHaveBeenCalledWith({
      where,
      data: { seenAt },
    });
  });
});

describe('CallHistoryController', () => {
  it('answers an invalid cursor without throwing over RPC', async () => {
    const controller = new CallHistoryController({
      listForUser: jest
        .fn()
        .mockRejectedValue(new InvalidCallHistoryCursorError()),
    } as never);

    await expect(
      controller.getHistory({ userId: 'callee', cursor: 'bad' }),
    ).resolves.toEqual({ error: 'invalid_cursor' });
  });

  it('never reads history without a user id', async () => {
    const listForUser = jest.fn();
    const controller = new CallHistoryController({ listForUser } as never);

    await expect(controller.getHistory({})).resolves.toEqual({
      items: [],
      nextCursor: null,
    });
    expect(listForUser).not.toHaveBeenCalled();
  });
});
