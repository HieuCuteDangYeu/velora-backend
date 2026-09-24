import type { ReelMediaOutput } from '@common/processing/interfaces/reel-media-output.interface';
import type { ReelPipelineMetricContext } from '@common/processing/interfaces/reel-pipeline-metric.interface';
import { Inject, Injectable } from '@nestjs/common';
import { ClientProxy } from '@nestjs/microservices';
import type { IProcessingMetrics } from '@processing/domain/interfaces/processing-metrics.interface';
import { firstValueFrom, timeout } from 'rxjs';
import type {
  IContentService,
  ReelProcessingMediaMetadata,
} from '../../domain/interfaces/content-service.interface';

@Injectable()
export class ContentServiceAdapter implements IContentService {
  constructor(
    @Inject('CONTENT_RMQ') private readonly messageBroker: ClientProxy,
    @Inject('IProcessingMetrics')
    private readonly processingMetrics: IProcessingMetrics,
  ) {}

  private describeError(error: unknown): string {
    if (error instanceof Error) {
      return error.message;
    }

    if (typeof error === 'object' && error !== null) {
      const record = error as Record<string, unknown>;

      if ('message' in record && typeof record['message'] === 'string') {
        return record['message'];
      }

      if ('err' in record) {
        return this.describeError(record['err']);
      }

      try {
        return JSON.stringify(error);
      } catch {
        return 'Unserializable error object';
      }
    }

    return typeof error === 'string' ? error : 'Unknown error';
  }

  async claimReelProcessingAttempt(data: {
    reelId: string;
    processingAttemptId: string;
    allowReclaim?: boolean;
  }): Promise<boolean> {
    try {
      return await firstValueFrom(
        this.messageBroker.send<boolean>(
          'content.claim_reel_processing_attempt',
          data,
        ),
      );
    } catch (error: unknown) {
      throw new Error(
        `Failed to claim reel processing attempt: ${this.describeError(error)}`,
      );
    }
  }

  async emitProcessingStarted(data: {
    reelId: string;
    status: 'PROCESSING';
    processingAttemptId?: string;
    stage?: string;
    message?: string;
    progress?: number;
  }): Promise<void> {
    try {
      await firstValueFrom(
        this.messageBroker.emit('reel.processing_started', data),
      );
    } catch (error: unknown) {
      throw new Error(
        `Failed to emit reel.processing_started: ${this.describeError(error)}`,
      );
    }
  }

  async emitProcessingProgress(data: {
    reelId: string;
    status: 'PROCESSING';
    processingAttemptId?: string;
    stage?: string;
    message?: string;
    progress?: number;
  }): Promise<void> {
    try {
      await firstValueFrom(
        this.messageBroker.emit('reel.processing_progress', data),
      );
    } catch (error: unknown) {
      throw new Error(
        `Failed to emit reel.processing_progress: ${this.describeError(error)}`,
      );
    }
  }

  async emitProcessingFailed(data: {
    reelId: string;
    status: 'FAILED';
    processingAttemptId?: string;
    stage?: string;
    message?: string;
    progress?: number;
    errorCode?: string;
    errorDetail?: string;
    mediaMetadata?: ReelProcessingMediaMetadata;
    metricsContext?: ReelPipelineMetricContext;
  }): Promise<void> {
    const timer = data.metricsContext
      ? this.processingMetrics.startStage(
          data.metricsContext,
          'RABBITMQ_PUBLISH_FAILED',
          {
            rabbitMqPayloadBytesEstimate:
              this.processingMetrics.estimatePayloadBytes(data),
          },
        )
      : undefined;

    try {
      await firstValueFrom(
        this.messageBroker
          .send('content.persist_reel_processing_failed', data)
          .pipe(timeout(30_000)),
      );
      timer?.succeed();
    } catch (error: unknown) {
      timer?.fail('RABBITMQ_PUBLISH_FAILED');
      throw new Error(
        `Failed to emit reel.processing_failed: ${this.describeError(error)}`,
      );
    }
  }

  async persistProcessingRetryScheduled(data: {
    reelId: string;
    status: 'PENDING';
    processingAttemptId: string;
    stage: 'RETRY_SCHEDULED';
    message: string;
    progress: number;
  }): Promise<void> {
    try {
      await firstValueFrom(
        this.messageBroker
          .send('content.persist_reel_processing_retry_scheduled', data)
          .pipe(timeout(30_000)),
      );
    } catch (error: unknown) {
      throw new Error(
        `Failed to persist retry scheduling: ${this.describeError(error)}`,
      );
    }
  }

  async persistMediaCompleted(data: {
    reelId: string;
    processingAttemptId: string;
    mediaMetadata: ReelProcessingMediaMetadata;
    mediaOutput: ReelMediaOutput;
  }): Promise<boolean> {
    try {
      const response = await firstValueFrom(
        this.messageBroker
          .send<{
            persisted: true;
            applied: boolean;
          }>('content.persist_reel_media_completed', data)
          .pipe(timeout(30_000)),
      );

      return response.applied;
    } catch (error: unknown) {
      throw new Error(
        `Failed to persist media completion: ${this.describeError(error)}`,
      );
    }
  }

  async persistExistingHlsEvidence(data: {
    reelId: string;
    processingAttemptId: string;
    transcriptionAudioManifestKey: string;
    visualFrameManifestKey: string;
    mediaMetadata: ReelProcessingMediaMetadata;
  }): Promise<boolean> {
    try {
      const response = await firstValueFrom(
        this.messageBroker
          .send<{ persisted: true; applied: boolean }>(
            'content.persist_reel_hls_evidence_completed',
            data,
          )
          .pipe(timeout(30_000)),
      );
      return response.applied;
    } catch (error: unknown) {
      throw new Error(
        `Failed to persist existing HLS evidence: ${this.describeError(error)}`,
      );
    }
  }
}
