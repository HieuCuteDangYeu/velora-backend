import type { StoredCallTelemetryEvent } from '../../domain/models/call-telemetry.model';
import { PrismaCallTelemetryRepository } from './prisma-call-telemetry.repository';

const query = {
  from: '2026-07-10T00:00:00.000Z',
  to: '2026-07-10T23:59:59.999Z',
  platform: 'ios' as const,
  direction: 'outgoing' as const,
};

const event: StoredCallTelemetryEvent = {
  eventId: '11111111-1111-4111-8111-111111111111',
  attemptId: 'attempt-1',
  callId: 'call-1',
  role: 'host',
  eventType: 'setup_stage',
  stage: 'control_plane_active',
  outcome: 'succeeded',
  elapsedMs: 100,
  occurredAt: new Date('2026-07-10T10:00:00.000Z'),
  platform: 'ios',
  appVersion: '1.2.3',
  osVersion: null,
  direction: 'outgoing',
  errorCode: null,
  metricsJson: { jitterMs: 4 },
};

describe('PrismaCallTelemetryRepository', () => {
  const createMany = jest.fn();
  const findMany = jest.fn();
  const groupBy = jest.fn();
  const deleteMany = jest.fn();
  const repository = new PrismaCallTelemetryRepository({
    callTelemetryEvent: { createMany, findMany, groupBy, deleteMany },
  } as never);

  beforeEach(() => {
    jest.resetAllMocks();
  });

  it('persists telemetry idempotently', async () => {
    createMany.mockResolvedValue({ count: 1 });

    await expect(repository.create([event])).resolves.toBe(1);

    expect(createMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: [expect.objectContaining({ eventId: event.eventId })],
        skipDuplicates: true,
      }),
    );
  });

  it('returns a timeline with the existing public projection', async () => {
    findMany.mockResolvedValue([{ ...event, metricsJson: { jitterMs: 4 } }]);

    await expect(repository.findTimeline('call-1')).resolves.toEqual([
      expect.objectContaining({
        eventId: event.eventId,
        metricsJson: { jitterMs: 4 },
      }),
    ]);
    expect(findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { callId: 'call-1' },
        orderBy: { occurredAt: 'asc' },
      }),
    );
  });

  it('groups filtered recent legs and derives the latest failure', async () => {
    const startedAt = new Date('2026-07-10T10:00:00.000Z');
    const lastOccurredAt = new Date('2026-07-10T10:00:05.000Z');
    groupBy.mockResolvedValue([
      {
        callId: 'call-1',
        attemptId: 'attempt-1',
        role: 'host',
        platform: 'ios',
        appVersion: '1.2.3',
        direction: 'outgoing',
        _min: { occurredAt: startedAt },
        _max: { occurredAt: lastOccurredAt },
      },
    ]);
    findMany.mockResolvedValue([
      {
        callId: 'call-1',
        attemptId: 'attempt-1',
        role: 'host',
        platform: 'ios',
        appVersion: '1.2.3',
        direction: 'outgoing',
        stage: 'control_plane_active',
        outcome: 'succeeded',
        errorCode: null,
        occurredAt: startedAt,
      },
      {
        callId: 'call-1',
        attemptId: 'attempt-1',
        role: 'host',
        platform: 'ios',
        appVersion: '1.2.3',
        direction: 'outgoing',
        stage: 'consumer_setup',
        outcome: 'failed',
        errorCode: 'consumer_setup_failed',
        occurredAt: lastOccurredAt,
      },
    ]);

    await expect(repository.findRecentCallLegs(query)).resolves.toEqual([
      {
        callId: 'call-1',
        attemptId: 'attempt-1',
        role: 'host',
        platform: 'ios',
        appVersion: '1.2.3',
        direction: 'outgoing',
        startedAt,
        lastOccurredAt,
        controlPlaneActive: true,
        mediaReady: false,
        failure: {
          stage: 'consumer_setup',
          errorCode: 'consumer_setup_failed',
        },
      },
    ]);
    expect(groupBy).toHaveBeenCalledWith({
      by: [
        'callId',
        'attemptId',
        'role',
        'platform',
        'appVersion',
        'direction',
      ],
      where: {
        occurredAt: {
          gte: new Date(query.from),
          lte: new Date(query.to),
        },
        platform: 'ios',
        direction: 'outgoing',
        callId: { not: null },
      },
      _min: { occurredAt: true },
      _max: { occurredAt: true },
      orderBy: { _max: { occurredAt: 'desc' } },
      take: 50,
    });
  });

  it('deletes events older than the supplied cutoff', async () => {
    deleteMany.mockResolvedValue({ count: 3 });
    const cutoff = new Date('2026-07-01T00:00:00.000Z');

    await expect(repository.deleteReceivedBefore(cutoff)).resolves.toBe(3);
    expect(deleteMany).toHaveBeenCalledWith({
      where: { receivedAt: { lt: cutoff } },
    });
  });
});
