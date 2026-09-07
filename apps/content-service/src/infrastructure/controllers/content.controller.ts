import { TranscriptSegment } from '@common/ai/interfaces/transcription-result.interface';
import { resolveReelPlaybackPresentation } from '@common/content/playback-presentation';
import { CreateReelDto } from '@common/content/dtos/create-reel.dto';
import { TrackReelEventPayload } from '@common/content/dtos/track-reel-events.dto';
import type { ReelPipelineMetricContext } from '@common/processing/interfaces/reel-pipeline-metric.interface';
import type { ReelMediaOutput } from '@common/processing/interfaces/reel-media-output.interface';
import type { ReelContextAccessRequest } from '@common/content/interfaces/reel-context-search-request.interface';
import { ClaimReelProcessingAttemptUseCase } from '@content/application/use-cases/claim-reel-processing-attempt.use-case';
import { ClaimReelIndexingAttemptUseCase } from '@content/application/use-cases/claim-reel-indexing-attempt.use-case';
import { CompleteReelIndexingUseCase } from '@content/application/use-cases/complete-reel-indexing.use-case';
import { CompleteReelMediaProcessingUseCase } from '@content/application/use-cases/complete-reel-media-processing.use-case';
import { CreateReelShareLinkUseCase } from '@content/application/use-cases/create-reel-share-link.use-case';
import { DeleteReelUseCase } from '@content/application/use-cases/delete-reel.use-case';
import { GetFriendsReelsUseCase } from '@content/application/use-cases/get-friends-reels.use-case';
import { FailReelIndexingUseCase } from '@content/application/use-cases/fail-reel-indexing.use-case';
import { GetProfileReelContextUseCase } from '@content/application/use-cases/get-profile-reel-context.use-case';
import { GetRecommendedReelsUseCase } from '@content/application/use-cases/get-recommended-reels.use-case';
import { GetReelStatusUseCase } from '@content/application/use-cases/get-reel-status.use-case';
import { GetReelUseCase } from '@content/application/use-cases/get-reel.use-case';
import { GetSearchSuggestionsUseCase } from '@content/application/use-cases/get-search-suggestions.use-case';
import { ListReelsUseCase } from '@content/application/use-cases/list-reels.use-case';
import { ReprocessReelUseCase } from '@content/application/use-cases/reprocess-reel.use-case';
import { ReindexReelUseCase } from '@content/application/use-cases/reindex-reel.use-case';
import { ReportReelIndexingProgressUseCase } from '@content/application/use-cases/report-reel-indexing-progress.use-case';
import { ResolveReelShareLinkUseCase } from '@content/application/use-cases/resolve-reel-share-link.use-case';
import { ResolveReelContextAccessUseCase } from '@content/application/use-cases/resolve-reel-context-access.use-case';
import { RevokeReelShareLinkUseCase } from '@content/application/use-cases/revoke-reel-share-link.use-case';
import { SearchPublicReelsUseCase } from '@content/application/use-cases/search-public-reels.use-case';
import { ShareReelUseCase } from '@content/application/use-cases/share-reel.use-case';
import { TrackReelEventsUseCase } from '@content/application/use-cases/track-reel-events.use-case';
import { UpdateReelStatusUseCase } from '@content/application/use-cases/update-reel-status.use-case';
import { UpdateReelIndexStatusUseCase } from '@content/application/use-cases/update-reel-index-status.use-case';
import { UpdateReelMediaStatusUseCase } from '@content/application/use-cases/update-reel-media-status.use-case';
import { UpdateReelUseCase } from '@content/application/use-cases/update-reel.use-case';
import { ReelShareLink } from '@content/domain/entities/reel-share-link.entity';
import { Reel } from '@content/domain/entities/reel.entity';
import {
  InvalidMediaFileError,
  ReelAlreadyProcessingError,
  ReelNotFoundError,
  ReelReprocessForbiddenError,
} from '@content/domain/errors/content.error';
import {
  ReelListQuery,
  ReelProcessingMediaMetadata,
  ReelUpdateData,
} from '@content/domain/interfaces/content.repository.interface';
import { Controller, Logger } from '@nestjs/common';
import {
  EventPattern,
  MessagePattern,
  Payload,
  RpcException,
} from '@nestjs/microservices';
import { CreateReelUseCase } from '../../application/use-cases/create-reel.use-case';

@Controller()
export class ContentController {
  private readonly logger = new Logger(ContentController.name);

  constructor(
    private readonly createReelUseCase: CreateReelUseCase,
    private readonly listReelsUseCase: ListReelsUseCase,
    private readonly getRecommendedReelsUseCase: GetRecommendedReelsUseCase,
    private readonly getReelUseCase: GetReelUseCase,
    private readonly getProfileReelContextUseCase: GetProfileReelContextUseCase,
    private readonly updateReelUseCase: UpdateReelUseCase,
    private readonly deleteReelUseCase: DeleteReelUseCase,
    private readonly updateReelStatusUseCase: UpdateReelStatusUseCase,
    private readonly getReelStatusUseCase: GetReelStatusUseCase,
    private readonly resolveReelContextAccessUseCase: ResolveReelContextAccessUseCase,
    private readonly shareReelUseCase: ShareReelUseCase,
    private readonly createReelShareLinkUseCase: CreateReelShareLinkUseCase,
    private readonly resolveReelShareLinkUseCase: ResolveReelShareLinkUseCase,
    private readonly revokeReelShareLinkUseCase: RevokeReelShareLinkUseCase,
    private readonly trackReelEventsUseCase: TrackReelEventsUseCase,
    private readonly reprocessReelUseCase: ReprocessReelUseCase,
    private readonly reindexReelUseCase: ReindexReelUseCase,
    private readonly claimReelProcessingAttemptUseCase: ClaimReelProcessingAttemptUseCase,
    private readonly claimReelIndexingAttemptUseCase: ClaimReelIndexingAttemptUseCase,
    private readonly completeReelIndexingUseCase: CompleteReelIndexingUseCase,
    private readonly failReelIndexingUseCase: FailReelIndexingUseCase,
    private readonly reportReelIndexingProgressUseCase: ReportReelIndexingProgressUseCase,
    private readonly completeReelMediaProcessingUseCase: CompleteReelMediaProcessingUseCase,
    private readonly updateReelMediaStatusUseCase: UpdateReelMediaStatusUseCase,
    private readonly updateReelIndexStatusUseCase: UpdateReelIndexStatusUseCase,
    private readonly searchPublicReelsUseCase: SearchPublicReelsUseCase,
    private readonly getSearchSuggestionsUseCase: GetSearchSuggestionsUseCase,
    private readonly getFriendsReelsUseCase: GetFriendsReelsUseCase,
  ) {}

  private toSerializable(reel: Reel): Record<string, unknown> {
    return {
      id: reel.id,
      userId: reel.userId,
      mediaKey: reel.mediaKey,
      title: reel.title,
      description: reel.description,
      tags: reel.tags,
      status: reel.status,
      mediaStatus: reel.mediaStatus,
      indexStatus: reel.indexStatus,
      visibility: reel.visibility,
      viewCount: Number(reel.viewCount),
      thumbnailKey: reel.thumbnailKey,
      hlsMasterKey: reel.hlsMasterKey,
      transcriptionAudioManifestKey: reel.transcriptionAudioManifestKey,
      processingStage: reel.processingStage,
      processingMessage: reel.processingMessage,
      processingProgress: reel.processingProgress,
      durationMs: reel.outputDurationMs ?? reel.sourceDurationMs,
      outputDurationMs: reel.outputDurationMs,
      transcript: reel.transcript,
      transcriptVtt: reel.transcriptVtt,
      transcriptSegments: reel.transcriptSegments,
      createdAt: reel.createdAt,
      updatedAt: reel.updatedAt,
      processingAttemptId: reel.processingAttemptId,
      processingStartedAt: reel.processingStartedAt,
      processingFailedAt: reel.processingFailedAt,
      processingCompletedAt: reel.processingCompletedAt,
      processingErrorCode: reel.processingErrorCode,
      mediaAttemptId: reel.mediaAttemptId,
      indexAttemptId: reel.indexAttemptId,
      mediaEdit: reel.mediaEdit,
      sourceDurationMs: reel.sourceDurationMs,
      sourceWidth: reel.sourceWidth,
      sourceHeight: reel.sourceHeight,
      sourceFps: reel.sourceFps,
      sourceBitrateKbps: reel.sourceBitrateKbps,
      sourceHasAudio: reel.sourceHasAudio,
      sourceRotation: reel.sourceRotation,
      sourceOrientation: reel.sourceOrientation,
      sourceLengthClass: reel.sourceLengthClass,
      playbackPresentation: resolveReelPlaybackPresentation({
        mediaEdit: reel.mediaEdit,
        sourceOrientation: reel.sourceOrientation,
        sourceLengthClass: reel.sourceLengthClass,
      }),
      sourceAspectRatio: reel.sourceAspectRatio,
      sourceEffectiveWidth: reel.sourceEffectiveWidth,
      sourceEffectiveHeight: reel.sourceEffectiveHeight,
      encodedVariantCount: reel.encodedVariantCount,
      encodedMaxHeight: reel.encodedMaxHeight,
      encodedFps: reel.encodedFps,
      recommendation: reel.recommendation,
    };
  }

  private serializeCursor(
    cursor: {
      createdAt: Date;
      id: string;
    } | null,
  ): string | null {
    return cursor ? `${cursor.createdAt.toISOString()}|${cursor.id}` : null;
  }

  private serializeShareLink(link: ReelShareLink) {
    return {
      id: link.id,
      reelId: link.reelId,
      ownerId: link.ownerId,
      token: link.token,
      createdBy: link.createdBy,
      expiresAt: link.expiresAt?.toISOString() ?? null,
      revokedAt: link.revokedAt?.toISOString() ?? null,
      clickCount: Number(link.clickCount),
      createdAt: link.createdAt.toISOString(),
      updatedAt: link.updatedAt.toISOString(),
    };
  }

  private toExternalShareReelSerializable(reel: Reel): Record<string, unknown> {
    return {
      id: reel.id,
      userId: reel.userId,
      mediaKey: reel.mediaKey,
      title: reel.title,
      description: reel.description,
      tags: reel.tags,
      status: reel.status,
      mediaStatus: reel.mediaStatus,
      indexStatus: reel.indexStatus,
      visibility: reel.visibility,
      thumbnailKey: reel.thumbnailKey,
      hlsMasterKey: reel.hlsMasterKey,
      createdAt: reel.createdAt,
      updatedAt: reel.updatedAt,
    };
  }

  @MessagePattern('content.create_reel')
  async createReel(
    @Payload() data: { userId: string; payload: CreateReelDto },
  ) {
    try {
      const reel = await this.createReelUseCase.execute(
        data.userId,
        data.payload,
      );
      return this.toSerializable(reel);
    } catch (error) {
      if (error instanceof InvalidMediaFileError) {
        throw new RpcException({
          statusCode: 400,
          message: error.message,
          error: 'Bad Request',
        });
      }

      throw new RpcException({
        statusCode: 500,
        message:
          error instanceof Error
            ? error.message
            : 'An unexpected error occurred while creating the reel',
        error: 'Internal Server Error',
      });
    }
  }

  @EventPattern('reel.processing_completed')
  async handleProcessingCompleted(
    @Payload()
    data: {
      reelId: string;
      status: 'COMPLETED';
      processingAttemptId?: string;
      title?: string;
      description?: string;
      tags?: string[];
      transcript?: string;
      transcriptVtt?: string;
      transcriptSegments?: TranscriptSegment[];
      thumbnailKey?: string;
      stage?: string;
      message?: string;
      progress?: number;
      mediaMetadata?: ReelProcessingMediaMetadata;
      metricsContext?: ReelPipelineMetricContext;
    },
  ) {
    const persistenceStartedAt = Date.now();
    const metricsContext = this.resolveMetricsContext(data);

    try {
      await this.updateReelStatusUseCase.execute(
        data.reelId,
        data.status,
        data.transcript,
        data.transcriptVtt,
        data.transcriptSegments,
        data.thumbnailKey,
        data.stage,
        data.message,
        data.progress,
        data.title,
        data.description,
        data.tags,
        data.processingAttemptId,
        undefined,
        undefined,
        data.mediaMetadata,
      );
      this.logPersistenceMetric(
        metricsContext,
        true,
        Date.now() - persistenceStartedAt,
      );
    } catch (err: unknown) {
      this.logPersistenceMetric(
        metricsContext,
        false,
        Date.now() - persistenceStartedAt,
        'DATABASE_PERSISTENCE',
      );
      const error = err as Error;

      console.error(
        `[processing_completed] ${error.message} — rolling reel ${data.reelId} back to FAILED`,
      );

      try {
        await this.updateReelStatusUseCase.execute(
          data.reelId,
          'FAILED',
          undefined,
          undefined,
          undefined,
          undefined,
          'FAILED',
          'Video processing failed',
          data.progress,
          undefined,
          undefined,
          undefined,
          data.processingAttemptId,
          'PROCESSING_COMPLETED_HANDLER_FAILED',
          error.message,
        );
      } catch (fallbackErr: unknown) {
        const fallbackError = fallbackErr as Error;

        console.error(
          `[processing_completed] could not set FAILED either for reel ${data.reelId}: ${fallbackError.message}`,
        );
      }
    }
  }

  @MessagePattern('content.persist_reel_processing_completed')
  async persistProcessingCompleted(
    @Payload()
    data: {
      reelId: string;
      status: 'COMPLETED';
      processingAttemptId?: string;
      title?: string;
      description?: string;
      tags?: string[];
      transcript?: string;
      transcriptVtt?: string;
      transcriptSegments?: TranscriptSegment[];
      thumbnailKey?: string;
      stage?: string;
      message?: string;
      progress?: number;
      mediaMetadata?: ReelProcessingMediaMetadata;
      metricsContext?: ReelPipelineMetricContext;
    },
  ) {
    const persistenceStartedAt = Date.now();
    const metricsContext = this.resolveMetricsContext(data);

    try {
      await this.updateReelStatusUseCase.execute(
        data.reelId,
        data.status,
        data.transcript,
        data.transcriptVtt,
        data.transcriptSegments,
        data.thumbnailKey,
        data.stage,
        data.message,
        data.progress,
        data.title,
        data.description,
        data.tags,
        data.processingAttemptId,
        undefined,
        undefined,
        data.mediaMetadata,
      );
      this.logPersistenceMetric(
        metricsContext,
        true,
        Date.now() - persistenceStartedAt,
      );

      return { persisted: true };
    } catch (error: unknown) {
      this.logPersistenceMetric(
        metricsContext,
        false,
        Date.now() - persistenceStartedAt,
        'DATABASE_PERSISTENCE',
      );
      throw error;
    }
  }

  @MessagePattern('content.persist_reel_media_completed')
  async persistMediaCompleted(
    @Payload()
    data: {
      reelId: string;
      processingAttemptId: string;
      mediaMetadata: ReelProcessingMediaMetadata;
      mediaOutput: ReelMediaOutput;
    },
  ) {
    const applied = await this.completeReelMediaProcessingUseCase.execute({
      reelId: data.reelId,
      mediaAttemptId: data.processingAttemptId,
      mediaMetadata: data.mediaMetadata,
      mediaOutput: data.mediaOutput,
    });

    return { persisted: true, applied };
  }

  @MessagePattern('content.update_reel_media_status')
  async updateMediaStatus(
    @Payload()
    data: Parameters<UpdateReelMediaStatusUseCase['execute']>[0],
  ) {
    return {
      applied: await this.updateReelMediaStatusUseCase.execute(data),
    };
  }

  @MessagePattern('content.update_reel_index_status')
  async updateIndexStatus(
    @Payload()
    data: Parameters<UpdateReelIndexStatusUseCase['execute']>[0],
  ) {
    return {
      applied: await this.updateReelIndexStatusUseCase.execute(data),
    };
  }

  @EventPattern('reel.processing_failed')
  async handleProcessingFailed(
    @Payload()
    data: {
      reelId: string;
      status: 'FAILED';
      stage?: string;
      message?: string;
      progress?: number;
      processingAttemptId?: string;
      errorCode?: string;
      errorDetail?: string;
      mediaMetadata?: ReelProcessingMediaMetadata;
      metricsContext?: ReelPipelineMetricContext;
    },
  ) {
    const persistenceStartedAt = Date.now();
    const metricsContext = this.resolveMetricsContext(data);

    try {
      await this.updateReelStatusUseCase.execute(
        data.reelId,
        data.status,
        undefined,
        undefined,
        undefined,
        undefined,
        data.stage,
        data.message,
        data.progress,
        undefined,
        undefined,
        undefined,
        data.processingAttemptId,
        data.errorCode,
        data.errorDetail,
        data.mediaMetadata,
      );
      this.logPersistenceMetric(
        metricsContext,
        true,
        Date.now() - persistenceStartedAt,
      );
    } catch (err: unknown) {
      this.logPersistenceMetric(
        metricsContext,
        false,
        Date.now() - persistenceStartedAt,
        'DATABASE_PERSISTENCE',
      );
      const error = err as Error;

      console.error(
        `[processing_failed] ${error.message} — reel ${data.reelId} NOT updated to FAILED`,
      );
    }
  }

  @MessagePattern('content.persist_reel_processing_failed')
  async persistProcessingFailed(
    @Payload()
    data: {
      reelId: string;
      status: 'FAILED';
      stage?: string;
      message?: string;
      progress?: number;
      processingAttemptId?: string;
      errorCode?: string;
      errorDetail?: string;
      mediaMetadata?: ReelProcessingMediaMetadata;
      metricsContext?: ReelPipelineMetricContext;
    },
  ) {
    const persistenceStartedAt = Date.now();
    const metricsContext = this.resolveMetricsContext(data);

    try {
      await this.updateReelStatusUseCase.execute(
        data.reelId,
        data.status,
        undefined,
        undefined,
        undefined,
        undefined,
        data.stage,
        data.message,
        data.progress,
        undefined,
        undefined,
        undefined,
        data.processingAttemptId,
        data.errorCode,
        data.errorDetail,
        data.mediaMetadata,
      );
      this.logPersistenceMetric(
        metricsContext,
        true,
        Date.now() - persistenceStartedAt,
      );

      return { persisted: true };
    } catch (error: unknown) {
      this.logPersistenceMetric(
        metricsContext,
        false,
        Date.now() - persistenceStartedAt,
        'DATABASE_PERSISTENCE',
      );
      throw error;
    }
  }

  @MessagePattern('content.persist_reel_processing_retry_scheduled')
  async persistProcessingRetryScheduled(
    @Payload()
    data: {
      reelId: string;
      status: 'PENDING';
      stage: 'RETRY_SCHEDULED';
      message: string;
      progress: number;
      processingAttemptId: string;
    },
  ) {
    await this.updateReelStatusUseCase.execute(
      data.reelId,
      data.status,
      undefined,
      undefined,
      undefined,
      undefined,
      data.stage,
      data.message,
      data.progress,
      undefined,
      undefined,
      undefined,
      data.processingAttemptId,
    );

    return { persisted: true };
  }

  private resolveMetricsContext(data: {
    reelId: string;
    processingAttemptId?: string;
    metricsContext?: ReelPipelineMetricContext;
  }): ReelPipelineMetricContext {
    return (
      data.metricsContext ?? {
        reelId: data.reelId,
        processingAttemptId: data.processingAttemptId ?? 'UNKNOWN',
        mediaClass: 'UNKNOWN',
        orientation: 'UNKNOWN',
        retryNumber: 0,
      }
    );
  }

  private logPersistenceMetric(
    context: ReelPipelineMetricContext,
    success: boolean,
    durationMs: number,
    failureStage?: string,
  ): void {
    this.logger.log(
      JSON.stringify({
        event: 'reel_pipeline_metric',
        timestamp: new Date().toISOString(),
        reelId: context.reelId,
        processingAttemptId: context.processingAttemptId,
        stage: 'DATABASE_PERSISTENCE',
        mediaClass: context.mediaClass,
        orientation: context.orientation,
        success,
        durationMs: Math.max(0, Math.round(durationMs)),
        retryNumber: context.retryNumber,
        ...(failureStage ? { failureStage } : {}),
      }),
    );
  }

  @EventPattern('reel.processing_started')
  async handleProcessingStarted(
    @Payload()
    data: {
      reelId: string;
      status: 'PROCESSING';
      stage?: string;
      message?: string;
      progress?: number;
      processingAttemptId?: string;
    },
  ) {
    try {
      await this.updateReelStatusUseCase.execute(
        data.reelId,
        data.status,
        undefined,
        undefined,
        undefined,
        undefined,
        data.stage,
        data.message,
        data.progress,
        undefined,
        undefined,
        undefined,
        data.processingAttemptId,
      );
    } catch (err: unknown) {
      const error = err as Error;
      console.error(
        `[processing_started] ${error.message} — reel ${data.reelId} NOT updated to PROCESSING`,
      );
    }
  }

  @EventPattern('reel.processing_progress')
  async handleProcessingProgress(
    @Payload()
    data: {
      reelId: string;
      status: 'PROCESSING';
      stage?: string;
      message?: string;
      progress?: number;
      processingAttemptId?: string;
    },
  ) {
    try {
      await this.updateReelStatusUseCase.execute(
        data.reelId,
        data.status,
        undefined,
        undefined,
        undefined,
        undefined,
        data.stage,
        data.message,
        data.progress,
        undefined,
        undefined,
        undefined,
        data.processingAttemptId,
      );
    } catch (err: unknown) {
      const error = err as Error;
      console.error(
        `[processing_progress] ${error.message} — reel ${data.reelId} progress NOT updated`,
      );
    }
  }

  @MessagePattern('content.get_reel_status')
  async getReelStatus(@Payload() data: { reelId: string }) {
    try {
      return await this.getReelStatusUseCase.execute(data.reelId);
    } catch {
      throw new RpcException({
        statusCode: 404,
        message: 'Reel not found',
      });
    }
  }

  @MessagePattern('content.claim_reel_processing_attempt')
  async claimReelProcessingAttempt(
    @Payload()
    data: {
      reelId: string;
      processingAttemptId: string;
      allowReclaim?: boolean;
    },
  ) {
    if (
      !data ||
      typeof data.reelId !== 'string' ||
      data.reelId.trim().length === 0 ||
      typeof data.processingAttemptId !== 'string' ||
      data.processingAttemptId.trim().length === 0
    ) {
      return false;
    }

    return await this.claimReelProcessingAttemptUseCase.execute({
      reelId: data.reelId,
      processingAttemptId: data.processingAttemptId,
      allowReclaim: data.allowReclaim === true,
    });
  }

  @MessagePattern('content.claim_reel_indexing_attempt')
  async claimReelIndexingAttempt(
    @Payload()
    data: Parameters<ClaimReelIndexingAttemptUseCase['execute']>[0],
  ) {
    return await this.claimReelIndexingAttemptUseCase.execute(data);
  }

  @MessagePattern('content.persist_reel_indexing_progress')
  async persistReelIndexingProgress(
    @Payload()
    data: Parameters<ReportReelIndexingProgressUseCase['execute']>[0],
  ) {
    return {
      applied: await this.reportReelIndexingProgressUseCase.execute(data),
    };
  }

  @MessagePattern('content.persist_reel_index_completed')
  async persistReelIndexCompleted(
    @Payload()
    data: Parameters<CompleteReelIndexingUseCase['execute']>[0],
  ) {
    return { applied: await this.completeReelIndexingUseCase.execute(data) };
  }

  @MessagePattern('content.persist_reel_index_failed')
  async persistReelIndexFailed(
    @Payload()
    data: Parameters<FailReelIndexingUseCase['execute']>[0],
  ) {
    return { applied: await this.failReelIndexingUseCase.execute(data) };
  }

  @MessagePattern('content.reprocess_reel')
  async reprocessReel(
    @Payload()
    data: {
      reelId: string;
      userId: string;
      isAdmin?: boolean;
    },
  ) {
    if (
      !data ||
      typeof data.reelId !== 'string' ||
      data.reelId.trim().length === 0 ||
      typeof data.userId !== 'string' ||
      data.userId.trim().length === 0
    ) {
      throw new RpcException({
        statusCode: 400,
        message: 'Invalid payload for reel reprocessing',
      });
    }

    try {
      const reel = await this.reprocessReelUseCase.execute(
        data.reelId.trim(),
        data.userId.trim(),
        data.isAdmin === true,
      );

      return this.toSerializable(reel);
    } catch (error: unknown) {
      if (error instanceof ReelNotFoundError) {
        throw new RpcException({
          statusCode: 404,
          message: error.message,
        });
      }

      if (error instanceof ReelReprocessForbiddenError) {
        throw new RpcException({
          statusCode: 403,
          message: error.message,
        });
      }

      if (error instanceof ReelAlreadyProcessingError) {
        throw new RpcException({
          statusCode: 409,
          message: error.message,
        });
      }

      if (error instanceof InvalidMediaFileError) {
        throw new RpcException({
          statusCode: 400,
          message: error.message,
        });
      }

      const err = error as Error;

      throw new RpcException({
        statusCode: 500,
        message: `Reprocess Reel Error: ${err.message}`,
      });
    }
  }

  @MessagePattern('content.reindex_reel')
  async reindexReel(@Payload() data: { reelId: string }) {
    return await this.reindexReelUseCase.execute(data?.reelId);
  }

  @MessagePattern('content.resolve_reel_context_access')
  async resolveReelContextAccess(@Payload() payload: ReelContextAccessRequest) {
    if (
      !payload ||
      typeof payload.userId !== 'string' ||
      payload.userId.trim().length === 0 ||
      typeof payload.conversationId !== 'string' ||
      payload.conversationId.trim().length === 0
    ) {
      throw new RpcException({
        statusCode: 400,
        message: 'Invalid payload for reel context access',
      });
    }

    return await this.resolveReelContextAccessUseCase.execute(payload);
  }

  @MessagePattern('content.get_profile_reel_context')
  async getProfileReelContext(
    @Payload()
    data: {
      reelId: string;
      viewerId: string;
      before?: number;
      after?: number;
    },
  ) {
    if (
      !data ||
      typeof data.reelId !== 'string' ||
      data.reelId.trim().length === 0 ||
      typeof data.viewerId !== 'string' ||
      data.viewerId.trim().length === 0 ||
      (data.before !== undefined &&
        (!Number.isInteger(data.before) || data.before < 0)) ||
      (data.after !== undefined &&
        (!Number.isInteger(data.after) || data.after < 0))
    ) {
      throw new RpcException({
        statusCode: 400,
        message: 'Invalid payload for profile reel context',
      });
    }

    try {
      const context = await this.getProfileReelContextUseCase.execute(
        data.reelId.trim(),
        data.viewerId.trim(),
        data.before ?? 1,
        data.after ?? 5,
      );

      if (!context) {
        throw new RpcException({
          statusCode: 404,
          message: 'Reel not found',
        });
      }

      return {
        source: 'profile' as const,
        scope: {
          userId: context.anchorUserId,
          visibility: context.anchorVisibility,
        },
        selectedId: context.selectedId,
        selectedIndex: context.selectedIndex,
        items: context.items.map((item) => this.toSerializable(item)),
        previousCursor: this.serializeCursor(context.previousCursor),
        nextCursor: this.serializeCursor(context.nextCursor),
      };
    } catch (error: unknown) {
      if (error instanceof RpcException) {
        throw error;
      }

      const err = error as Error;

      throw new RpcException({
        statusCode: 500,
        message: `Get Profile Reel Context Error: ${err.message}`,
      });
    }
  }

  @MessagePattern('content.search_reels')
  async searchReels(
    @Payload()
    data: {
      query: string;
      viewerId?: string;
      limit?: number;
    },
  ) {
    if (
      !data ||
      typeof data.query !== 'string' ||
      data.query.trim().length === 0
    ) {
      return [];
    }

    const results = await this.searchPublicReelsUseCase.execute({
      query: data.query,
      viewerId: data.viewerId,
      limit: data.limit,
    });

    return results.map((result) => ({
      ...this.toSerializable(result.reel),
      searchScore: result.score,
    }));
  }

  @MessagePattern('content.get_search_suggestions')
  async getSearchSuggestions(
    @Payload()
    data: {
      viewerId?: string;
      type?: 'all' | 'users' | 'reels';
      limit?: number;
    },
  ) {
    const suggestions = await this.getSearchSuggestionsUseCase.execute({
      viewerId: data?.viewerId,
      type: data?.type ?? 'all',
      limit: data?.limit,
    });

    return { suggestions };
  }

  @MessagePattern('content.get_recommended_reels')
  async getRecommendedReels(
    @Payload()
    data: {
      viewerId: string;
      limit?: number;
      cursor?: {
        createdAt: string;
        id: string;
      };
      excludeRecentlySeen?: boolean;
      feedSessionId?: string;
      excludedUserIds?: string[];
    },
  ) {
    if (
      !data ||
      typeof data.viewerId !== 'string' ||
      data.viewerId.trim().length === 0
    ) {
      throw new RpcException({
        statusCode: 400,
        message: 'Invalid payload for recommended reels',
      });
    }

    const excludedUserIds = Array.isArray(data.excludedUserIds)
      ? [
          ...new Set(
            data.excludedUserIds
              .filter((id): id is string => typeof id === 'string')
              .map((id) => id.trim())
              .filter(Boolean),
          ),
        ]
      : [];

    try {
      const result = await this.getRecommendedReelsUseCase.execute({
        viewerId: data.viewerId.trim(),
        limit: data.limit,
        cursor: data.cursor
          ? {
              createdAt: new Date(data.cursor.createdAt),
              id: data.cursor.id,
            }
          : undefined,
        excludeRecentlySeen: data.excludeRecentlySeen,
        feedSessionId: data.feedSessionId,
        excludedUserIds,
      });

      return {
        items: result.items.map((item) => this.toSerializable(item)),
        nextCursor: this.serializeCursor(result.nextCursor),
        feedSessionId: result.feedSessionId,
        algorithmVersion: result.algorithmVersion,
        generatedAt: result.generatedAt,
      };
    } catch (error: unknown) {
      const err = error as Error;

      throw new RpcException({
        statusCode: 500,
        message: `Recommended Reels Error: ${err.message}`,
      });
    }
  }

  @MessagePattern('content.list_reels')
  async listReels(
    @Payload()
    data: {
      userId?: string;
      viewerId?: string;
      visibility?: 'public' | 'private';
      limit?: number;
      cursor?: { createdAt: string; id: string };
      onlyPublished?: boolean;
      ranked?: boolean;
    },
  ) {
    try {
      const query: ReelListQuery = {
        userId: data.userId,
        viewerId: data.viewerId,
        visibility: data.visibility,
        limit: data.limit ?? 20,
        cursor: data.cursor
          ? {
              createdAt: new Date(data.cursor.createdAt),
              id: data.cursor.id,
            }
          : undefined,
        onlyPublished: data.onlyPublished,
        ranked: data.ranked,
      };

      const result = await this.listReelsUseCase.execute(query);
      return {
        items: result.items.map((r) => this.toSerializable(r)),
        nextCursor: this.serializeCursor(result.nextCursor),
      };
    } catch (error: unknown) {
      const err = error as Error;
      throw new RpcException({
        statusCode: 500,
        message: `List Reels Error: ${err.message}`,
      });
    }
  }

  @MessagePattern('content.get_reel')
  async getReel(
    @Payload()
    data: {
      reelId: string;
      viewerId: string;
      isAdmin?: boolean;
    },
  ) {
    try {
      const reel = await this.getReelUseCase.execute(
        data.reelId,
        data.viewerId,
        data.isAdmin === true,
      );

      if (!reel) {
        throw new RpcException({
          statusCode: 404,
          message: 'Reel not found',
        });
      }

      return this.toSerializable(reel);
    } catch (error: unknown) {
      if (error instanceof RpcException) {
        throw error;
      }

      const err = error as Error;

      throw new RpcException({
        statusCode: 500,
        message: `Get Reel Error: ${err.message}`,
      });
    }
  }

  @MessagePattern('content.update_reel')
  async updateReel(
    @Payload()
    data: {
      reelId: string;
      userId: string;
      payload: Partial<ReelUpdateData>;
    },
  ) {
    try {
      const reel = await this.updateReelUseCase.execute(
        data.reelId,
        data.payload,
        data.userId,
      );
      if (!reel) {
        throw new RpcException({
          statusCode: reel === null ? 404 : 403,
          message:
            reel === null ? 'Reel not found' : 'Forbidden — not the owner',
        });
      }
      return this.toSerializable(reel);
    } catch (error: unknown) {
      if (error instanceof RpcException) throw error;
      const err = error as Error;
      throw new RpcException({
        statusCode: 500,
        message: `Update Reel Error: ${err.message}`,
      });
    }
  }

  @MessagePattern('content.delete_reel')
  async deleteReel(@Payload() data: { reelId: string; userId: string }) {
    try {
      const deleted = await this.deleteReelUseCase.execute(
        data.reelId,
        data.userId,
      );
      if (!deleted) {
        throw new RpcException({
          statusCode: 404,
          message: 'Reel not found or not owned by user',
        });
      }
      return { success: true };
    } catch (error: unknown) {
      if (error instanceof RpcException) throw error;
      const err = error as Error;
      throw new RpcException({
        statusCode: 500,
        message: `Delete Reel Error: ${err.message}`,
      });
    }
  }

  @MessagePattern('content.share_reel')
  async shareReel(
    @Payload()
    payload: {
      reelId: string;
      sharedByUserId: string;
      conversationId: string;
      sharedWithUserId?: string;
    },
  ) {
    if (
      !payload ||
      typeof payload.reelId !== 'string' ||
      payload.reelId.trim().length === 0 ||
      typeof payload.sharedByUserId !== 'string' ||
      payload.sharedByUserId.trim().length === 0 ||
      typeof payload.conversationId !== 'string' ||
      payload.conversationId.trim().length === 0 ||
      (payload.sharedWithUserId !== undefined &&
        (typeof payload.sharedWithUserId !== 'string' ||
          payload.sharedWithUserId.trim().length === 0))
    ) {
      throw new RpcException({
        statusCode: 400,
        message: 'Invalid payload for reel sharing',
      });
    }

    try {
      return await this.shareReelUseCase.execute({
        reelId: payload.reelId.trim(),
        sharedByUserId: payload.sharedByUserId.trim(),
        conversationId: payload.conversationId.trim(),
        sharedWithUserId: payload.sharedWithUserId?.trim(),
      });
    } catch (error: unknown) {
      const err = error as Error;

      if (err.name === 'ReelNotFoundError') {
        throw new RpcException({
          statusCode: 404,
          message: err.message,
        });
      }

      if (err.name === 'ReelNotReadyError') {
        throw new RpcException({
          statusCode: 409,
          message: err.message,
        });
      }

      if (err.name === 'ReelShareForbiddenError') {
        throw new RpcException({
          statusCode: 403,
          message: err.message,
        });
      }

      throw new RpcException({
        statusCode: 500,
        message: `Reel Share Error: ${err.message}`,
      });
    }
  }

  @MessagePattern('content.create_reel_share_link')
  async createReelShareLink(
    @Payload()
    payload: {
      reelId: string;
      createdBy: string;
      expiresInDays?: number;
      reuseExisting?: boolean;
    },
  ) {
    if (
      !payload ||
      typeof payload.reelId !== 'string' ||
      payload.reelId.trim().length === 0 ||
      typeof payload.createdBy !== 'string' ||
      payload.createdBy.trim().length === 0 ||
      (payload.expiresInDays !== undefined &&
        (!Number.isInteger(payload.expiresInDays) ||
          payload.expiresInDays < 1 ||
          payload.expiresInDays > 365))
    ) {
      throw new RpcException({
        statusCode: 400,
        message: 'Invalid payload for reel share link creation',
      });
    }

    try {
      const link = await this.createReelShareLinkUseCase.execute({
        reelId: payload.reelId.trim(),
        createdBy: payload.createdBy.trim(),
        expiresInDays: payload.expiresInDays,
        reuseExisting: payload.reuseExisting,
      });

      return this.serializeShareLink(link);
    } catch (error: unknown) {
      const err = error as Error;

      if (err.name === 'ReelNotFoundError') {
        throw new RpcException({
          statusCode: 404,
          message: err.message,
        });
      }

      if (err.name === 'ReelNotReadyError') {
        throw new RpcException({
          statusCode: 409,
          message: err.message,
        });
      }

      if (err.name === 'ReelShareForbiddenError') {
        throw new RpcException({
          statusCode: 403,
          message: err.message,
        });
      }

      throw new RpcException({
        statusCode: 500,
        message: `Create Reel Share Link Error: ${err.message}`,
      });
    }
  }

  @MessagePattern('content.resolve_reel_share_link')
  async resolveReelShareLink(@Payload() payload: { token: string }) {
    if (
      !payload ||
      typeof payload.token !== 'string' ||
      payload.token.trim().length === 0
    ) {
      throw new RpcException({
        statusCode: 400,
        message: 'Invalid payload for reel share link resolution',
      });
    }

    try {
      const result = await this.resolveReelShareLinkUseCase.execute({
        token: payload.token.trim(),
      });

      return {
        link: this.serializeShareLink(result.link),
        reel: this.toExternalShareReelSerializable(result.reel),
      };
    } catch (error: unknown) {
      const err = error as Error;

      if (err.name === 'ReelShareLinkNotFoundError') {
        throw new RpcException({
          statusCode: 404,
          message: err.message,
        });
      }

      if (
        err.name === 'ReelShareLinkExpiredError' ||
        err.name === 'ReelShareLinkRevokedError'
      ) {
        throw new RpcException({
          statusCode: 410,
          message: err.message,
        });
      }

      if (err.name === 'ReelNotReadyError') {
        throw new RpcException({
          statusCode: 409,
          message: err.message,
        });
      }

      if (err.name === 'ReelShareForbiddenError') {
        throw new RpcException({
          statusCode: 403,
          message: err.message,
        });
      }

      throw new RpcException({
        statusCode: 500,
        message: `Resolve Reel Share Link Error: ${err.message}`,
      });
    }
  }

  @MessagePattern('content.revoke_reel_share_link')
  async revokeReelShareLink(
    @Payload()
    payload: {
      token: string;
      revokedByUserId: string;
    },
  ) {
    if (
      !payload ||
      typeof payload.token !== 'string' ||
      payload.token.trim().length === 0 ||
      typeof payload.revokedByUserId !== 'string' ||
      payload.revokedByUserId.trim().length === 0
    ) {
      throw new RpcException({
        statusCode: 400,
        message: 'Invalid payload for reel share link revocation',
      });
    }

    try {
      const link = await this.revokeReelShareLinkUseCase.execute({
        token: payload.token.trim(),
        revokedByUserId: payload.revokedByUserId.trim(),
      });

      return this.serializeShareLink(link);
    } catch (error: unknown) {
      const err = error as Error;

      if (err.name === 'ReelShareLinkNotFoundError') {
        throw new RpcException({
          statusCode: 404,
          message: err.message,
        });
      }

      if (err.name === 'ReelShareForbiddenError') {
        throw new RpcException({
          statusCode: 403,
          message: err.message,
        });
      }

      throw new RpcException({
        statusCode: 500,
        message: `Revoke Reel Share Link Error: ${err.message}`,
      });
    }
  }

  @MessagePattern('content.track_reel_events')
  async trackReelEvents(
    @Payload()
    data: {
      userId: string;
      events: TrackReelEventPayload[];
    },
  ) {
    if (
      !data ||
      typeof data.userId !== 'string' ||
      data.userId.trim().length === 0 ||
      !Array.isArray(data.events) ||
      data.events.length === 0 ||
      data.events.length > 50
    ) {
      throw new RpcException({
        statusCode: 400,
        message: 'Invalid payload for reel event tracking',
      });
    }

    const result = await this.trackReelEventsUseCase.execute({
      userId: data.userId,
      events: data.events.map((event) => ({
        eventId: event.eventId,
        reelId: event.reelId,
        playbackSessionId: event.playbackSessionId,
        sequence: event.sequence,
        eventType: event.eventType,
        source: event.source,
        occurredAt: new Date(event.occurredAt),
        watchMs: event.watchMs,
        durationMs: event.durationMs,
        percentageWatched: event.percentageWatched,
        muted: event.muted,
        completed: event.completed,
        replayed: event.replayed,
        skipped: event.skipped,
        recommendation: event.recommendation
          ? {
              recommendationId: event.recommendation.recommendationId,
              feedSessionId: event.recommendation.feedSessionId,
              algorithmVersion: event.recommendation.algorithmVersion,
              candidateSource: event.recommendation.candidateSource,
              rank: event.recommendation.rank,
              generatedAt: new Date(event.recommendation.generatedAt),
            }
          : undefined,
      })),
    });

    return result;
  }

  @MessagePattern('content.get_friends_reels')
  async getFriendsReels(
    @Payload()
    data: {
      viewerId: string;
      limit?: number;
      cursor?: {
        createdAt: string;
        id: string;
      };
    },
  ) {
    if (
      !data ||
      typeof data.viewerId !== 'string' ||
      data.viewerId.trim().length === 0
    ) {
      throw new RpcException({
        statusCode: 400,
        message: 'Invalid friends reel feed payload',
      });
    }

    const result = await this.getFriendsReelsUseCase.execute({
      viewerId: data.viewerId.trim(),
      limit: data.limit,
      cursor: data.cursor
        ? {
            createdAt: new Date(data.cursor.createdAt),
            id: data.cursor.id,
          }
        : undefined,
    });

    return {
      items: result.items.map((reel) => this.toSerializable(reel)),
      nextCursor: this.serializeCursor(result.nextCursor),
    };
  }
}
