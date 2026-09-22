import { ReelMonitoringSnapshotSchema } from '@common/content/dtos/reel-monitoring-snapshot.dto';
import { PrometheusMetricsService } from '@monitoring/infrastructure/metrics/prometheus-metrics.service';
import { Inject, Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ClientProxy } from '@nestjs/microservices';
import { Interval } from '@nestjs/schedule';
import { firstValueFrom, timeout } from 'rxjs';

@Injectable()
export class ReelMonitoringPollerJob implements OnModuleInit {
  private readonly logger = new Logger(ReelMonitoringPollerJob.name);
  private polling = false;

  constructor(
    @Inject('CONTENT_SERVICE_RMQ') private readonly contentClient: ClientProxy,
    private readonly metrics: PrometheusMetricsService,
  ) {}

  onModuleInit(): void {
    void this.poll();
  }

  @Interval(15_000)
  async poll(): Promise<void> {
    if (this.polling) return;
    this.polling = true;

    try {
      const payload = await firstValueFrom(
        this.contentClient
          .send<unknown>('content.monitoring.reels', {})
          .pipe(timeout(5_000)),
      );
      this.metrics.recordReelSnapshot(
        ReelMonitoringSnapshotSchema.parse(payload),
      );
    } catch (error) {
      this.metrics.markReelSnapshotUnavailable();
      this.logger.warn(
        error instanceof Error
          ? `Reel monitoring snapshot failed: ${error.message}`
          : 'Reel monitoring snapshot failed',
      );
    } finally {
      this.polling = false;
    }
  }
}
