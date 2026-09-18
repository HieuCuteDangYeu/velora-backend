import { TranscriptSegment } from '@common/ai/interfaces/transcription-result.interface';
import type { CompleteReelIndexCommand } from '@common/processing/interfaces/complete-reel-index.interface';
import {
  REEL_INDEX_JOB_EVENT_TYPE,
  REEL_INDEX_JOB_SCHEMA_VERSION,
  type ReelIndexJob,
} from '@common/processing/interfaces/reel-index-job.interface';
import type { ReelMediaOutput } from '@common/processing/interfaces/reel-media-output.interface';
import { ReelSeries } from '@content/domain/entities/reel-series.entity';
import { ReelShareLink } from '@content/domain/entities/reel-share-link.entity';
import { ReelShare } from '@content/domain/entities/reel-share.entity';
import { mapReelLegacyStatus } from '@content/domain/reel-status-compatibility.mapper';
import { Injectable, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Prisma, PrismaClient } from '@prisma/content-client';
import { randomUUID } from 'crypto';
import { Reel } from '../../domain/entities/reel.entity';
import {
  FriendsReelsQuery,
  IContentRepository,
  RecommendedReelsQuery,
  ReelCursor,
  ReelListQuery,
  ReelMediaOutboxEventInput,
  ReelProcessingMediaMetadata,
  ReelProfileContextQuery,
  ReelProfileContextResult,
  ReelSeriesCreateData,
  ReelSeriesListQuery,
  ReelSeriesUpdateData,
  ReelShareCreateInput,
  ReelShareLinkCreateInput,
  ReelShareLinkWithReel,
  ReelUpdateData,
  SearchSuggestion,
  SearchSuggestionsQuery,
} from '../../domain/interfaces/content.repository.interface';
import { ReelFeedRepository } from './reel-feed.repository';
import { toReelDomain } from './reel-record.mapper';
import { ReelSeriesRepository } from './reel-series.repository';

@Injectable()
export class ContentRepository
  extends PrismaClient
  implements OnModuleInit, IContentRepository
{
  constructor(
    private readonly configService: ConfigService,
    private readonly reelSeriesRepository: ReelSeriesRepository,
    private readonly reelFeedRepository: ReelFeedRepository,
  ) {
    super();
  }

  async onModuleInit() {
    await this.$connect();
  }

  async onModuleDestroy() {
    await this.$disconnect();
  }

  private toMediaMetadataData(
    metadata: ReelProcessingMediaMetadata,
  ): Record<string, unknown> {
    const data: Record<string, unknown> = {};

    for (const key of [
      'sourceDurationMs',
      'outputDurationMs',
      'sourceWidth',
      'sourceHeight',
      'sourceFps',
      'sourceBitrateKbps',
      'sourceHasAudio',
      'sourceRotation',
      'sourceOrientation',
      'sourceLengthClass',
      'sourceAspectRatio',
      'sourceEffectiveWidth',
      'sourceEffectiveHeight',
      'encodedVariantCount',
      'encodedMaxHeight',
      'encodedFps',
    ] as const) {
      if (metadata[key] !== undefined) {
        data[key] = metadata[key];
      }
    }

    return data;
  }

  async createReelWithMediaJob(
    reel: Partial<Reel>,
    outboxEvent: ReelMediaOutboxEventInput,
  ): Promise<Reel> {
    const savedRecord = await this.$transaction(async (transaction) => {
      const record = await transaction.reel.create({
        data: {
          id: reel.id,
          userId: reel.userId!,
          mediaKey: reel.mediaKey!,
          title: reel.title,
          description: reel.description,
          tags: reel.tags || [],
          status: reel.status || 'PENDING',
          mediaStatus: reel.mediaStatus || 'PENDING',
          indexStatus: reel.indexStatus || 'NOT_REQUESTED',
          visibility: reel.visibility || 'public',
          processingStage: reel.processingStage,
          processingMessage: reel.processingMessage,
          processingProgress: reel.processingProgress,
          processingAttemptId: reel.processingAttemptId,
          processingStartedAt: reel.processingStartedAt,
          processingFailedAt: reel.processingFailedAt,
          processingCompletedAt: reel.processingCompletedAt,
          processingErrorCode: reel.processingErrorCode,
          processingErrorDetail: reel.processingErrorDetail,
          mediaAttemptId: reel.mediaAttemptId,
          indexAttemptId: reel.indexAttemptId,
          mediaEdit: reel.mediaEdit as unknown as Prisma.InputJsonValue,
          outputDurationMs: reel.outputDurationMs,
          sourceDurationMs: reel.sourceDurationMs,
          sourceWidth: reel.sourceWidth,
          sourceHeight: reel.sourceHeight,
          sourceFps: reel.sourceFps,
          sourceBitrateKbps: reel.sourceBitrateKbps,
          sourceHasAudio: reel.sourceHasAudio,
          sourceRotation: reel.sourceRotation,
          sourceOrientation: reel.sourceOrientation,
          sourceLengthClass: reel.sourceLengthClass,
          sourceAspectRatio: reel.sourceAspectRatio,
          sourceEffectiveWidth: reel.sourceEffectiveWidth,
          sourceEffectiveHeight: reel.sourceEffectiveHeight,
          encodedVariantCount: reel.encodedVariantCount,
          encodedMaxHeight: reel.encodedMaxHeight,
          encodedFps: reel.encodedFps,
        },
      });

      await transaction.outboxEvent.create({
        data: {
          id: outboxEvent.id,
          aggregateType: 'REEL',
          aggregateId: record.id,
          eventType: outboxEvent.eventType,
          payload: outboxEvent.payload as unknown as Prisma.InputJsonValue,
          createdAt: outboxEvent.createdAt,
          nextAttemptAt: outboxEvent.createdAt,
        },
      });

      return record;
    });

    return toReelDomain(savedRecord);
  }

  async queueReelProcessingAttemptWithMediaJob(
    reelId: string,
    mediaAttemptId: string,
    indexAttemptId: string,
    outboxEvent: ReelMediaOutboxEventInput,
  ): Promise<Reel> {
    const record = await this.$transaction(async (transaction) => {
      const queuedRecord = await transaction.reel.update({
        where: { id: reelId },
        data: {
          status: 'PENDING',
          mediaStatus: 'PENDING',
          indexStatus: 'NOT_REQUESTED',
          processingStage: 'QUEUED',
          processingMessage: 'Queued for processing',
          processingProgress: 0,
          processingAttemptId: mediaAttemptId,
          mediaAttemptId,
          indexAttemptId,
          processingStartedAt: null,
          processingFailedAt: null,
          processingCompletedAt: null,
          processingErrorCode: null,
          processingErrorDetail: null,
        },
      });

      await transaction.outboxEvent.create({
        data: {
          id: outboxEvent.id,
          aggregateType: 'REEL',
          aggregateId: reelId,
          eventType: outboxEvent.eventType,
          payload: outboxEvent.payload as unknown as Prisma.InputJsonValue,
          createdAt: outboxEvent.createdAt,
          nextAttemptAt: outboxEvent.createdAt,
        },
      });

      return queuedRecord;
    });

    return toReelDomain(record);
  }

  async claimProcessingAttempt(input: {
    reelId: string;
    processingAttemptId: string;
    allowReclaim?: boolean;
  }): Promise<boolean> {
    const result = await this.reel.updateMany({
      where: {
        id: input.reelId,
        mediaAttemptId: input.processingAttemptId,
        mediaStatus: input.allowReclaim
          ? { in: ['PENDING', 'PROCESSING'] }
          : 'PENDING',
      },
      data: {
        status: 'PROCESSING',
        mediaStatus: 'PROCESSING',
        processingStage: 'PROCESSING',
        processingMessage: 'Video is being processed',
        processingProgress: 10,
        processingStartedAt: new Date(),
        processingFailedAt: null,
        processingCompletedAt: null,
        processingErrorCode: null,
        processingErrorDetail: null,
      },
    });

    return result.count > 0;
  }

  async completeMediaProcessing(input: {
    reelId: string;
    mediaAttemptId: string;
    mediaMetadata: ReelProcessingMediaMetadata;
    mediaOutput: ReelMediaOutput;
  }): Promise<boolean> {
    return await this.$transaction(async (transaction) => {
      const completedAt = new Date();
      const result = await transaction.reel.updateMany({
        where: {
          id: input.reelId,
          mediaAttemptId: input.mediaAttemptId,
          mediaStatus: { in: ['PROBING', 'PROCESSING'] },
        },
        data: {
          status: 'COMPLETED',
          mediaStatus: 'COMPLETED',
          indexStatus: 'PENDING',
          thumbnailKey: input.mediaOutput.thumbnailKey,
          hlsMasterKey: input.mediaOutput.hlsMasterKey,
          transcriptionAudioManifestKey:
            input.mediaOutput.transcriptionAudioManifestKey,
          mediaOutput: input.mediaOutput as unknown as Prisma.InputJsonValue,
          processingStage: 'MEDIA_READY',
          processingMessage: 'Video is ready; indexing in progress',
          processingProgress: 90,
          processingCompletedAt: completedAt,
          processingFailedAt: null,
          processingErrorCode: null,
          processingErrorDetail: null,
          ...this.toMediaMetadataData(input.mediaMetadata),
        },
      });

      if (result.count === 0) return false;

      const reel = await transaction.reel.findUniqueOrThrow({
        where: { id: input.reelId },
      });

      if (!reel.indexAttemptId) {
        throw new Error(`Reel ${reel.id} has no index attempt ID`);
      }

      const jobId = randomUUID();
      const indexJob: ReelIndexJob = {
        jobId,
        reelId: reel.id,
        userId: reel.userId,
        mediaAttemptId: input.mediaAttemptId,
        indexAttemptId: reel.indexAttemptId,
        indexVersion:
          this.configService.get<string>('INDEX_VERSION')?.trim() ||
          'reel-index-v2',
        mediaKey: reel.mediaKey,
        transcriptionAudioManifestKey:
          input.mediaOutput.transcriptionAudioManifestKey,
        sourceDurationMs: input.mediaMetadata.sourceDurationMs!,
        outputDurationMs:
          input.mediaMetadata.outputDurationMs ??
          input.mediaMetadata.sourceDurationMs!,
        sourceHasAudio: input.mediaOutput.sourceHasAudio,
        sourceOrientation: input.mediaMetadata.sourceOrientation!,
        sourceLengthClass: input.mediaOutput.sourceLengthClass,
        title: reel.title ?? undefined,
        description: reel.description ?? undefined,
        tags: reel.tags,
        createdAt: completedAt.toISOString(),
        schemaVersion: REEL_INDEX_JOB_SCHEMA_VERSION,
      };

      await transaction.outboxEvent.create({
        data: {
          id: jobId,
          aggregateType: 'REEL',
          aggregateId: reel.id,
          eventType: REEL_INDEX_JOB_EVENT_TYPE,
          payload: indexJob as unknown as Prisma.InputJsonValue,
          createdAt: completedAt,
          nextAttemptAt: completedAt,
        },
      });

      return true;
    });
  }

  async updateMediaStatus(input: {
    reelId: string;
    mediaAttemptId: string;
    mediaStatus: Reel['mediaStatus'];
  }): Promise<boolean> {
    const current = await this.reel.findFirst({
      where: {
        id: input.reelId,
        mediaAttemptId: input.mediaAttemptId,
      },
      select: { indexStatus: true },
    });

    if (!current) {
      return false;
    }

    const result = await this.reel.updateMany({
      where: {
        id: input.reelId,
        mediaAttemptId: input.mediaAttemptId,
      },
      data: {
        mediaStatus: input.mediaStatus,
        status: mapReelLegacyStatus({
          mediaStatus: input.mediaStatus,
          indexStatus: current.indexStatus,
        }),
      },
    });

    return result.count > 0;
  }

  async updateIndexStatus(input: {
    reelId: string;
    indexAttemptId: string;
    indexStatus: Reel['indexStatus'];
  }): Promise<boolean> {
    const result = await this.reel.updateMany({
      where: {
        id: input.reelId,
        indexAttemptId: input.indexAttemptId,
        mediaStatus: 'COMPLETED',
      },
      data: { indexStatus: input.indexStatus },
    });

    return result.count > 0;
  }

  async claimIndexingAttempt(input: {
    reelId: string;
    indexAttemptId: string;
    allowReclaim?: boolean;
  }): Promise<boolean> {
    const result = await this.reel.updateMany({
      where: {
        id: input.reelId,
        indexAttemptId: input.indexAttemptId,
        mediaStatus: 'COMPLETED',
        indexStatus: input.allowReclaim
          ? { in: ['PENDING', 'PROCESSING'] }
          : 'PENDING',
      },
      data: {
        indexStatus: 'PROCESSING',
        processingStage: 'TRANSCRIBING_AUDIO_SEGMENTS',
        processingMessage: 'Video is ready; indexing in progress',
        processingProgress: 10,
        processingErrorCode: null,
        processingErrorDetail: null,
      },
    });
    return result.count > 0;
  }

  async reportIndexingProgress(input: {
    reelId: string;
    indexAttemptId: string;
    stage: string;
    progress: number;
  }): Promise<boolean> {
    const result = await this.reel.updateMany({
      where: {
        id: input.reelId,
        indexAttemptId: input.indexAttemptId,
        mediaStatus: 'COMPLETED',
        indexStatus: 'PROCESSING',
      },
      data: {
        processingStage: input.stage,
        processingMessage: 'Video is ready; indexing in progress',
        processingProgress: Math.min(
          100,
          Math.max(0, Math.round(input.progress)),
        ),
      },
    });
    return result.count > 0;
  }

  async completeIndexing(input: CompleteReelIndexCommand): Promise<boolean> {
    const transcriptSegmentsJson =
      input.transcriptSegments === undefined
        ? null
        : JSON.stringify(input.transcriptSegments);

    return await this.$transaction(async (transaction) => {
      const current = await transaction.reel.findFirst({
        where: {
          id: input.reelId,
          indexAttemptId: input.indexAttemptId,
          mediaStatus: 'COMPLETED',
        },
      });
      if (!current) return false;
      if (
        current.indexStatus === 'COMPLETED' ||
        current.indexStatus === 'DEGRADED'
      ) {
        return true;
      }
      if (current.indexStatus !== 'PROCESSING') return false;

      const result = await transaction.$executeRaw(Prisma.sql`
        UPDATE "Reel"
        SET
          "indexVersion" = ${input.indexVersion},
          "indexCompletedAt" = ${new Date(input.indexedAt)},
          "indexDocumentCount" = ${input.reelDocumentCount},
          "indexSectionCount" = ${input.sectionCount},
          "indexChunkCount" = ${input.chunkCount},
          "indexEmbeddingProvider" = ${input.embeddingProvider},
          "indexEmbeddingModel" = ${input.embeddingModel},
          "indexEmbeddingDimensions" = ${input.embeddingDimensions},
          "indexEmbeddingVersion" = ${input.embeddingVersion},
          "transcript" = CASE
            WHEN ${input.transcript !== undefined} THEN ${input.transcript ?? null}
            ELSE "transcript"
          END,
          "transcriptSegments" = CASE
            WHEN ${input.transcriptSegments !== undefined}
              THEN ${transcriptSegmentsJson}::jsonb
            ELSE "transcriptSegments"
          END,
          "indexStatus" = ${input.chunkCount > 0 ? 'COMPLETED' : 'DEGRADED'}::"ReelIndexStatus",
          "status" = 'COMPLETED'::"ProcessingStatus",
          "processingStage" = 'READY',
          "processingMessage" = 'Video is ready to watch',
          "processingProgress" = 100,
          "processingErrorCode" = NULL,
          "processingErrorDetail" = NULL,
          "updatedAt" = NOW()
        WHERE
          "id" = ${input.reelId}
          AND "indexAttemptId" = ${input.indexAttemptId}
          AND "mediaStatus" = 'COMPLETED'::"ReelMediaStatus"
          AND "indexStatus" = 'PROCESSING'::"ReelIndexStatus"
      `);
      if (result === 0) return false;

      return true;
    });
  }

  async failIndexing(input: {
    reelId: string;
    indexAttemptId: string;
    errorDetail: string;
  }): Promise<boolean> {
    const result = await this.reel.updateMany({
      where: {
        id: input.reelId,
        indexAttemptId: input.indexAttemptId,
        mediaStatus: 'COMPLETED',
        indexStatus: { in: ['PENDING', 'PROCESSING'] },
      },
      data: {
        status: 'COMPLETED',
        indexStatus: 'FAILED',
        processingStage: 'READY',
        processingMessage: 'Video is ready to watch',
        processingProgress: 100,
        processingFailedAt: new Date(),
        processingErrorCode: 'INDEXING_FAILED',
        processingErrorDetail: input.errorDetail.slice(0, 4000),
      },
    });
    return result.count > 0;
  }

  async queueReelIndexingAttempt(reelId: string): Promise<string | null> {
    return await this.$transaction(async (transaction) => {
      const reel = await transaction.reel.findFirst({
        where: { id: reelId, mediaStatus: 'COMPLETED' },
      });
      const mediaAttemptId = reel?.mediaAttemptId || reel?.processingAttemptId;
      if (
        !reel ||
        !mediaAttemptId ||
        !reel.sourceDurationMs ||
        !reel.sourceOrientation ||
        !reel.sourceLengthClass
      ) {
        return null;
      }

      const indexAttemptId = randomUUID();
      const result = await transaction.reel.updateMany({
        where: {
          id: reel.id,
          mediaStatus: 'COMPLETED',
          indexAttemptId: reel.indexAttemptId,
        },
        data: {
          indexAttemptId,
          indexStatus: 'PENDING',
          status: 'COMPLETED',
          processingStage: 'INDEX_QUEUED',
          processingMessage: 'Video is ready; indexing queued',
          processingProgress: 90,
          processingFailedAt: null,
          processingErrorCode: null,
          processingErrorDetail: null,
        },
      });
      if (result.count === 0) return null;

      const createdAt = new Date();
      const jobId = randomUUID();
      const indexJob: ReelIndexJob = {
        jobId,
        reelId: reel.id,
        userId: reel.userId,
        mediaAttemptId,
        indexAttemptId,
        indexVersion:
          this.configService.get<string>('INDEX_VERSION')?.trim() ||
          'reel-index-v2',
        mediaKey: reel.mediaKey,
        transcriptionAudioManifestKey:
          reel.transcriptionAudioManifestKey ?? undefined,
        sourceDurationMs: reel.sourceDurationMs,
        outputDurationMs: reel.outputDurationMs ?? reel.sourceDurationMs,
        sourceHasAudio: reel.sourceHasAudio ?? undefined,
        sourceOrientation: reel.sourceOrientation,
        sourceLengthClass: reel.sourceLengthClass,
        title: reel.title ?? undefined,
        description: reel.description ?? undefined,
        tags: reel.tags,
        createdAt: createdAt.toISOString(),
        schemaVersion: REEL_INDEX_JOB_SCHEMA_VERSION,
      };
      await transaction.outboxEvent.create({
        data: {
          id: jobId,
          aggregateType: 'REEL',
          aggregateId: reel.id,
          eventType: REEL_INDEX_JOB_EVENT_TYPE,
          payload: indexJob as unknown as Prisma.InputJsonValue,
          createdAt,
          nextAttemptAt: createdAt,
        },
      });
      return indexAttemptId;
    });
  }

  async updateReelStatus(
    id: string,
    status: 'PENDING' | 'PROCESSING' | 'COMPLETED' | 'FAILED',
    transcript?: string,
    transcriptVtt?: string,
    transcriptSegments?: TranscriptSegment[],
    thumbnailKey?: string,
    processingStage?: string,
    processingMessage?: string,
    processingProgress?: number,
    title?: string,
    description?: string,
    tags?: string[],
    expectedProcessingAttemptId?: string,
    processingErrorCode?: string,
    processingErrorDetail?: string,
    mediaMetadata?: ReelProcessingMediaMetadata,
  ): Promise<Reel> {
    const updatedRecord = await this.$transaction(async (tx) => {
      const now = new Date();
      const currentRecord = await tx.reel.findUnique({ where: { id } });

      if (!currentRecord) {
        throw new Error(`Reel ${id} not found`);
      }

      if (
        expectedProcessingAttemptId?.trim() &&
        currentRecord.mediaAttemptId !== expectedProcessingAttemptId
      ) {
        return currentRecord;
      }

      const data: Record<string, unknown> = {};
      const isPostMediaUpdate = currentRecord.mediaStatus === 'COMPLETED';

      if (title !== undefined) data['title'] = title;
      if (description !== undefined) data['description'] = description;
      if (tags !== undefined) data['tags'] = tags;
      if (transcript !== undefined) data['transcript'] = transcript;
      if (transcriptVtt !== undefined) data['transcriptVtt'] = transcriptVtt;

      if (transcriptSegments !== undefined) {
        data['transcriptSegments'] = transcriptSegments;
      }

      if (thumbnailKey !== undefined) data['thumbnailKey'] = thumbnailKey;

      if (processingStage !== undefined) {
        data['processingStage'] = processingStage;
      }

      if (processingMessage !== undefined) {
        data['processingMessage'] = processingMessage;
      }

      if (processingProgress !== undefined) {
        data['processingProgress'] = processingProgress;
      }

      if (status === 'PROCESSING') {
        if (isPostMediaUpdate && processingStage === 'AI_ENRICHMENT') {
          data['status'] = 'COMPLETED';
          data['indexStatus'] = 'PROCESSING';
        } else {
          data['status'] = 'PROCESSING';
          data['mediaStatus'] =
            processingStage === 'PROBING_SOURCE' ? 'PROBING' : 'PROCESSING';
          data['processingStartedAt'] = now;
          data['processingFailedAt'] = null;
          data['processingCompletedAt'] = null;
          data['processingErrorCode'] = null;
          data['processingErrorDetail'] = null;
        }
      }

      if (status === 'PENDING') {
        data['status'] = 'PENDING';
        data['mediaStatus'] = 'PENDING';
      }

      if (status === 'COMPLETED') {
        data['status'] = 'COMPLETED';
        data['mediaStatus'] = 'COMPLETED';
        data['indexStatus'] = 'DEGRADED';
        data['processingCompletedAt'] = now;
        data['processingFailedAt'] = null;
        data['processingErrorCode'] = null;
        data['processingErrorDetail'] = null;
        data['processingProgress'] = processingProgress ?? 100;
      }

      if (status === 'FAILED') {
        if (isPostMediaUpdate) {
          data['status'] = 'COMPLETED';
          data['indexStatus'] = 'FAILED';
          data['processingStage'] = 'READY';
          data['processingMessage'] = 'Video is ready to watch';
          data['processingProgress'] = 100;
          data['processingFailedAt'] = now;
          data['processingErrorCode'] =
            processingErrorCode ?? processingStage ?? 'INDEXING_FAILED';
          data['processingErrorDetail'] = processingErrorDetail;
        } else {
          data['status'] = 'FAILED';
          data['mediaStatus'] = 'FAILED';
          data['processingFailedAt'] = now;
          data['processingErrorCode'] =
            processingErrorCode ?? processingStage ?? 'FAILED';
          data['processingErrorDetail'] = processingErrorDetail;
        }
      }

      if (mediaMetadata) {
        Object.assign(data, this.toMediaMetadataData(mediaMetadata));
      }

      const where =
        expectedProcessingAttemptId &&
        expectedProcessingAttemptId.trim().length > 0
          ? {
              id,
              mediaAttemptId: expectedProcessingAttemptId,
            }
          : {
              id,
            };

      const updateResult = await tx.reel.updateMany({
        where,
        data,
      });

      if (updateResult.count === 0) {
        return currentRecord;
      }

      return await tx.reel.findUniqueOrThrow({
        where: { id },
      });
    });

    return toReelDomain(updatedRecord);
  }

  async findById(id: string): Promise<Reel | null> {
    const record = await this.reel.findUnique({
      where: { id },
      include: {
        series: {
          select: {
            id: true,
            title: true,
          },
        },
      },
    });
    if (!record) return null;
    return toReelDomain(record);
  }

  async createReelSeries(data: ReelSeriesCreateData): Promise<ReelSeries> {
    return this.reelSeriesRepository.createReelSeries(data);
  }

  async findReelSeriesById(id: string): Promise<ReelSeries | null> {
    return this.reelSeriesRepository.findReelSeriesById(id);
  }

  async listReelSeries(query: ReelSeriesListQuery): Promise<{
    items: ReelSeries[];
    nextCursor: ReelCursor | null;
  }> {
    return this.reelSeriesRepository.listReelSeries(query);
  }

  async updateReelSeries(
    id: string,
    ownerId: string,
    data: ReelSeriesUpdateData,
  ): Promise<ReelSeries | null> {
    return this.reelSeriesRepository.updateReelSeries(id, ownerId, data);
  }

  async deleteReelSeries(id: string, ownerId: string): Promise<boolean> {
    return this.reelSeriesRepository.deleteReelSeries(id, ownerId);
  }

  async addReelToSeries(input: {
    seriesId: string;
    reelId: string;
    ownerId: string;
    episodeNumber: number;
  }): Promise<boolean> {
    return this.reelSeriesRepository.addReelToSeries(input);
  }

  async removeReelFromSeries(input: {
    seriesId: string;
    reelId: string;
    ownerId: string;
  }): Promise<boolean> {
    return this.reelSeriesRepository.removeReelFromSeries(input);
  }

  async reorderReelSeries(input: {
    seriesId: string;
    ownerId: string;
    reelIds: string[];
  }): Promise<boolean> {
    return this.reelSeriesRepository.reorderReelSeries(input);
  }

  async shareReel(input: ReelShareCreateInput): Promise<ReelShare> {
    const record = await this.reelShare.create({
      data: {
        reelId: input.reelId,
        ownerId: input.ownerId,
        sharedByUserId: input.sharedByUserId,
        sharedWithUserId: input.sharedWithUserId,
        conversationId: input.conversationId,
        messageId: input.messageId,
      },
    });

    return this.toReelShareDomain(record);
  }

  async updateReelShareMessageId(
    shareId: string,
    messageId: string,
  ): Promise<ReelShare> {
    const record = await this.reelShare.update({
      where: { id: shareId },
      data: { messageId },
    });

    return this.toReelShareDomain(record);
  }

  async findAccessibleSharedReelIds(input: {
    userId: string;
    conversationId: string;
  }): Promise<string[]> {
    const shares = await this.reelShare.findMany({
      where: {
        conversationId: input.conversationId,
        reel: {
          mediaStatus: 'COMPLETED',
          indexStatus: 'COMPLETED',
        },
      },
      distinct: ['reelId'],
      select: {
        reelId: true,
      },
    });

    return shares.map((share) => share.reelId);
  }

  async findSearchablePublicReels(ids: string[]): Promise<Reel[]> {
    return this.reelFeedRepository.findSearchablePublicReels(ids);
  }

  async getSearchSuggestions(
    query: SearchSuggestionsQuery,
  ): Promise<SearchSuggestion[]> {
    return this.reelFeedRepository.getSearchSuggestions(query);
  }

  async listRecommendedReels(
    query: RecommendedReelsQuery,
  ): Promise<{ items: Reel[]; nextCursor: ReelCursor | null }> {
    return this.reelFeedRepository.listRecommendedReels(query);
  }

  async listReels(
    query: ReelListQuery,
  ): Promise<{ items: Reel[]; nextCursor: ReelCursor | null }> {
    return this.reelFeedRepository.listReels(query);
  }

  async getProfileReelContext(
    query: ReelProfileContextQuery,
  ): Promise<ReelProfileContextResult> {
    return this.reelFeedRepository.getProfileReelContext(query);
  }

  async updateReel(
    id: string,
    data: ReelUpdateData,
    userId: string,
  ): Promise<Reel | null> {
    const reel = await this.reel.findUnique({
      where: { id },
      include: { series: { select: { visibility: true } } },
    });
    if (!reel) return null;
    if (reel.userId !== userId) return null;
    if (
      data.visibility !== undefined &&
      reel.series &&
      data.visibility !== reel.series.visibility
    ) {
      return null;
    }

    const updatedRecord = await this.reel.update({
      where: { id },
      data: {
        title: data.title !== undefined ? data.title : undefined,
        description:
          data.description !== undefined ? data.description : undefined,
        tags: data.tags !== undefined ? data.tags : undefined,
        visibility: data.visibility !== undefined ? data.visibility : undefined,
      },
      include: {
        series: {
          select: {
            id: true,
            title: true,
          },
        },
      },
    });

    return toReelDomain(updatedRecord);
  }

  async deleteReel(id: string, userId: string): Promise<boolean> {
    const reel = await this.reel.findUnique({ where: { id } });
    if (!reel) return false;
    if (reel.userId !== userId) return false;

    await this.reel.delete({ where: { id } });
    return true;
  }

  private toReelShareDomain(record: Record<string, unknown>): ReelShare {
    return new ReelShare({
      id: record['id'] as string,
      reelId: record['reelId'] as string,
      ownerId: record['ownerId'] as string,
      sharedByUserId: record['sharedByUserId'] as string,
      sharedWithUserId:
        (record['sharedWithUserId'] as string | null | undefined) ?? null,
      conversationId: record['conversationId'] as string,
      messageId: (record['messageId'] as string | null | undefined) ?? null,
      createdAt: record['createdAt'] as Date,
      updatedAt: record['updatedAt'] as Date,
    });
  }

  private toReelShareLinkDomain(
    record: Record<string, unknown>,
  ): ReelShareLink {
    return new ReelShareLink({
      id: record['id'] as string,
      reelId: record['reelId'] as string,
      ownerId: record['ownerId'] as string,
      token: record['token'] as string,
      createdBy: record['createdBy'] as string,
      expiresAt: (record['expiresAt'] as Date | null | undefined) ?? null,
      revokedAt: (record['revokedAt'] as Date | null | undefined) ?? null,
      clickCount: record['clickCount'] as bigint,
      createdAt: record['createdAt'] as Date,
      updatedAt: record['updatedAt'] as Date,
    });
  }

  async createReelShareLink(
    input: ReelShareLinkCreateInput,
  ): Promise<ReelShareLink> {
    const record = await this.reelShareLink.create({
      data: {
        reelId: input.reelId,
        ownerId: input.ownerId,
        token: input.token,
        createdBy: input.createdBy,
        expiresAt: input.expiresAt,
      },
    });

    return this.toReelShareLinkDomain(record);
  }

  async findActiveReelShareLinkByReelAndCreator(input: {
    reelId: string;
    createdBy: string;
    now: Date;
  }): Promise<ReelShareLink | null> {
    const record = await this.reelShareLink.findFirst({
      where: {
        reelId: input.reelId,
        createdBy: input.createdBy,
        revokedAt: null,
        OR: [{ expiresAt: null }, { expiresAt: { gt: input.now } }],
      },
      orderBy: { createdAt: 'desc' },
    });

    return record ? this.toReelShareLinkDomain(record) : null;
  }

  async findReelShareLinkByToken(
    token: string,
  ): Promise<ReelShareLinkWithReel | null> {
    const record = await this.reelShareLink.findUnique({
      where: { token },
      include: { reel: true },
    });

    if (!record) {
      return null;
    }

    return {
      link: this.toReelShareLinkDomain(record),
      reel: toReelDomain(record.reel),
    };
  }

  async incrementReelShareLinkClickCount(id: string): Promise<ReelShareLink> {
    const record = await this.reelShareLink.update({
      where: { id },
      data: {
        clickCount: {
          increment: 1,
        },
      },
    });

    return this.toReelShareLinkDomain(record);
  }

  async revokeReelShareLink(input: {
    token: string;
    revokedByUserId: string;
  }): Promise<ReelShareLink | null> {
    const record = await this.reelShareLink.update({
      where: { token: input.token },
      data: {
        revokedAt: new Date(),
      },
    });

    return this.toReelShareLinkDomain(record);
  }

  async listFriendsReels(query: FriendsReelsQuery): Promise<{
    items: Reel[];
    nextCursor: ReelCursor | null;
  }> {
    return this.reelFeedRepository.listFriendsReels(query);
  }
}
