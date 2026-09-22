import type {
  ReelPipelineMetricContext,
  ReelPipelineMetricRecord,
} from '@common/processing/interfaces/reel-pipeline-metric.interface';
import { Inject, Injectable, Logger } from '@nestjs/common';
import type { ClientProxy } from '@nestjs/microservices';
import { randomUUID } from 'node:crypto';
import type {
  IProcessingMetrics,
  IProcessingStageTimer,
  ProcessingMetricDetails,
} from '@processing/domain/interfaces/processing-metrics.interface';

type StageCompletion = (
  success: boolean,
  durationMs: number,
  failureStage?: string,
  details?: ProcessingMetricDetails,
) => void;

export class ProcessingStageTimer implements IProcessingStageTimer {
  private readonly startedAt: number;
  private completed = false;

  constructor(
    private readonly onComplete: StageCompletion,
    private readonly now: () => number = Date.now,
  ) {
    this.startedAt = this.now();
  }

  succeed(details?: ProcessingMetricDetails): number {
    return this.finish(true, undefined, details);
  }

  fail(failureStage?: string, details?: ProcessingMetricDetails): number {
    return this.finish(false, failureStage, details);
  }

  private finish(
    success: boolean,
    failureStage?: string,
    details?: ProcessingMetricDetails,
  ): number {
    if (this.completed) {
      return 0;
    }

    this.completed = true;
    const durationMs = Math.max(0, this.now() - this.startedAt);
    this.onComplete(success, durationMs, failureStage, details);
    return durationMs;
  }
}

@Injectable()
export class ProcessingMetricsService implements IProcessingMetrics {
  private readonly logger = new Logger('ReelPipelineMetrics');

  constructor(
    @Inject('MONITORING_SERVICE_RMQ')
    private readonly monitoringClient: ClientProxy,
  ) {}

  startStage(
    context: ReelPipelineMetricContext,
    stage: string,
    details: ProcessingMetricDetails = {},
  ): IProcessingStageTimer {
    return new ProcessingStageTimer(
      (success, durationMs, failureStage, completionDetails) => {
        const retryNumberValue =
          completionDetails?.['retryNumber'] ?? details['retryNumber'];
        this.record(context, {
          stage,
          success,
          durationMs,
          failureStage,
          retryNumber:
            typeof retryNumberValue === 'number' ? retryNumberValue : undefined,
          details: {
            ...details,
            ...completionDetails,
          },
        });
      },
    );
  }

  record(
    context: ReelPipelineMetricContext,
    input: {
      stage: string;
      success: boolean;
      durationMs: number;
      retryNumber?: number;
      failureStage?: string;
      details?: ProcessingMetricDetails;
    },
  ): ReelPipelineMetricRecord {
    const record: ReelPipelineMetricRecord = {
      event: 'reel_pipeline_metric',
      timestamp: new Date().toISOString(),
      ...(input.details ?? {}),
      reelId: context.reelId,
      processingAttemptId: context.processingAttemptId,
      stage: input.stage,
      mediaClass: context.mediaClass,
      orientation: context.orientation,
      success: input.success,
      durationMs: Math.max(0, Math.round(input.durationMs)),
      retryNumber: input.retryNumber ?? context.retryNumber,
      ...(input.failureStage ? { failureStage: input.failureStage } : {}),
    };

    this.logger.log(JSON.stringify(record));
    this.monitoringClient
      .emit('reel.pipeline.telemetry.ingest', {
        eventId: randomUUID(),
        pipeline: 'MEDIA',
        lane: context.mediaClass,
        stage: input.stage,
        outcome: input.success ? 'SUCCEEDED' : 'FAILED',
        durationMs: record.durationMs,
        retryNumber: record.retryNumber,
        occurredAt: record.timestamp,
      })
      .subscribe({
        error: (error: unknown) => {
          const detail = error instanceof Error ? error.message : String(error);
          this.logger.warn(`Reel telemetry publish failed: ${detail}`);
        },
      });
    return record;
  }

  estimatePayloadBytes(payload: unknown): number {
    try {
      const serialized = JSON.stringify(payload, (_key, value: unknown) =>
        typeof value === 'bigint' ? value.toString() : value,
      );

      return Buffer.byteLength(serialized ?? '', 'utf8');
    } catch {
      return 0;
    }
  }
}
