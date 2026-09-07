import { RecommendationTelemetrySummaryQuerySchema } from '@common/recommendation/dtos/recommendation-telemetry-summary-query.dto';
import { TrackRecommendationTelemetrySchema } from '@common/recommendation/dtos/recommendation-telemetry.dto';
import { GetRecommendationTelemetrySummaryUseCase } from '@monitoring/application/use-cases/get-recommendation-telemetry-summary.use-case';
import { IngestRecommendationTelemetryUseCase } from '@monitoring/application/use-cases/ingest-recommendation-telemetry.use-case';
import { RecommendationTelemetryEvent } from '@monitoring/domain/entities/recommendation-telemetry-event.entity';
import { PrometheusMetricsService } from '@monitoring/infrastructure/metrics/prometheus-metrics.service';
import { Controller } from '@nestjs/common';
import {
  EventPattern,
  MessagePattern,
  Payload,
  RpcException,
} from '@nestjs/microservices';
import { ZodError } from 'zod';

@Controller()
export class RecommendationTelemetryController {
  constructor(
    private readonly ingestRecommendationTelemetryUseCase: IngestRecommendationTelemetryUseCase,
    private readonly getRecommendationTelemetrySummaryUseCase: GetRecommendationTelemetrySummaryUseCase,
    private readonly metrics: PrometheusMetricsService,
  ) {}

  @EventPattern('recommendation.telemetry.ingest')
  async ingest(@Payload() payload: unknown): Promise<void> {
    return this.measure('recommendation.telemetry.ingest', async () => {
      try {
        const parsed = TrackRecommendationTelemetrySchema.parse(payload);

        const events = parsed.events.map(
          (event) =>
            new RecommendationTelemetryEvent(
              event.eventId,
              event.recommendationType,
              event.algorithmVersion,
              event.feedSessionId,
              event.route,
              event.candidateSource,
              event.requestedLimit,
              event.returnedItems,
              event.latencyMs,
              event.outcome,
              event.errorCode ?? null,
              event.featureFlags,
              new Date(event.occurredAt),
            ),
        );

        await this.ingestRecommendationTelemetryUseCase.execute(events);
        this.metrics.addTelemetryEvents('recommendation', events.length);
      } catch (error) {
        this.handleError(error);
      }
    });
  }

  @MessagePattern('recommendation.telemetry.summary')
  async summary(@Payload() payload: unknown) {
    return this.measure('recommendation.telemetry.summary', async () => {
      try {
        const query = RecommendationTelemetrySummaryQuerySchema.parse(payload);

        return await this.getRecommendationTelemetrySummaryUseCase.execute({
          from: new Date(query.from),
          to: new Date(query.to),
          recommendationType: query.recommendationType,
          algorithmVersion: query.algorithmVersion,
          candidateSource: query.candidateSource,
        });
      } catch (error) {
        this.handleError(error);
      }
    });
  }

  private async measure<T>(pattern: string, operation: () => Promise<T>): Promise<T> {
    const startedAt = process.hrtime.bigint();
    let status: 'success' | 'error' = 'success';

    try {
      return await operation();
    } catch (error) {
      status = 'error';
      throw error;
    } finally {
      const durationSeconds =
        Number(process.hrtime.bigint() - startedAt) / 1_000_000_000;
      this.metrics.recordRpc(pattern, status, durationSeconds);
    }
  }

  private handleError(error: unknown): never {
    if (error instanceof ZodError) {
      throw new RpcException({
        statusCode: 400,
        message: error.issues.map((issue) => issue.message),
      });
    }

    if (error instanceof RpcException) {
      throw error;
    }

    throw new RpcException({
      statusCode: 500,
      message: 'Recommendation telemetry operation failed',
    });
  }
}
