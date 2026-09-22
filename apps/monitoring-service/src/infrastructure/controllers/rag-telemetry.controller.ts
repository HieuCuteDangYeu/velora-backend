import { RagTelemetryEventSchema } from '@common/ai/dtos/rag-telemetry.dto';
import { PrometheusMetricsService } from '@monitoring/infrastructure/metrics/prometheus-metrics.service';
import { Controller } from '@nestjs/common';
import { EventPattern, Payload, RpcException } from '@nestjs/microservices';

@Controller()
export class RagTelemetryController {
  constructor(private readonly metrics: PrometheusMetricsService) {}

  @EventPattern('rag.telemetry.ingest')
  ingest(@Payload() payload: unknown): void {
    const startedAt = process.hrtime.bigint();
    let status: 'success' | 'error' = 'success';

    try {
      const event = RagTelemetryEventSchema.parse(payload);
      this.metrics.recordRagTelemetry(event);
    } catch {
      status = 'error';
      throw new RpcException({
        statusCode: 400,
        message: 'Invalid RAG telemetry payload',
      });
    } finally {
      this.metrics.recordRpc(
        'rag.telemetry.ingest',
        status,
        Number(process.hrtime.bigint() - startedAt) / 1_000_000_000,
      );
    }
  }
}
