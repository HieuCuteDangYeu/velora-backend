import { RpcException } from '@nestjs/microservices';
import { CallTelemetryController } from './call-telemetry.controller';

const event = {
  eventId: '11111111-1111-4111-8111-111111111111',
  attemptId: '22222222-2222-4222-8222-222222222222',
  eventType: 'setup_stage' as const,
  stage: 'control_plane_active',
  elapsedMs: 100,
  occurredAt: '2026-07-10T10:00:00.000Z',
  platform: 'ios' as const,
  appVersion: '1.2.3',
};

const query = {
  from: '2026-07-10T00:00:00.000Z',
  to: '2026-07-10T23:59:59.999Z',
  platform: 'ios',
};

const expectRpc400 = async (operation: Promise<unknown>) => {
  try {
    await operation;
    throw new Error('Expected an RPC exception');
  } catch (error) {
    expect(error).toBeInstanceOf(RpcException);
    expect((error as RpcException).getError()).toMatchObject({
      statusCode: 400,
    });
  }
};

describe('CallTelemetryController', () => {
  const ingestTelemetry = { execute: jest.fn() };
  const getSummary = { execute: jest.fn() };
  const getTimeline = { execute: jest.fn() };
  const listRecentLegs = { execute: jest.fn() };
  const metrics = {
    addTelemetryEvents: jest.fn(),
    recordRpc: jest.fn(),
  };
  const controller = new CallTelemetryController(
    ingestTelemetry as never,
    getSummary as never,
    getTimeline as never,
    listRecentLegs as never,
    metrics as never,
  );

  beforeEach(() => {
    jest.resetAllMocks();
  });

  it('validates and delegates all four telemetry message patterns', async () => {
    ingestTelemetry.execute.mockResolvedValue({ accepted: 1, rejected: 0 });
    getSummary.execute.mockResolvedValue({ attempts: 1 });
    getTimeline.execute.mockResolvedValue([]);
    listRecentLegs.execute.mockResolvedValue([]);

    await expect(controller.ingest({ events: [event] })).resolves.toEqual({
      accepted: 1,
      rejected: 0,
    });
    await expect(controller.summary(query)).resolves.toEqual({ attempts: 1 });
    await expect(
      controller.timeline({ callId: event.eventId }),
    ).resolves.toEqual([]);
    await expect(controller.recent(query)).resolves.toEqual([]);

    expect(ingestTelemetry.execute).toHaveBeenCalledWith([event]);
    expect(getSummary.execute).toHaveBeenCalledWith(query);
    expect(getTimeline.execute).toHaveBeenCalledWith(event.eventId);
    expect(listRecentLegs.execute).toHaveBeenCalledWith(query);
  });

  it.each([
    [{ ...query, from: 'not-a-date' }],
    [{ ...query, from: query.to, to: query.from }],
    [{ ...query, platform: 'desktop' }],
  ])('rejects invalid telemetry queries with RPC 400', async (payload) => {
    await expectRpc400(controller.summary(payload));
  });

  it('rejects a non-UUID call identifier with RPC 400', async () => {
    await expectRpc400(controller.timeline({ callId: 'call-1' }));
  });

  it('returns a successful partial-ingest result for a quarantined token', async () => {
    ingestTelemetry.execute.mockResolvedValue({ accepted: 0, rejected: 1 });

    await expect(controller.ingest({ events: [event] })).resolves.toEqual({
      accepted: 0,
      rejected: 1,
    });
  });
});
