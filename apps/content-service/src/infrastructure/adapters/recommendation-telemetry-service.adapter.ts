import type { RecommendationTelemetryEventPayload } from '@common/recommendation/interfaces/recommendation-telemetry.interface';
import type { IRecommendationTelemetryService } from '@content/domain/interfaces/recommendation-telemetry-service.interface';
import { Inject, Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { ClientProxy } from '@nestjs/microservices';

// Every feed request used to send its own message, which monitoring-service parsed and
// wrote with its own insert: about 200 messages and 200 inserts a second at the load-test
// peak, and monitoring-service spent half a core on it. Events are only statistics, so
// they are sent together once a second, or as soon as a full batch is waiting.
// 50 is the most events one ingest message may carry (TrackRecommendationTelemetrySchema).
export const TELEMETRY_BATCH_SIZE = 50;
export const TELEMETRY_FLUSH_INTERVAL_MS = 1_000;

@Injectable()
export class RecommendationTelemetryServiceAdapter
  implements IRecommendationTelemetryService, OnModuleDestroy
{
  private readonly logger = new Logger(
    RecommendationTelemetryServiceAdapter.name,
  );
  private pending: RecommendationTelemetryEventPayload[] = [];
  private timer: NodeJS.Timeout | null = null;

  constructor(
    @Inject('MONITORING_SERVICE_RMQ')
    private readonly monitoringClient: ClientProxy,
  ) {}

  publish(event: RecommendationTelemetryEventPayload): void {
    this.pending.push(event);

    if (this.pending.length >= TELEMETRY_BATCH_SIZE) {
      this.flush();
      return;
    }

    if (!this.timer) {
      this.timer = setTimeout(() => this.flush(), TELEMETRY_FLUSH_INTERVAL_MS);
      // A waiting batch must not keep the process alive; onModuleDestroy sends it.
      this.timer.unref();
    }
  }

  onModuleDestroy(): void {
    this.flush();
  }

  private flush(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }

    while (this.pending.length > 0) {
      this.send(this.pending.splice(0, TELEMETRY_BATCH_SIZE));
    }
  }

  private send(events: RecommendationTelemetryEventPayload[]): void {
    try {
      this.monitoringClient
        .emit('recommendation.telemetry.ingest', { events })
        .subscribe({
          error: (error: unknown) => {
            this.logger.warn(this.describeError(error));
          },
        });
    } catch (error) {
      this.logger.warn(this.describeError(error));
    }
  }

  private describeError(error: unknown): string {
    return error instanceof Error
      ? `Recommendation telemetry publish failed: ${error.message}`
      : 'Recommendation telemetry publish failed';
  }
}
