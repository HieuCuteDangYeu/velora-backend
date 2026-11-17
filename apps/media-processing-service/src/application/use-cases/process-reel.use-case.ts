import type {
  ReelSourceLengthClass,
  ReelSourceOrientation,
} from '@common/content/interfaces/reel-state.interface';
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
import { PrepareExistingHlsEvidenceUseCase } from './prepare-existing-hls-evidence.use-case';
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

interface InlineEvidence {
  mediaMetadata: ReelProcessingMediaMetadata;
  transcriptionAudioManifestKey: string;
  visualFrameManifestKey: string;
}

@Injectable()
export class ProcessReelUseCase {
  private readonly logger = new Logger(ProcessReelUseCase.name);

  constructor(
    private readonly configService: ConfigService,
    private readonly prepareReelMediaUseCase: PrepareReelMediaUseCase,
    private readonly prepareExistingHlsEvidenceUseCase: PrepareExistingHlsEvidenceUseCase,
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
    sourceMode?: 'SOURCE_VIDEO' | 'EXISTING_HLS';
    hlsMasterKey?: string;
    existingSourceOrientation?: ReelSourceOrientation;
    existingSourceLengthClass?: ReelSourceLengthClass;
    preservedSourceDurationMs?: number;
    queueName?: string;
    retryNumber?: number;
    allowReclaim?: boolean;
    allowRetry?: boolean;
    edit?: ReelMediaEdit;
  }): Promise<ProcessReelResult> {
    const run = async (): Promise<ProcessReelResult> => {
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
          evidenceOnly: data.sourceMode === 'EXISTING_HLS',
          userId: data.userId,
          ...(data.sourceMode === 'EXISTING_HLS'
            ? { hlsMasterKey: data.hlsMasterKey }
            : {}),
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
      let deferredEvidence:
        | { hlsMasterKey: string; mediaMetadata: ReelProcessingMediaMetadata }
        | undefined;
      let keepWorkspace = false;

      try {
        const isExistingHls = data.sourceMode === 'EXISTING_HLS';
        let mediaMetadata: ReelProcessingMediaMetadata;
        let transcriptionAudioManifestKey = '';
        let mediaResult:
          | Awaited<ReturnType<PrepareReelMediaUseCase['execute']>>
          | undefined;

        if (isExistingHls) {
          if (!data.hlsMasterKey?.trim()) {
            throw new Error('HLS enrichment job has no master playlist key');
          }
          currentProgress = 15;
          failedStage = 'PREPARING_EXISTING_HLS_EVIDENCE';
          failedMessage =
            'Existing HLS media could not be prepared for indexing';
          const hlsResult =
            await this.prepareExistingHlsEvidenceUseCase.execute({
              reelId,
              mediaAttemptId: processingAttemptId,
              hlsMasterKey: data.hlsMasterKey,
              inputPath: workspace.inputPath,
              audioOutputDir: workspace.audioOutputDir,
              metricsContext,
              fallbackOrientation: data.existingSourceOrientation,
              fallbackLengthClass:
                data.existingSourceLengthClass ??
                (data.expectedLengthClass === 'SHORT' ||
                data.expectedLengthClass === 'LONG'
                  ? data.expectedLengthClass
                  : undefined),
              preservedSourceDurationMs: data.preservedSourceDurationMs,
            });
          mediaMetadata = hlsResult.mediaMetadata;
          transcriptionAudioManifestKey =
            hlsResult.transcriptionAudioManifestKey;
        } else {
          mediaResult = await this.prepareReelMediaUseCase.execute({
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
            ...(this.isInlineEvidenceEnabled()
              ? {
                  inlineEvidence: {
                    materializedPath: path.join(
                      workspace.workDir,
                      'evidence-input.mp4',
                    ),
                    onReady: ({ hlsMasterKey, mediaMetadata: encoded }) => {
                      // Built after the reel is reported ready, once no encode is waiting.
                      deferredEvidence = {
                        hlsMasterKey,
                        mediaMetadata: encoded,
                      };
                    },
                  },
                }
              : {}),
          });
          mediaMetadata = mediaResult.mediaMetadata;
        }

        if (!isExistingHls) {
          currentProgress = 100;
          const applied = await this.contentService.persistMediaCompleted({
            reelId,
            processingAttemptId,
            mediaMetadata,
            mediaOutput: mediaResult!.mediaOutput,
          });

          if (!applied) {
            totalPipelineTimer.succeed({ staleMediaAttempt: true });
            return { status: 'DUPLICATE_OR_STALE' };
          }

          totalPipelineTimer.succeed({
            rabbitMqPayloadBytesEstimate:
              this.processingMetrics.estimatePayloadBytes({
                mediaMetadata,
                mediaOutput: mediaResult!.mediaOutput,
              }),
            mediaOnlyWorker: true,
            reusedHls: false,
          });
          if (deferredEvidence) {
            this.logger.log(
              `[Reel ${reelId}] Media attempt ${processingAttemptId} completed; evidence follows on this worker`,
            );
            // The job ends here so its slot goes to the next waiting encode; the evidence runs
            // afterwards, and the workspace is removed when it is done.
            keepWorkspace = true;
            this.deferEvidence({
              reelId,
              processingAttemptId,
              hlsMasterKey: deferredEvidence.hlsMasterKey,
              mediaMetadata: deferredEvidence.mediaMetadata,
              inputPath: path.join(workspace.workDir, 'evidence-input.mp4'),
              audioOutputDir: workspace.audioOutputDir,
              visualOutputDir: path.join(workspace.workDir, 'visual-frames'),
              workDir: workspace.workDir,
              metricsContext,
            });
          } else {
            this.logger.log(
              `[Reel ${reelId}] Media attempt ${processingAttemptId} completed; evidence queued`,
            );
          }
          return { status: 'COMPLETED' };
        }

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
        const visualResult = await this.buildVisualEvidence({
          reelId,
          processingAttemptId,
          hlsMasterKey: data.hlsMasterKey!,
          inputPath: workspace.inputPath,
          outputDir: path.join(workspace.workDir, 'visual-frames'),
          mediaMetadata,
          metricsContext,
        });
        currentProgress = 100;
        const applied = await this.contentService.persistExistingHlsEvidence({
          reelId,
          processingAttemptId,
          transcriptionAudioManifestKey,
          visualFrameManifestKey: visualResult.manifestKey,
          mediaMetadata,
        });

        if (!applied) {
          totalPipelineTimer.succeed({ staleMediaAttempt: true });
          return { status: 'DUPLICATE_OR_STALE' };
        }

        totalPipelineTimer.succeed({
          rabbitMqPayloadBytesEstimate:
            this.processingMetrics.estimatePayloadBytes({
              mediaMetadata,
              transcriptionAudioManifestKey,
              visualFrameManifestKey: visualResult.manifestKey,
            }),
          mediaOnlyWorker: false,
          reusedHls: true,
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
            sourceMode: data.sourceMode,
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
          sourceMode: data.sourceMode,
        });

        return {
          status: 'PERMANENT_FAILURE',
          failureStage: failedStage,
          errorDetail: failureDetail,
        };
      } finally {
        // When evidence follows, it reads the workspace and removes it when it is done.
        if (!keepWorkspace) {
          this.tempFileService.removeDirIfExists(workspace.workDir);
        }
      }
    };

    // Evidence work for an already playable reel never goes before an encode that is waiting.
    return await this.jobConcurrencyLimiter.runExclusive(
      run,
      this.getConcurrencyLimit(),
      data.sourceMode === 'EXISTING_HLS' ? 'LOW' : 'NORMAL',
    );
  }

  private isInlineEvidenceEnabled(): boolean {
    return this.configService.get<string>('MEDIA_INLINE_EVIDENCE') !== 'false';
  }

  private async buildInlineEvidence(input: {
    reelId: string;
    processingAttemptId: string;
    hlsMasterKey: string;
    inputPath: string;
    audioOutputDir: string;
    visualOutputDir: string;
    metricsContext: ReelPipelineMetricContext;
    mediaMetadata: ReelProcessingMediaMetadata;
  }): Promise<InlineEvidence> {
    const audio =
      await this.prepareExistingHlsEvidenceUseCase.executeFromLocalMedia({
        reelId: input.reelId,
        mediaAttemptId: input.processingAttemptId,
        hlsMasterKey: input.hlsMasterKey,
        inputPath: input.inputPath,
        audioOutputDir: input.audioOutputDir,
        metricsContext: input.metricsContext,
        fallbackOrientation: input.mediaMetadata.sourceOrientation,
        fallbackLengthClass: input.mediaMetadata.sourceLengthClass,
        preservedSourceDurationMs: input.mediaMetadata.sourceDurationMs,
      });
    const visual = await this.buildVisualEvidence({
      reelId: input.reelId,
      processingAttemptId: input.processingAttemptId,
      hlsMasterKey: input.hlsMasterKey,
      inputPath: input.inputPath,
      outputDir: input.visualOutputDir,
      mediaMetadata: audio.mediaMetadata,
      metricsContext: input.metricsContext,
    });
    return {
      mediaMetadata: audio.mediaMetadata,
      transcriptionAudioManifestKey: audio.transcriptionAudioManifestKey,
      visualFrameManifestKey: visual.manifestKey,
    };
  }

  private async buildVisualEvidence(input: {
    reelId: string;
    processingAttemptId: string;
    hlsMasterKey: string;
    inputPath: string;
    outputDir: string;
    mediaMetadata: ReelProcessingMediaMetadata;
    metricsContext: ReelPipelineMetricContext;
  }) {
    const visualTimer = this.processingMetrics.startStage(
      input.metricsContext,
      'VISUAL_FRAME_ARTIFACTS',
    );
    const visualResult = await this.buildVisualFrameManifestUseCase.execute({
      reelId: input.reelId,
      mediaAttemptId: input.processingAttemptId,
      inputPath: input.inputPath,
      outputDir: input.outputDir,
      storagePrefix: path.posix.dirname(input.hlsMasterKey),
      metadata: {
        durationMs:
          input.mediaMetadata.outputDurationMs ??
          input.mediaMetadata.sourceDurationMs,
      },
    });
    visualTimer.succeed({
      visualFrameCount: visualResult.manifest.artifacts.length,
      visualFrameBytes: visualResult.totalFrameBytes,
    });
    return visualResult;
  }

  /**
   * Hands the evidence built next to the encode to the content service. It never fails the job:
   * the reel is already playable, and when this does not go through the delayed evidence job
   * builds it from the stored HLS instead.
   */
  private async persistInlineEvidence(input: {
    reelId: string;
    processingAttemptId: string;
    build: () => Promise<InlineEvidence>;
  }): Promise<void> {
    try {
      const evidence = await input.build();
      const applied = await this.contentService.persistExistingHlsEvidence({
        reelId: input.reelId,
        processingAttemptId: input.processingAttemptId,
        transcriptionAudioManifestKey: evidence.transcriptionAudioManifestKey,
        visualFrameManifestKey: evidence.visualFrameManifestKey,
        mediaMetadata: evidence.mediaMetadata,
      });
      this.logger.log(
        `[Reel ${input.reelId}] Inline evidence ${applied ? 'queued for indexing' : 'was not needed (already handled)'}`,
      );
    } catch (error: unknown) {
      this.logger.warn(
        `[Reel ${input.reelId}] Inline evidence failed, the evidence job will build it: ${formatProcessingError(error).message}`,
      );
    }
  }

  private readonly deferredEvidence = new Set<Promise<void>>();

  /** Resolves when every evidence run started by finished jobs is done (shutdown and tests). */
  async drainDeferredEvidence(): Promise<void> {
    while (this.deferredEvidence.size > 0) {
      await Promise.all([...this.deferredEvidence]);
    }
  }

  /**
   * Builds the evidence of a reel that is already playable, behind every encode that waits for a
   * slot. The short pause lets a job that RabbitMQ is about to deliver ask for the slot first. When
   * the slot does not come free in time (a backlog of encodes) the work is dropped here, because
   * the evidence job that content-service queues as a fallback does the same thing.
   */
  private deferEvidence(input: {
    reelId: string;
    processingAttemptId: string;
    hlsMasterKey: string;
    mediaMetadata: ReelProcessingMediaMetadata;
    inputPath: string;
    audioOutputDir: string;
    visualOutputDir: string;
    workDir: string;
    metricsContext: ReelPipelineMetricContext;
  }): void {
    const deadline =
      Date.now() +
      this.getNonNegativeNumber('MEDIA_INLINE_EVIDENCE_MAX_WAIT_MS', 540_000);
    const task = (async () => {
      try {
        await new Promise((resolve) =>
          setTimeout(
            resolve,
            this.getNonNegativeNumber('MEDIA_INLINE_EVIDENCE_DEFER_MS', 1_000),
          ),
        );
        await this.jobConcurrencyLimiter.runExclusive(
          async () => {
            if (Date.now() > deadline) {
              this.logger.warn(
                `[Reel ${input.reelId}] No free slot for the evidence in time; the evidence job will build it`,
              );
              return;
            }
            await this.persistInlineEvidence({
              reelId: input.reelId,
              processingAttemptId: input.processingAttemptId,
              build: () =>
                this.buildInlineEvidence({
                  reelId: input.reelId,
                  processingAttemptId: input.processingAttemptId,
                  hlsMasterKey: input.hlsMasterKey,
                  inputPath: input.inputPath,
                  audioOutputDir: input.audioOutputDir,
                  visualOutputDir: input.visualOutputDir,
                  metricsContext: input.metricsContext,
                  mediaMetadata: input.mediaMetadata,
                }),
            });
          },
          this.getConcurrencyLimit(),
          'LOW',
        );
      } catch (error: unknown) {
        this.logger.warn(
          `[Reel ${input.reelId}] Deferred evidence stopped: ${formatProcessingError(error).message}`,
        );
      } finally {
        this.tempFileService.removeDirIfExists(input.workDir);
      }
    })();
    this.deferredEvidence.add(task);
    void task.finally(() => this.deferredEvidence.delete(task));
  }

  private getNonNegativeNumber(key: string, fallback: number): number {
    const parsed = Number(this.configService.get<string>(key));
    return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
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
