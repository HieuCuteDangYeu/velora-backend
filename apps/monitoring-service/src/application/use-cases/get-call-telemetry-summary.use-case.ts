import { Inject, Injectable } from '@nestjs/common';
import type { ICallTelemetryRepository } from '../../domain/interfaces/call-telemetry.repository.interface';
import type {
  CallTelemetrySummary,
  StoredCallTelemetryEvent,
  TelemetryJsonObject,
  TelemetryQuery,
} from '../../domain/models/call-telemetry.model';

@Injectable()
export class GetCallTelemetrySummaryUseCase {
  constructor(
    @Inject('ICallTelemetryRepository')
    private readonly repository: ICallTelemetryRepository,
  ) {}

  async execute(query: TelemetryQuery): Promise<CallTelemetrySummary> {
    const events = await this.repository.findEvents(query);
    const controlPlaneSucceeded = events.filter(
      (event) =>
        event.stage === 'control_plane_active' && event.outcome === 'succeeded',
    );
    const mediaReady = events.filter(
      (event) => event.stage === 'media_ready' && event.outcome === 'succeeded',
    );
    const attempts = new Set(events.map((event) => event.attemptId));
    const failures = events.filter((event) => event.outcome === 'failed');
    // A call nobody picked up never started setup, so it says nothing about
    // setup success. A failure always counts, even when the call also timed out.
    const settled = new Set(
      [...controlPlaneSucceeded, ...failures].map((event) => event.attemptId),
    );
    const unanswered = new Set(
      events
        .filter(
          (event) =>
            event.eventType === 'terminal' &&
            UNANSWERED_TERMINAL_STAGES.has(event.stage) &&
            !settled.has(event.attemptId),
        )
        .map((event) => event.attemptId),
    );
    const answerable = attempts.size - unanswered.size;
    const quality = events.filter(
      (event) => event.eventType === 'quality_sample',
    );

    return {
      attempts: attempts.size,
      unansweredAttempts: unanswered.size,
      controlPlaneSuccessRate: rate(
        new Set(controlPlaneSucceeded.map((event) => event.attemptId)).size,
        answerable,
      ),
      mediaReadySuccessRate: rate(
        new Set(mediaReady.map((event) => event.attemptId)).size,
        answerable,
      ),
      timeToControlPlaneActiveMs: percentiles(
        controlPlaneSucceeded.map((event) => event.elapsedMs),
      ),
      timeToFirstRemoteAudioMs: percentiles(
        mediaReady.map((event) => event.elapsedMs),
      ),
      failures: countBy(
        failures,
        (event) => `${event.stage}:${event.errorCode ?? 'unknown'}`,
      ),
      quality: {
        samples: quality.length,
        packetLossRate: averageMetric(quality, 'packetLossRate'),
        jitterMs: averageMetric(quality, 'jitterMs'),
        roundTripTimeMs: averageMetric(quality, 'roundTripTimeMs'),
        concealmentRate: averageMetric(quality, 'concealmentRate'),
        jitterBufferDelayMs: averageMetric(quality, 'jitterBufferDelayMs'),
        badSampleRate: rate(
          quality.filter((event) => isBadQualitySample(event.metricsJson))
            .length,
          quality.length,
        ),
      },
    };
  }
}

// Terminal stages the mobile app records when a call ends without being answered.
const UNANSWERED_TERMINAL_STAGES = new Set([
  'lifecycle:cancelled',
  'lifecycle:rejected',
  'lifecycle:expired',
  'lifecycle:answered_elsewhere',
]);

const rate = (numerator: number, denominator: number) =>
  denominator === 0 ? null : numerator / denominator;

const percentiles = (values: number[]) => {
  if (values.length === 0) return { p50: null, p95: null };
  const sorted = [...values].sort((a, b) => a - b);
  const at = (percentile: number) =>
    sorted[
      Math.min(sorted.length - 1, Math.ceil(sorted.length * percentile) - 1)
    ];
  return { p50: at(0.5), p95: at(0.95) };
};

const countBy = <T>(values: T[], key: (value: T) => string) =>
  values.reduce<Record<string, number>>((counts, value) => {
    const name = key(value);
    counts[name] = (counts[name] ?? 0) + 1;
    return counts;
  }, {});

const averageMetric = (events: StoredCallTelemetryEvent[], key: string) => {
  const values = events
    .map((event) => event.metricsJson?.[key])
    .filter(
      (value): value is number =>
        typeof value === 'number' && Number.isFinite(value),
    );
  return values.length === 0
    ? null
    : values.reduce((sum, value) => sum + value, 0) / values.length;
};

const isBadQualitySample = (metrics: TelemetryJsonObject | null) =>
  (typeof metrics?.packetLossRate === 'number' &&
    metrics.packetLossRate >= 0.05) ||
  (typeof metrics?.roundTripTimeMs === 'number' &&
    metrics.roundTripTimeMs >= 400) ||
  (typeof metrics?.jitterMs === 'number' && metrics.jitterMs >= 50) ||
  (typeof metrics?.concealmentRate === 'number' &&
    metrics.concealmentRate >= 0.03);
