import type { RecommendationTelemetryEventPayload } from '@common/recommendation/interfaces/recommendation-telemetry.interface';
import { Logger } from '@nestjs/common';
import { of, throwError } from 'rxjs';
import {
  RecommendationTelemetryServiceAdapter,
  TELEMETRY_BATCH_SIZE,
  TELEMETRY_FLUSH_INTERVAL_MS,
} from './recommendation-telemetry-service.adapter';

describe('RecommendationTelemetryServiceAdapter', () => {
  const event = (n: number) =>
    ({ eventId: `event-${n}` }) as never as RecommendationTelemetryEventPayload;

  const create = (emit: jest.Mock = jest.fn(() => of(undefined))) => ({
    emit,
    adapter: new RecommendationTelemetryServiceAdapter({ emit } as never),
  });

  beforeEach(() => jest.useFakeTimers());
  afterEach(() => {
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  it('sends nothing until the interval passes, then every waiting event in one message', () => {
    const { adapter, emit } = create();

    adapter.publish(event(1));
    adapter.publish(event(2));
    adapter.publish(event(3));
    expect(emit).not.toHaveBeenCalled();

    jest.advanceTimersByTime(TELEMETRY_FLUSH_INTERVAL_MS);

    expect(emit).toHaveBeenCalledTimes(1);
    expect(emit).toHaveBeenCalledWith('recommendation.telemetry.ingest', {
      events: [event(1), event(2), event(3)],
    });
  });

  it('sends a full batch at once, without waiting for the timer', () => {
    const { adapter, emit } = create();

    for (let i = 0; i < TELEMETRY_BATCH_SIZE; i++) adapter.publish(event(i));

    expect(emit).toHaveBeenCalledTimes(1);
    const [, payload] = emit.mock.calls[0] as unknown as [
      string,
      { events: unknown[] },
    ];
    expect(payload.events).toHaveLength(TELEMETRY_BATCH_SIZE);

    // The timer was cleared with the flush, so nothing is sent a second time.
    jest.advanceTimersByTime(TELEMETRY_FLUSH_INTERVAL_MS * 2);
    expect(emit).toHaveBeenCalledTimes(1);
  });

  it('starts a new batch after a flush and never exceeds the ingest limit', () => {
    const { adapter, emit } = create();

    for (let i = 0; i < TELEMETRY_BATCH_SIZE + 2; i++)
      adapter.publish(event(i));
    jest.advanceTimersByTime(TELEMETRY_FLUSH_INTERVAL_MS);

    expect(emit).toHaveBeenCalledTimes(2);
    const sizes = (
      emit.mock.calls as unknown as [string, { events: unknown[] }][]
    ).map(([, payload]) => payload.events.length);
    expect(sizes).toEqual([TELEMETRY_BATCH_SIZE, 2]);
  });

  it('sends the waiting events when the module shuts down', () => {
    const { adapter, emit } = create();

    adapter.publish(event(1));
    adapter.onModuleDestroy();

    expect(emit).toHaveBeenCalledTimes(1);
    jest.advanceTimersByTime(TELEMETRY_FLUSH_INTERVAL_MS);
    expect(emit).toHaveBeenCalledTimes(1);
  });

  it('does nothing at shutdown when no event is waiting', () => {
    const { adapter, emit } = create();

    adapter.onModuleDestroy();

    expect(emit).not.toHaveBeenCalled();
  });

  it('logs a failed publish instead of throwing into the feed request', () => {
    const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation();
    const emit = jest
      .fn()
      .mockReturnValueOnce(throwError(() => new Error('broker down')))
      .mockImplementationOnce(() => {
        throw new Error('channel closed');
      });
    const { adapter } = create(emit);

    adapter.publish(event(1));
    jest.advanceTimersByTime(TELEMETRY_FLUSH_INTERVAL_MS);
    adapter.publish(event(2));
    expect(() =>
      jest.advanceTimersByTime(TELEMETRY_FLUSH_INTERVAL_MS),
    ).not.toThrow();

    expect(warn).toHaveBeenCalledWith(
      'Recommendation telemetry publish failed: broker down',
    );
    expect(warn).toHaveBeenCalledWith(
      'Recommendation telemetry publish failed: channel closed',
    );
  });
});
