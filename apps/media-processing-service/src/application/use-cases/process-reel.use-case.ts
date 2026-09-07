import type { ReelMediaLengthClass } from '@common/processing/interfaces/reel-media-job.interface';
import type { ReelMediaEdit } from '@common/content/schemas/reel-edit.schema';
import type { ReelPipelineMetricContext } from '@common/processing/interfaces/reel-pipeline-metric.interface';
import { Inject, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { IProcessingMetrics } from '@processing/domain/interfaces/processing-metrics.interface';
import * as path from 'node:path';
import type {
  IContentService,
  ReelProcessingMediaMetadata,
} from '../../domain/interfaces/content-service.interface';
import type { IJobConcurrencyLimiterService } from '../../domain/interfaces/job-concurrency-limiter.service.interface';
import type { ITempFileService } from '../../domain/interfaces/temp-file.service.interface';
import { formatProcessingError } from '../utils/format-processing-error';
import { BuildVisualFrameManifestUseCase } from './build-visual-frame-manifest.use-case';
import {
  PrepareReelMediaError,
  PrepareReelMediaUseCase,
} from './prepare-reel-media.use-case';

export type ProcessReelResult =
  | { status: 'COMPLETED' }
  | { status: 'DUPLICATE_OR_STALE' }
  | { status: 'RETRY'; failureStage: string; errorDetail: string }
  | {
      status: 'PERMANENT_FAILURE';
      failureStage: string;
      errorDetail: string;
    };

@Injectable()
export class ProcessReelUseCase {
  private readonly logger = new Logger(ProcessReelUseCase.name);

  constructor(
    private readonly configService: ConfigService,
    private readonly prepareReelMediaUseCase: PrepareReelMediaUseCase,
    private readonly buildVisualFrameManifestUseCase: BuildVisualFrameManifestUseCase,
    @Inject('IContentService')
    private readonly contentService: IContentService,
    @Inject('ITempFileService')
    private readonly tempFileService: ITempFileService,
    @Inject('IJobConcurrencyLimiterService')
    private readonly jobConcurrencyLimiter: IJobConcurrencyLimiterService,
    @Inject('IProcessingMetrics')
    private readonly processingMetrics: IProcessingMetrics,
  ) {}

  async execute(data: {
    reelId: string;
    mediaKey: string;
    userId: string;
    processingAttemptId?: string;
    queuedAt?: string;
    expectedLengthClass?: ReelMediaLengthClass;
    queueName?: string;
    retryNumber?: number;
    allowReclaim?: boolean;
    allowRetry?: boolean;
    edit?: ReelMediaEdit;
  }): Promise<ProcessReelResult> {
    return await this.jobConcurrencyLimiter.runExclusive(async () => {
      const { reelId, mediaKey, processingAttemptId } = data;

      if (!processingAttemptId) {
        this.logger.warn(
          `[Reel ${reelId}] Ignoring media job without mediaAttemptId`,
        );
        return { status: 'DUPLICATE_OR_STALE' };
      }

      const metricsContext: ReelPipelineMetricContext = {
        reelId,
        processingAttemptId,
        mediaClass: data.expectedLengthClass ?? 'UNKNOWN',
        orientation: 'UNKNOWN',
        retryNumber: data.retryNumber ?? 0,
      };
      const queuedAtMs = data.queuedAt ? Date.parse(data.queuedAt) : Number.NaN;

      this.processingMetrics.record(metricsContext, {
        stage: 'QUEUE_WAIT',
        success: Number.isFinite(queuedAtMs),
        durationMs: Number.isFinite(queuedAtMs)
          ? Math.max(0, Date.now() - queuedAtMs)
          : 0,
        details: {
          queueName: data.queueName ?? 'reel_media_short_jobs',
          measurementAvailable: Number.isFinite(queuedAtMs),
        },
      });

      const claimTimer = this.processingMetrics.startStage(
        metricsContext,
        'JOB_CLAIM',
      );
      let claimed: boolean;

      try {
        claimed = await this.contentService.claimReelProcessingAttempt({
          reelId,
          processingAttemptId,
          allowReclaim: data.allowReclaim,
        });
        claimTimer.succeed({ claimed });
      } catch (error: unknown) {
        claimTimer.fail('JOB_CLAIM');
        throw error;
      }

      if (!claimed) {
        this.logger.warn(
          `[Reel ${reelId}] Ignoring duplicate or stale media attempt ${processingAttemptId}`,
        );
        return { status: 'DUPLICATE_OR_STALE' };
      }

      const totalPipelineTimer = this.processingMetrics.startStage(
        metricsContext,
        'TOTAL_PIPELINE',
      );
      const workspace = this.tempFileService.createReelProcessingWorkspace();
      let currentProgress = 10;
      let failedStage = 'FAILED';
      let failedMessage = 'Video processing failed';
      let failureDetail = '';
      let failureMediaMetadata: ReelProcessingMediaMetadata | undefined;

      try {
        const mediaResult = await this.prepareReelMediaUseCase.execute({
          reelId,
          mediaKey,
          processingAttemptId,
          workDir: workspace.workDir,
          inputPath: workspace.inputPath,
          hlsOutputDir: workspace.hlsOutputDir,
          audioOutputDir: workspace.audioOutputDir,
          thumbnailPath: workspace.thumbnailPath,
          metricsContext,
          edit: data.edit,
        });

        currentProgress = 96;
        failedStage = 'BUILDING_VISUAL_MANIFEST';
        failedMessage = 'Visual reel indexing artifacts could not be prepared';
        await this.contentService.emitProcessingProgress({
          reelId,
          status: 'PROCESSING',
          processingAttemptId,
          stage: failedStage,
          message: 'Sampling visual scenes for search',
          progress: currentProgress,
        });
        const visualTimer = this.processingMetrics.startStage(
          metricsContext,
          'VISUAL_FRAME_ARTIFACTS',
        );
        const visualResult = await this.buildVisualFrameManifestUseCase.execute(
          {
            reelId,
            mediaAttemptId: processingAttemptId,
            inputPath: workspace.inputPath,
            outputDir: path.join(workspace.workDir, 'visual-frames'),
            storagePrefix: mediaKey.replace(/\.[^.]+$/, ''),
            metadata: {
              durationMs:
                mediaResult.mediaMetadata.outputDurationMs ??
                mediaResult.mediaMetadata.sourceDurationMs,
            },
            crop: mediaResult.crop,
            trim: mediaResult.trim,
          },
        );
        visualTimer.succeed({
          visualFrameCount: visualResult.manifest.artifacts.length,
          visualFrameBytes: visualResult.totalFrameBytes,
        });
        const mediaOutput = {
          ...mediaResult.mediaOutput,
          visualFrameManifestKey: visualResult.manifestKey,
          checksums: {
            ...mediaResult.mediaOutput.checksums,
            visualFrameManifestSha256: visualResult.manifestChecksum,
          },
        };

        currentProgress = 100;
        const applied = await this.contentService.persistMediaCompleted({
          reelId,
          processingAttemptId,
          mediaMetadata: mediaResult.mediaMetadata,
          mediaOutput,
        });

        if (!applied) {
          totalPipelineTimer.succeed({ staleMediaAttempt: true });
          return { status: 'DUPLICATE_OR_STALE' };
        }

        totalPipelineTimer.succeed({
          rabbitMqPayloadBytesEstimate:
            this.processingMetrics.estimatePayloadBytes({
              ...mediaResult,
              mediaOutput,
            }),
          mediaOnlyWorker: true,
          visualFrameCount: visualResult.manifest.artifacts.length,
        });
        this.logger.log(
          `[Reel ${reelId}] Media attempt ${processingAttemptId} completed`,
        );

        return { status: 'COMPLETED' };
      } catch (error: unknown) {
        const { message, stack } = formatProcessingError(error);
        failureDetail = message;
        this.logger.error(
          `[Reel ${reelId}] Media attempt ${processingAttemptId} failed: ${message}`,
          stack,
        );

        if (error instanceof PrepareReelMediaError) {
          currentProgress = error.progress;
          failedStage = error.stage;
          failedMessage = error.publicMessage;
          failureDetail = error.message;
          failureMediaMetadata = error.mediaMetadata;
        }

        totalPipelineTimer.fail(failedStage);

        if (data.allowRetry && this.isTransientFailure(error)) {
          await this.contentService.persistProcessingRetryScheduled({
            reelId,
            status: 'PENDING',
            processingAttemptId,
            stage: 'RETRY_SCHEDULED',
            message: 'Temporary media-processing failure; retry scheduled',
            progress: currentProgress,
          });

          return {
            status: 'RETRY',
            failureStage: failedStage,
            errorDetail: failureDetail,
          };
        }

        await this.contentService.emitProcessingFailed({
          reelId,
          status: 'FAILED',
          processingAttemptId,
          stage: failedStage,
          message: failedMessage,
          progress: currentProgress,
          errorCode: failedStage,
          errorDetail: failureDetail,
          mediaMetadata: failureMediaMetadata,
          metricsContext,
        });

        return {
          status: 'PERMANENT_FAILURE',
          failureStage: failedStage,
          errorDetail: failureDetail,
        };
      } finally {
        this.tempFileService.removeDirIfExists(workspace.workDir);
      }
    }, this.getConcurrencyLimit());
  }

  private getConcurrencyLimit(): number {
    const rawValue =
      this.configService.get<string>('MEDIA_VIDEO_PROCESSING_CONCURRENCY') ??
      '1';
    const parsed = Number(rawValue);

    return Number.isFinite(parsed) && parsed > 0 ? parsed : 1;
  }

  private isTransientFailure(error: unknown): boolean {
    if (!(error instanceof PrepareReelMediaError)) {
      return true;
    }

    if (error.retryable) {
      return true;
    }

    return [
      'DOWNLOADING',
      'UPLOADING_STREAM',
      'GENERATING_THUMBNAIL',
      'BUILDING_AUDIO_MANIFEST',
      'VALIDATING_STREAM',
      'STREAM_VALIDATION_FAILED',
    ].includes(error.stage);
  }
}
