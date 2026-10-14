import { TranscriptSegment } from '@common/ai/interfaces/transcription-result.interface';
import type { ReelMonitoringSnapshot } from '@common/content/dtos/reel-monitoring-snapshot.dto';
import type { CompleteReelIndexCommand } from '@common/processing/interfaces/complete-reel-index.interface';
import {
  REEL_MEDIA_JOB_EVENT_TYPE,
  REEL_MEDIA_JOB_SCHEMA_VERSION,
  type ReelMediaJob,
} from '@common/processing/interfaces/reel-media-job.interface';
import {
  REEL_INDEX_JOB_EVENT_TYPE,
  REEL_INDEX_JOB_SCHEMA_VERSION,
  type ReelIndexJob,
} from '@common/processing/interfaces/reel-index-job.interface';
import type { ReelMediaOutput } from '@common/processing/interfaces/reel-media-output.interface';
import { ReelSeries } from '@content/domain/entities/reel-series.entity';
import { ReelShareLink } from '@content/domain/entities/reel-share-link.entity';
import { ReelShare } from '@content/domain/entities/reel-share.entity';
import type { IRecommendationFeedCacheRepository } from '@content/domain/interfaces/recommendation-feed-cache.repository.interface';
import { mapReelLegacyStatus } from '@content/domain/reel-status-compatibility.mapper';
import {
  ReelUploadLeaseUnavailableError,
  ReelUploadLeaseExpiredError,
} from '@content/domain/errors/content.error';
import type { IStorageService } from '@content/domain/interfaces/storage.service.interface';
import { Inject, Injectable, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Prisma, PrismaClient } from '@prisma/content-client';
import { randomUUID } from 'crypto';

const MEDIA_ATTEMPT_LEASE_MS = 6 * 60 * 60 * 1000;
import { Reel } from '../../domain/entities/reel.entity';
import {
  FriendsReelsQuery,
  IContentRepository,
  RecommendedReelsQuery,
  ReelCursor,
  CompleteExistingHlsEvidenceInput,
  ReelListQuery,
  ReelMediaOutboxEventInput,
  ReelProcessingMediaMetadata,
  ReelProfileContextQuery,
  ReelProfileContextResult,
  ReelSeriesCandidateQuery,
  ReelSeriesCreateData,
  ReelSeriesEpisodesQuery,
  ReelSeriesEpisodesRecord,
  ReelSeriesListRecord,
  ReelSeriesListQuery,
  ReelSeriesMetadataRecord,
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
    @Inject('IRecommendationFeedCacheRepository')
    private readonly recommendationFeedCacheRepository: IRecommendationFeedCacheRepository,
    @Inject('IStorageService')
    private readonly storageService: IStorageService,
  ) {
    super();
  }

  async onModuleInit() {
    await this.$connect();
  }

  async onModuleDestroy() {
    await this.$disconnect();
  }

  async getReelMonitoringSnapshot(): Promise<ReelMonitoringSnapshot> {
    const now = new Date();
    const stalledBefore = new Date(now.getTime() - 10 * 60 * 1000);
    const recentFailureSince = new Date(now.getTime() - 15 * 60 * 1000);
    const recentSince = new Date(now.getTime() - 24 * 60 * 60 * 1000);

    const [
      mediaGroups,
      indexGroups,
      queued,
      processing,
      ready,
      failed,
      recentFailed,
      degraded,
      stalled,
      recentReady,
    ] = await Promise.all([
      this.reel.groupBy({ by: ['mediaStatus'], _count: { _all: true } }),
      this.reel.groupBy({ by: ['indexStatus'], _count: { _all: true } }),
      this.reel.count({
        where: { processingStage: { in: ['QUEUED', 'INDEX_QUEUED'] } },
      }),
      this.reel.count({
        where: {
          OR: [
            { mediaStatus: { in: ['PROBING', 'PROCESSING'] } },
            { indexStatus: 'PROCESSING' },
          ],
        },
      }),
      this.reel.count({ where: { processingStage: 'READY' } }),
      this.reel.count({
        where: {
          OR: [
            { status: 'FAILED' },
            { mediaStatus: 'FAILED' },
            { indexStatus: 'FAILED' },
          ],
        },
      }),
      this.reel.count({
        where: { processingFailedAt: { gte: recentFailureSince } },
      }),
      this.reel.count({ where: { indexStatus: 'DEGRADED' } }),
      this.reel.count({
        where: {
          updatedAt: { lte: stalledBefore },
          OR: [
            { processingStage: { in: ['QUEUED', 'INDEX_QUEUED'] } },
            { mediaStatus: { in: ['PROBING', 'PROCESSING'] } },
            { indexStatus: 'PROCESSING' },
          ],
        },
      }),
      this.reel.findMany({
        where: {
          processingStage: 'READY',
          createdAt: { gte: recentSince },
        },
        select: {
          createdAt: true,
          updatedAt: true,
          indexCompletedAt: true,
          processingCompletedAt: true,
          processingFailedAt: true,
        },
        orderBy: { createdAt: 'desc' },
        take: 1000,
      }),
    ]);

    const media = {
      PENDING: 0,
      PROBING: 0,
      PROCESSING: 0,
      COMPLETED: 0,
      FAILED: 0,
    };
    for (const group of mediaGroups) {
      media[group.mediaStatus] = group._count._all;
    }

    const index = {
      NOT_REQUESTED: 0,
      PENDING: 0,
      PROCESSING: 0,
      COMPLETED: 0,
      DEGRADED: 0,
      FAILED: 0,
    };
    for (const group of indexGroups) {
      index[group.indexStatus] = group._count._all;
    }

    const readinessSeconds = recentReady
      .map((reel) => {
        const readyAt =
          reel.indexCompletedAt ??
          reel.processingFailedAt ??
          reel.processingCompletedAt ??
          reel.updatedAt;
        return Math.max(
          0,
          (readyAt.getTime() - reel.createdAt.getTime()) / 1000,
        );
      })
      .sort((left, right) => left - right);
    const p95Index = Math.max(0, Math.ceil(readinessSeconds.length * 0.95) - 1);

    return {
      generatedAt: now.toISOString(),
      queued,
      processing,
      ready,
      failed,
      recentFailed,
      degraded,
      stalled,
      readyLatencyP95Seconds:
        readinessSeconds.length > 0 ? readinessSeconds[p95Index] : null,
      media,
      index,
    };
  }

  async reserveReelUploadLease(input: {
    userId: string;
    publishIntentId: string;
    mediaKey: string;
    fileType: string;
    expiresAt: Date;
  }): Promise<void> {
    await this.$transaction(async (transaction) => {
      await transaction.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${input.mediaKey}))`;
      const currentLease = await transaction.reelUploadLease.findUnique({
        where: {
          userId_publishIntentId_fileType: {
            userId: input.userId,
            publishIntentId: input.publishIntentId,
            fileType: input.fileType,
          },
        },
        select: {
          adoptedAt: true,
          cleanupClaimedAt: true,
          cleanupCompletedAt: true,
        },
      });
      if (currentLease?.cleanupCompletedAt)
        throw new ReelUploadLeaseExpiredError();
      if (currentLease?.cleanupClaimedAt && !currentLease.cleanupCompletedAt) {
        throw new Error(
          'The Reel upload is currently being cleaned up; retry renewal.',
        );
      }

      if (currentLease?.adoptedAt) return;
      await transaction.reelUploadLease.upsert({
        where: {
          userId_publishIntentId_fileType: {
            userId: input.userId,
            publishIntentId: input.publishIntentId,
            fileType: input.fileType,
          },
        },
        create: input,
        update: {
          mediaKey: input.mediaKey,
          expiresAt: input.expiresAt,
          cancelledAt: null,
          adoptedAt: null,
          cleanupClaimedAt: null,
          cleanupCompletedAt: null,
        },
      });
    });
  }

  async listExpiredReelUploadLeases(now: Date) {
    return this.reelUploadLease.findMany({
      where: {
        expiresAt: { lt: now },
        OR: [
          { adoptedAt: null, cancelledAt: null },
          { cancelledAt: { not: null }, cleanupCompletedAt: null },
        ],
      },
      select: { id: true, mediaKey: true, expiresAt: true },
      orderBy: { expiresAt: 'asc' },
      take: 100,
    });
  }

  async cleanupExpiredReelUploadLease(id: string, now: Date): Promise<boolean> {
    return this.$transaction(async (transaction) => {
      const candidate = await transaction.reelUploadLease.findUnique({
        where: { id },
      });
      if (!candidate) return false;
      await transaction.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${candidate.mediaKey}))`;
      const lease = await transaction.reelUploadLease.findUnique({
        where: { id },
      });
      if (
        !lease ||
        lease.expiresAt >= now ||
        (lease.adoptedAt && !lease.cancelledAt)
      ) {
        return false;
      }

      const adoptedReel = await transaction.reel.findFirst({
        where: { mediaKey: lease.mediaKey },
        select: { id: true },
      });
      if (adoptedReel) return false;

      if (!lease.cleanupClaimedAt || lease.cleanupCompletedAt) {
        const claimed = await transaction.reelUploadLease.updateMany({
          where: { id, expiresAt: { lt: now } },
          data: { cancelledAt: now, cleanupClaimedAt: now },
        });
        if (claimed.count === 0) return false;
      }
      return true;
    });
  }

  async completeReelUploadLeaseCleanup(
    id: string,
    now: Date,
  ): Promise<boolean> {
    return this.$transaction(
      async (transaction) => {
        const candidate = await transaction.reelUploadLease.findUnique({
          where: { id },
        });
        if (!candidate) return false;
        await transaction.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${candidate.mediaKey}))`;
        const lease = await transaction.reelUploadLease.findUnique({
          where: { id },
        });
        if (!lease?.cleanupClaimedAt || lease.cleanupCompletedAt) return false;
        if (
          await transaction.reel.findFirst({
            where: { mediaKey: lease.mediaKey },
          })
        )
          return false;
        await this.storageService.deleteObjects([lease.mediaKey]);
        const completed = await transaction.reelUploadLease.updateMany({
          where: {
            id,
            cleanupClaimedAt: { not: null },
            cleanupCompletedAt: null,
          },
          data: { cleanupCompletedAt: now },
        });
        return completed.count > 0;
      },
      { timeout: 60_000 },
    );
  }

  async isReelMediaOutputPrefixProtected(
    prefix: string,
    mediaAttemptId: string,
  ): Promise<boolean> {
    const attemptLease = await this.reelMediaAttemptLease.findFirst({
      where: {
        attemptId: mediaAttemptId,
        expiresAt: { gt: new Date() },
        completedAt: null,
      },
      select: { attemptId: true },
    });
    if (attemptLease) return true;

    const reel = await this.reel.findFirst({
      where: {
        OR: [
          { mediaAttemptId },
          { hlsMasterKey: { startsWith: `${prefix}/` } },
          { thumbnailKey: { startsWith: `${prefix}/` } },
        ],
      },
      select: { id: true },
    });
    if (reel) return true;

    const pendingEvents = await this.outboxEvent.findMany({
      where: {
        publishedAt: null,
        eventType: REEL_MEDIA_JOB_EVENT_TYPE,
      },
      select: { payload: true },
    });
    return pendingEvents.some((event) => {
      const payload = event.payload as { mediaAttemptId?: unknown };
      return payload.mediaAttemptId === mediaAttemptId;
    });
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
      await transaction.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${reel.mediaKey!}))`;
      const cleanupClaim = await transaction.reelUploadLease.findFirst({
        where: {
          mediaKey: reel.mediaKey!,
          cleanupClaimedAt: { not: null },
          cleanupCompletedAt: null,
        },
      });
      if (cleanupClaim) throw new ReelUploadLeaseUnavailableError();
      // HEAD before the transaction may predate a completed storage cleanup.
      if (!(await this.storageService.checkFileExists(reel.mediaKey!)))
        throw new ReelUploadLeaseUnavailableError();
      const record = await transaction.reel.create({
        data: {
          id: reel.id,
          userId: reel.userId!,
          publishIntentId: reel.publishIntentId!,
          publishRequestFingerprint: reel.publishRequestFingerprint,
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

      if (reel.publishIntentId) {
        const lease = await transaction.reelUploadLease.findFirst({
          where: {
            userId: reel.userId!,
            publishIntentId: reel.publishIntentId,
            mediaKey: reel.mediaKey!,
          },
        });
        if (lease) {
          const adopted = await transaction.reelUploadLease.updateMany({
            where: {
              id: lease.id,
              mediaKey: reel.mediaKey!,
              adoptedAt: null,
              cancelledAt: null,
              cleanupClaimedAt: null,
            },
            data: { adoptedAt: new Date() },
          });
          if (adopted.count === 0) {
            throw new ReelUploadLeaseUnavailableError();
          }
        }
      }

      if (reel.mediaAttemptId) {
        await transaction.reelMediaAttemptLease.upsert({
          where: { attemptId: reel.mediaAttemptId },
          create: {
            attemptId: reel.mediaAttemptId,
            reelId: record.id,
            expiresAt: new Date(Date.now() + MEDIA_ATTEMPT_LEASE_MS),
          },
          update: {
            reelId: record.id,
            expiresAt: new Date(Date.now() + MEDIA_ATTEMPT_LEASE_MS),
            completedAt: null,
          },
        });
      }

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

  async findByPublishIntentId(
    userId: string,
    publishIntentId: string,
  ): Promise<Reel | null> {
    const record = await this.reel.findUnique({
      where: {
        userId_publishIntentId: {
          userId,
          publishIntentId,
        },
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

    return record ? toReelDomain(record) : null;
  }

  async queueReelProcessingAttemptWithMediaJob(
    reelId: string,
    mediaAttemptId: string,
    indexAttemptId: string,
    outboxEvent: ReelMediaOutboxEventInput,
    preserveMediaReady = false,
  ): Promise<Reel> {
    const record = await this.$transaction(async (transaction) => {
      const queuedRecord = await transaction.reel.update({
        where: { id: reelId },
        data: {
          status: preserveMediaReady ? 'COMPLETED' : 'PENDING',
          mediaStatus: preserveMediaReady ? 'COMPLETED' : 'PENDING',
          indexStatus: preserveMediaReady ? 'PENDING' : 'NOT_REQUESTED',
          processingStage: preserveMediaReady ? 'MEDIA_READY' : 'QUEUED',
          processingMessage: preserveMediaReady
            ? 'Video is ready; evidence generation queued'
            : 'Queued for processing',
          processingProgress: preserveMediaReady ? 90 : 0,
          processingAttemptId: mediaAttemptId,
          mediaAttemptId,
          indexAttemptId,
          processingStartedAt: preserveMediaReady ? undefined : null,
          processingFailedAt: null,
          processingCompletedAt: preserveMediaReady ? undefined : null,
          processingErrorCode: null,
          processingErrorDetail: null,
        },
      });

      await transaction.reelMediaAttemptLease.upsert({
        where: { attemptId: mediaAttemptId },
        create: {
          attemptId: mediaAttemptId,
          reelId,
          expiresAt: new Date(Date.now() + MEDIA_ATTEMPT_LEASE_MS),
        },
        update: {
          reelId,
          expiresAt: new Date(Date.now() + MEDIA_ATTEMPT_LEASE_MS),
          completedAt: null,
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

    await this.recommendationFeedCacheRepository.invalidateReels([reelId]);
    return toReelDomain(record);
  }

  async claimProcessingAttempt(input: {
    reelId: string;
    processingAttemptId: string;
    allowReclaim?: boolean;
    evidenceOnly?: boolean;
    userId?: string;
    hlsMasterKey?: string;
  }): Promise<boolean> {
    const where: Prisma.ReelWhereInput = input.evidenceOnly
      ? {
          id: input.reelId,
          mediaAttemptId: input.processingAttemptId,
          mediaStatus: 'COMPLETED' as const,
          indexStatus: 'PENDING' as const,
          processingStage: input.allowReclaim
            ? {
                in: [
                  'MEDIA_READY',
                  'EVIDENCE_PROCESSING',
                  'LOADING_EXISTING_HLS',
                  'BUILDING_AUDIO_MANIFEST',
                  'BUILDING_VISUAL_MANIFEST',
                  'RETRY_SCHEDULED',
                ],
              }
            : { in: ['MEDIA_READY', 'RETRY_SCHEDULED'] },
        }
      : {
          id: input.reelId,
          mediaAttemptId: input.processingAttemptId,
          mediaStatus: input.allowReclaim
            ? { in: ['PENDING', 'PROCESSING'] }
            : 'PENDING',
        };
    const data = input.evidenceOnly
      ? {
          status: 'COMPLETED' as const,
          mediaStatus: 'COMPLETED' as const,
          processingStage: 'EVIDENCE_PROCESSING',
          processingMessage: 'Preparing transcript and visual evidence',
          processingProgress: 92,
          processingStartedAt: new Date(),
          processingFailedAt: null,
          processingErrorCode: null,
          processingErrorDetail: null,
        }
      : {
          status: 'PROCESSING' as const,
          mediaStatus: 'PROCESSING' as const,
          processingStage: 'PROCESSING',
          processingMessage: 'Video is being processed',
          processingProgress: 10,
          processingStartedAt: new Date(),
          processingFailedAt: null,
          processingCompletedAt: null,
          processingErrorCode: null,
          processingErrorDetail: null,
        };
    const result = await this.reel.updateMany({
      where: {
        ...where,
        ...(input.userId ? { userId: input.userId } : {}),
        ...(input.evidenceOnly && input.hlsMasterKey
          ? { hlsMasterKey: input.hlsMasterKey }
          : {}),
      },
      data,
    });

    const claimed = result.count > 0;
    if (claimed) {
      await this.reelMediaAttemptLease.updateMany({
        where: {
          attemptId: input.processingAttemptId,
          completedAt: null,
        },
        data: {
          expiresAt: new Date(Date.now() + MEDIA_ATTEMPT_LEASE_MS),
        },
      });
      await this.recommendationFeedCacheRepository.invalidateReels([
        input.reelId,
      ]);
    }
    return claimed;
  }

  async completeMediaProcessing(input: {
    reelId: string;
    mediaAttemptId: string;
    mediaMetadata: ReelProcessingMediaMetadata;
    mediaOutput: ReelMediaOutput;
  }): Promise<boolean> {
    const completed = await this.$transaction(async (transaction) => {
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
            input.mediaOutput.transcriptionAudioManifestKey ?? null,
          visualFrameManifestKey:
            input.mediaOutput.visualFrameManifestKey ?? null,
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
      const evidenceJob: ReelMediaJob = {
        jobId,
        reelId: reel.id,
        userId: reel.userId,
        mediaAttemptId: input.mediaAttemptId,
        mediaKey: reel.mediaKey,
        expectedLengthClass: input.mediaOutput.sourceLengthClass,
        sourceMode: 'EXISTING_HLS',
        hlsMasterKey: input.mediaOutput.hlsMasterKey,
        existingSourceOrientation: input.mediaMetadata.sourceOrientation,
        existingSourceLengthClass: input.mediaOutput.sourceLengthClass,
        preservedSourceDurationMs: input.mediaMetadata.sourceDurationMs,
        title: reel.title ?? undefined,
        description: reel.description ?? undefined,
        tags: reel.tags,
        createdAt: completedAt.toISOString(),
        schemaVersion: REEL_MEDIA_JOB_SCHEMA_VERSION,
      };

      await transaction.outboxEvent.create({
        data: {
          id: jobId,
          aggregateType: 'REEL',
          aggregateId: reel.id,
          eventType: REEL_MEDIA_JOB_EVENT_TYPE,
          payload: evidenceJob as unknown as Prisma.InputJsonValue,
          createdAt: completedAt,
          nextAttemptAt: completedAt,
        },
      });

      return true;
    });

    if (completed) {
      await this.recommendationFeedCacheRepository.invalidateReels([
        input.reelId,
      ]);
    }
    return completed;
  }

  async completeExistingHlsEvidence(
    input: CompleteExistingHlsEvidenceInput,
  ): Promise<boolean> {
    const completed = await this.$transaction(async (transaction) => {
      const completedAt = new Date();
      const current = await transaction.reel.findUnique({
        where: { id: input.reelId },
      });
      if (!current) return false;

      const mediaMetadataData = this.toMediaMetadataData(input.mediaMetadata);
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
        if (current[key] !== null && current[key] !== undefined) {
          delete mediaMetadataData[key];
        }
      }

      const result = await transaction.reel.updateMany({
        where: {
          id: input.reelId,
          mediaAttemptId: input.mediaAttemptId,
          mediaStatus: 'COMPLETED',
          indexStatus: 'PENDING',
          processingStage: {
            in: [
              'EVIDENCE_PROCESSING',
              'LOADING_EXISTING_HLS',
              'BUILDING_AUDIO_MANIFEST',
              'BUILDING_VISUAL_MANIFEST',
              'RETRY_SCHEDULED',
            ],
          },
          hlsMasterKey: { not: null },
        },
        data: {
          status: 'COMPLETED',
          mediaStatus: 'COMPLETED',
          indexStatus: 'PENDING',
          transcriptionAudioManifestKey: input.transcriptionAudioManifestKey,
          visualFrameManifestKey: input.visualFrameManifestKey,
          processingStage: 'INDEX_QUEUED',
          processingMessage:
            'Transcript and visual evidence ready; indexing queued',
          processingProgress: 90,
          processingCompletedAt: completedAt,
          processingFailedAt: null,
          processingErrorCode: null,
          processingErrorDetail: null,
          ...mediaMetadataData,
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
        transcriptionAudioManifestKey: input.transcriptionAudioManifestKey,
        visualFrameManifestKey: input.visualFrameManifestKey,
        sourceDurationMs:
          reel.sourceDurationMs ?? input.mediaMetadata.sourceDurationMs!,
        outputDurationMs:
          reel.outputDurationMs ??
          input.mediaMetadata.outputDurationMs ??
          input.mediaMetadata.sourceDurationMs!,
        sourceHasAudio:
          reel.sourceHasAudio ?? input.mediaMetadata.sourceHasAudio,
        sourceOrientation:
          reel.sourceOrientation ?? input.mediaMetadata.sourceOrientation!,
        sourceLengthClass:
          reel.sourceLengthClass ?? input.mediaMetadata.sourceLengthClass!,
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

    if (completed) {
      await this.recommendationFeedCacheRepository.invalidateReels([
        input.reelId,
      ]);
    }
    return completed;
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

    const updated = result.count > 0;
    if (updated) {
      const reelForLease = await this.reel.findUnique({
        where: { id: input.reelId },
        select: { mediaAttemptId: true },
      });
      await this.reelMediaAttemptLease.updateMany({
        where: {
          attemptId: reelForLease?.mediaAttemptId ?? '',
          completedAt: null,
        },
        data: { expiresAt: new Date(Date.now() + MEDIA_ATTEMPT_LEASE_MS) },
      });
      await this.recommendationFeedCacheRepository.invalidateReels([
        input.reelId,
      ]);
    }
    return updated;
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

    const updated = result.count > 0;
    if (updated) {
      await this.recommendationFeedCacheRepository.invalidateReels([
        input.reelId,
      ]);
    }
    return updated;
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
    const claimed = result.count > 0;
    if (claimed) {
      const reelForLease = await this.reel.findUnique({
        where: { id: input.reelId },
        select: { mediaAttemptId: true },
      });
      if (reelForLease?.mediaAttemptId) {
        await this.reelMediaAttemptLease.updateMany({
          where: {
            attemptId: reelForLease.mediaAttemptId,
            completedAt: null,
          },
          data: { expiresAt: new Date(Date.now() + MEDIA_ATTEMPT_LEASE_MS) },
        });
      }
      await this.recommendationFeedCacheRepository.invalidateReels([
        input.reelId,
      ]);
    }
    return claimed;
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
    const updated = result.count > 0;
    if (updated) {
      const reelForLease = await this.reel.findUnique({
        where: { id: input.reelId },
        select: { mediaAttemptId: true },
      });
      if (reelForLease?.mediaAttemptId) {
        await this.reelMediaAttemptLease.updateMany({
          where: {
            attemptId: reelForLease.mediaAttemptId,
            completedAt: null,
          },
          data: { expiresAt: new Date(Date.now() + MEDIA_ATTEMPT_LEASE_MS) },
        });
      }
      await this.recommendationFeedCacheRepository.invalidateReels([
        input.reelId,
      ]);
    }
    return updated;
  }

  async completeIndexing(input: CompleteReelIndexCommand): Promise<boolean> {
    const transcriptSegmentsJson =
      input.transcriptSegments === undefined
        ? null
        : JSON.stringify(input.transcriptSegments);

    const completed = await this.$transaction(async (transaction) => {
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

      if (current.mediaAttemptId) {
        await transaction.reelMediaAttemptLease.updateMany({
          where: {
            attemptId: current.mediaAttemptId,
            completedAt: null,
          },
          data: { completedAt: new Date() },
        });
      }

      return true;
    });

    if (completed) {
      await this.recommendationFeedCacheRepository.invalidateReels([
        input.reelId,
      ]);
    }
    return completed;
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
    const failed = result.count > 0;
    if (failed) {
      const reel = await this.reel.findUnique({
        where: { id: input.reelId },
        select: { mediaAttemptId: true },
      });
      if (reel?.mediaAttemptId) {
        await this.reelMediaAttemptLease.updateMany({
          where: {
            attemptId: reel.mediaAttemptId,
            completedAt: null,
          },
          data: { completedAt: new Date() },
        });
      }
      await this.recommendationFeedCacheRepository.invalidateReels([
        input.reelId,
      ]);
    }
    return failed;
  }

  async queueReelIndexingAttempt(reelId: string): Promise<string | null> {
    const indexAttemptId = await this.$transaction(async (transaction) => {
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
        visualFrameManifestKey: reel.visualFrameManifestKey ?? undefined,
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

    if (indexAttemptId) {
      await this.recommendationFeedCacheRepository.invalidateReels([reelId]);
    }
    return indexAttemptId;
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
    sourceMode?: 'SOURCE_VIDEO' | 'EXISTING_HLS',
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

      const advancedMediaStages = new Set([
        'MEDIA_READY',
        'EVIDENCE_PROCESSING',
        'LOADING_EXISTING_HLS',
        'BUILDING_AUDIO_MANIFEST',
        'BUILDING_VISUAL_MANIFEST',
        'INDEX_QUEUED',
        'READY',
      ]);
      if (
        currentRecord.mediaStatus === 'COMPLETED' &&
        sourceMode === 'SOURCE_VIDEO' &&
        advancedMediaStages.has(currentRecord.processingStage ?? '')
      ) {
        return currentRecord;
      }
      if (
        currentRecord.mediaStatus === 'COMPLETED' &&
        sourceMode === 'EXISTING_HLS' &&
        ['INDEX_QUEUED', 'READY'].includes(currentRecord.processingStage ?? '')
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
        if (isPostMediaUpdate) {
          data['status'] = 'COMPLETED';
          data['mediaStatus'] = 'COMPLETED';
          data['indexStatus'] =
            processingStage === 'AI_ENRICHMENT' ? 'PROCESSING' : 'PENDING';
          data['processingStartedAt'] = now;
          data['processingFailedAt'] = null;
          data['processingErrorCode'] = null;
          data['processingErrorDetail'] = null;
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
        if (isPostMediaUpdate) {
          data['status'] = 'COMPLETED';
          data['mediaStatus'] = 'COMPLETED';
          data['indexStatus'] = 'PENDING';
        } else {
          data['status'] = 'PENDING';
          data['mediaStatus'] = 'PENDING';
        }
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

    await this.recommendationFeedCacheRepository.invalidateReels([id]);
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

  async findReelSeriesMetadataById(
    id: string,
  ): Promise<ReelSeriesMetadataRecord | null> {
    return this.reelSeriesRepository.findReelSeriesMetadataById(id);
  }

  async listReelSeries(query: ReelSeriesListQuery): Promise<{
    items: ReelSeriesListRecord[];
    nextCursor: ReelCursor | null;
  }> {
    return this.reelSeriesRepository.listReelSeries(query);
  }

  async listReelSeriesEpisodes(
    query: ReelSeriesEpisodesQuery,
  ): Promise<ReelSeriesEpisodesRecord> {
    return this.reelSeriesRepository.listReelSeriesEpisodes(query);
  }

  async listReelSeriesCandidates(query: ReelSeriesCandidateQuery): Promise<{
    items: Reel[];
    nextCursor: ReelCursor | null;
  }> {
    return this.reelSeriesRepository.listReelSeriesCandidates(query);
  }

  async updateReelSeries(
    id: string,
    ownerId: string,
    data: ReelSeriesUpdateData,
  ): Promise<ReelSeries | null> {
    const updated = await this.reelSeriesRepository.updateReelSeries(
      id,
      ownerId,
      data,
    );
    if (updated) {
      await this.recommendationFeedCacheRepository.invalidateReels(
        updated.reels.map((reel) => reel.id),
      );
    }
    return updated;
  }

  async deleteReelSeries(id: string, ownerId: string): Promise<boolean> {
    const existing = await this.reelSeriesRepository.findReelSeriesById(id);
    const deleted = await this.reelSeriesRepository.deleteReelSeries(
      id,
      ownerId,
    );
    if (deleted && existing?.ownerId === ownerId) {
      await this.recommendationFeedCacheRepository.invalidateReels(
        existing.reels.map((reel) => reel.id),
      );
    }
    return deleted;
  }

  async addReelsToSeries(input: {
    seriesId: string;
    reelIds: string[];
    ownerId: string;
  }): Promise<boolean> {
    const added = await this.reelSeriesRepository.addReelsToSeries(input);
    if (added) {
      await this.recommendationFeedCacheRepository.invalidateReels(
        input.reelIds,
      );
    }
    return added;
  }

  async removeReelFromSeries(input: {
    seriesId: string;
    reelId: string;
    ownerId: string;
  }): Promise<boolean> {
    const removed = await this.reelSeriesRepository.removeReelFromSeries(input);
    if (removed) {
      await this.recommendationFeedCacheRepository.invalidateReels([
        input.reelId,
      ]);
    }
    return removed;
  }

  async reorderReelSeries(input: {
    seriesId: string;
    ownerId: string;
    reelIds: string[];
  }): Promise<boolean> {
    const reordered = await this.reelSeriesRepository.reorderReelSeries(input);
    if (reordered) {
      await this.recommendationFeedCacheRepository.invalidateReels(
        input.reelIds,
      );
    }
    return reordered;
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

    await this.recommendationFeedCacheRepository.invalidateReels([id]);
    return toReelDomain(updatedRecord);
  }

  async deleteReel(id: string, userId: string): Promise<boolean> {
    const deleted = await this.$transaction(
      async (transaction) => {
        const reel = await transaction.reel.findFirst({
          where: { id, userId },
          select: { id: true, seriesId: true, mediaKey: true },
        });
        if (!reel) return false;

        await transaction.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${reel.mediaKey}))`;

        await transaction.reel.delete({ where: { id } });

        const survivor = await transaction.reel.findFirst({
          where: { mediaKey: reel.mediaKey },
          select: { id: true },
        });
        if (!survivor) {
          await transaction.reelUploadLease.updateMany({
            where: { mediaKey: reel.mediaKey, cleanupClaimedAt: null },
            data: {
              cancelledAt: new Date(),
              expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
            },
          });
        }

        if (reel.seriesId) {
          const remaining = await transaction.reel.findMany({
            where: { seriesId: reel.seriesId, userId },
            orderBy: [
              { episodeNumber: 'asc' },
              { createdAt: 'asc' },
              { id: 'asc' },
            ],
            select: { id: true },
          });

          await transaction.reel.updateMany({
            where: { seriesId: reel.seriesId, userId },
            data: { episodeNumber: null },
          });

          for (let index = 0; index < remaining.length; index += 1) {
            await transaction.reel.update({
              where: { id: remaining[index].id },
              data: { episodeNumber: index + 1 },
            });
          }
        }

        return true;
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
    );

    if (deleted) {
      await this.recommendationFeedCacheRepository.invalidateReels([id]);
    }
    return deleted;
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
