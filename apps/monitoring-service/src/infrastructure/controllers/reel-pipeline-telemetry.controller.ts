import { ReelPipelineTelemetryEventSchema } from '@common/processing/dtos/reel-pipeline-telemetry.dto';
import { PrometheusMetricsService } from '@monitoring/infrastructure/metrics/prometheus-metrics.service';
import { Controller } from '@nestjs/common';
import { EventPattern, Payload, RpcException } from '@nestjs/microservices';

@Controller()
export class ReelPipelineTelemetryController {
  constructor(private readonly metrics: PrometheusMetricsService) {}

  @EventPattern('reel.pipeline.telemetry.ingest')
  ingest(@Payload() payload: unknown): void {
    const startedAt = process.hrtime.bigint();
    let status: 'success' | 'error' = 'success';

    try {
      const event = ReelPipelineTelemetryEventSchema.parse(payload);
      this.metrics.recordReelPipelineTelemetry(event);
    } catch {
      status = 'error';
      throw new RpcException({
        statusCode: 400,
        message: 'Invalid Reel pipeline telemetry payload',
      });
    } finally {
      this.metrics.recordRpc(
        'reel.pipeline.telemetry.ingest',
        status,
        Number(process.hrtime.bigint() - startedAt) / 1_000_000_000,
      );
    }
  }
}
