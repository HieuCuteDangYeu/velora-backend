import {
  CallTelemetryEventSchema,
  CallTelemetryQuerySchema,
  CallTelemetryTimelineSchema,
} from './call-telemetry.dto';

describe('CallTelemetryEventSchema', () => {
  const event = {
    eventId: '11111111-1111-4111-8111-111111111111',
    attemptId: '22222222-2222-4222-8222-222222222222',
    eventType: 'quality_sample' as const,
    stage: 'audio_quality',
    elapsedMs: 1000,
    occurredAt: '2026-07-10T11:00:00.000Z',
    platform: 'ios' as const,
    appVersion: '1.0.0',
  };

  it('accepts sanitized audio route and inbound traffic deltas', () => {
    expect(
      CallTelemetryEventSchema.parse({
        ...event,
        metrics: {
          packetsReceivedDelta: 32,
          bytesReceivedDelta: 6400,
        },
        details: {
          audioRoute: {
            category: 'play_and_record',
            mode: 'voice_chat',
            outputRouteTypes: ['receiver'],
            inputRouteTypes: ['receiver'],
            forcedSpeaker: false,
          },
        },
      }),
    ).toMatchObject(event);
  });

  it('rejects a raw audio route name', () => {
    expect(() =>
      CallTelemetryEventSchema.parse({
        ...event,
        details: {
          audioRoute: {
            category: 'play_and_record',
            mode: 'voice_chat',
            outputRouteTypes: ['Quans iPhone'],
            inputRouteTypes: ['receiver'],
            forcedSpeaker: false,
          },
        },
      }),
    ).toThrow();
  });

  it('accepts a telemetry query with a valid time range', () => {
    expect(
      CallTelemetryQuerySchema.parse({
        from: '2026-07-10T00:00:00.000Z',
        to: '2026-07-10T23:59:59.999Z',
        platform: 'ios',
      }),
    ).toMatchObject({ platform: 'ios' });
  });

  it('rejects invalid telemetry query ranges and call identifiers', () => {
    expect(() =>
      CallTelemetryQuerySchema.parse({
        from: '2026-07-11T00:00:00.000Z',
        to: '2026-07-10T00:00:00.000Z',
      }),
    ).toThrow();
    expect(() =>
      CallTelemetryTimelineSchema.parse({ callId: 'call-1' }),
    ).toThrow();
  });
});
