import type { ReelIndexJob } from '@common/processing/interfaces/reel-index-job.interface';
import { Inject, Injectable, Logger } from '@nestjs/common';
import type { ClientProxy } from '@nestjs/microservices';
import { randomUUID } from 'node:crypto';

type IndexItemCounts = {
  reelDocuments: number;
  sections: number;
  chunks: number;
};

@Injectable()
export class IndexingMetricsService {
  private readonly logger = new Logger(IndexingMetricsService.name);

  constructor(
    @Inject('MONITORING_SERVICE_RMQ')
    private readonly monitoringClient: ClientProxy,
  ) {}

  record(input: {
    job: ReelIndexJob;
    retryNumber: number;
    stage: string;
    success: boolean;
    durationMs: number;
    itemCounts?: IndexItemCounts;
  }): void {
    this.monitoringClient
      .emit('reel.pipeline.telemetry.ingest', {
        eventId: randomUUID(),
        pipeline: 'INDEX',
        lane: input.job.sourceLengthClass,
        stage: input.stage.toUpperCase(),
        outcome: input.success ? 'SUCCEEDED' : 'FAILED',
        durationMs: Math.max(0, Math.round(input.durationMs)),
        retryNumber: input.retryNumber,
        ...(input.itemCounts ? { itemCounts: input.itemCounts } : {}),
        occurredAt: new Date().toISOString(),
      })
      .subscribe({
        error: (error: unknown) => {
          const detail = error instanceof Error ? error.message : String(error);
          this.logger.warn(`Reel index telemetry publish failed: ${detail}`);
        },
      });
  }
}
