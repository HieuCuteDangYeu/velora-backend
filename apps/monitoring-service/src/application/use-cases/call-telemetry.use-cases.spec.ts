import type { CallTelemetryEventPayload } from '@common/calls/dtos/call-telemetry.dto';
import type {
  CallTelemetryTimelineEvent,
  RecentCallLeg,
  StoredCallTelemetryEvent,
  TelemetryQuery,
} from '../../domain/models/call-telemetry.model';
import { GetCallTelemetrySummaryUseCase } from './get-call-telemetry-summary.use-case';
import { GetCallTimelineUseCase } from './get-call-timeline.use-case';
import { IngestCallTelemetryUseCase } from './ingest-call-telemetry.use-case';
import { ListRecentCallLegsUseCase } from './list-recent-call-legs.use-case';
import { PurgeExpiredCallTelemetryUseCase } from './purge-expired-call-telemetry.use-case';

const query: TelemetryQuery = {
  from: '2026-07-10T00:00:00.000Z',
  to: '2026-07-10T23:59:59.999Z',
  platform: 'ios',
};

const payload: CallTelemetryEventPayload = {
  eventId: '11111111-1111-4111-8111-111111111111',
  attemptId: '22222222-2222-4222-8222-222222222222',
  telemetryToken: 'valid-telemetry-token',
  eventType: 'setup_stage',
  stage: 'control_plane_active',
  outcome: 'succeeded',
  elapsedMs: 100.7,
  occurredAt: '2026-07-10T10:00:00.000Z',
  platform: 'ios',
  appVersion: '1.2.3',
  direction: 'incoming',
  metrics: { jitterMs: 4 },
};

const event = (
  overrides: Partial<StoredCallTelemetryEvent> = {},
): StoredCallTelemetryEvent => ({
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
  metricsJson: null,
  ...overrides,
});

describe('Call telemetry use cases', () => {
  it('ingests verified events using token-derived call context', async () => {
    const repository = { create: jest.fn().mockResolvedValue(1) };
    const tokenVerifier = {
      verify: jest.fn().mockReturnValue({ callId: 'call-1', role: 'host' }),
    };
    const useCase = new IngestCallTelemetryUseCase(
      repository as never,
      tokenVerifier,
    );

    await expect(useCase.execute([payload])).resolves.toEqual({
      accepted: 1,
      rejected: 0,
    });
    expect(repository.create).toHaveBeenCalledWith([
      expect.objectContaining({
        callId: 'call-1',
        role: 'host',
        direction: 'outgoing',
        elapsedMs: 101,
        metricsJson: { jitterMs: 4 },
      }),
    ]);
  });

  it('preserves unverified telemetry when a token is omitted', async () => {
    const repository = { create: jest.fn().mockResolvedValue(1) };
    const tokenVerifier = { verify: jest.fn() };
    const useCase = new IngestCallTelemetryUseCase(
      repository as never,
      tokenVerifier,
    );
    const unverifiedPayload = { ...payload, telemetryToken: undefined };

    await useCase.execute([unverifiedPayload]);

    expect(tokenVerifier.verify).not.toHaveBeenCalled();
    expect(repository.create).toHaveBeenCalledWith([
      expect.objectContaining({
        callId: null,
        role: null,
        direction: 'incoming',
      }),
    ]);
  });

  it('quarantines an invalid token without blocking valid telemetry in the same batch', async () => {
    const repository = { create: jest.fn().mockResolvedValue(1) };
    const tokenVerifier = {
      verify: jest
        .fn()
        .mockReturnValueOnce(null)
        .mockReturnValueOnce({ callId: 'call-1', role: 'host' }),
    };
    const useCase = new IngestCallTelemetryUseCase(
      repository as never,
      tokenVerifier,
    );

    await expect(
      useCase.execute([
        { ...payload, telemetryToken: 'invalid-token' },
        payload,
      ]),
    ).resolves.toEqual({ accepted: 1, rejected: 1 });
    expect(repository.create).toHaveBeenCalledWith([
      expect.objectContaining({ callId: 'call-1', role: 'host' }),
    ]);
  });

  it('counts successful attempts once when duplicate success events exist', async () => {
    const repository = {
      findEvents: jest.fn().mockResolvedValue([
        event(),
        event({
          eventId: '33333333-3333-4333-8333-333333333333',
          elapsedMs: 120,
        }),
        event({
          eventId: '44444444-4444-4444-8444-444444444444',
          attemptId: 'attempt-2',
          eventType: 'quality_sample',
          stage: 'audio_quality',
          outcome: null,
          metricsJson: { jitterMs: 20, packetLossRate: 0.06 },
        }),
      ]),
    };
    const useCase = new GetCallTelemetrySummaryUseCase(repository as never);

    const result = await useCase.execute(query);

    expect(repository.findEvents).toHaveBeenCalledWith(query);
    expect(result.attempts).toBe(2);
    expect(result.controlPlaneSuccessRate).toBe(0.5);
    expect(result.mediaReadySuccessRate).toBe(0);
    expect(result.quality).toMatchObject({
      samples: 1,
      jitterMs: 20,
      packetLossRate: 0.06,
      badSampleRate: 1,
    });
  });

  it('returns null rates when there are no attempts', async () => {
    const repository = { findEvents: jest.fn().mockResolvedValue([]) };
    const useCase = new GetCallTelemetrySummaryUseCase(repository as never);

    await expect(useCase.execute(query)).resolves.toMatchObject({
      attempts: 0,
      controlPlaneSuccessRate: null,
      mediaReadySuccessRate: null,
      quality: { badSampleRate: null },
    });
  });

  it('delegates timeline and recent-leg queries to the repository', async () => {
    const timeline: CallTelemetryTimelineEvent[] = [
      {
        ...event(),
        callId: undefined,
      },
    ];
    const recent: RecentCallLeg[] = [
      {
        callId: 'call-1',
        attemptId: 'attempt-1',
        role: 'host',
        platform: 'ios',
        appVersion: '1.2.3',
        direction: 'outgoing',
        startedAt: new Date('2026-07-10T10:00:00.000Z'),
        lastOccurredAt: new Date('2026-07-10T10:00:05.000Z'),
        controlPlaneActive: true,
        mediaReady: false,
        failure: null,
      },
    ];
    const repository = {
      findTimeline: jest.fn().mockResolvedValue(timeline),
      findRecentCallLegs: jest.fn().mockResolvedValue(recent),
    };

    await expect(
      new GetCallTimelineUseCase(repository as never).execute('call-1'),
    ).resolves.toEqual(timeline);
    await expect(
      new ListRecentCallLegsUseCase(repository as never).execute(query),
    ).resolves.toEqual(recent);
  });

  it('purges telemetry received more than 30 days before the supplied time', async () => {
    const repository = { deleteReceivedBefore: jest.fn().mockResolvedValue(3) };
    const useCase = new PurgeExpiredCallTelemetryUseCase(repository as never);
    const now = new Date('2026-07-31T00:00:00.000Z');

    await expect(useCase.execute(now)).resolves.toBe(3);
    expect(repository.deleteReceivedBefore).toHaveBeenCalledWith(
      new Date('2026-07-01T00:00:00.000Z'),
    );
  });
});
