import { TranscriptSegment } from '@common/ai/interfaces/transcription-result.interface';
import type { ReelMediaEdit } from '@common/content/schemas/reel-edit.schema';
import type { ReelMediaOutput } from '@common/processing/interfaces/reel-media-output.interface';
import { Reel } from '@content/domain/entities/reel.entity';
import { ReelSeries } from '@content/domain/entities/reel-series.entity';
import { mapReelLegacyStatus } from '@content/domain/reel-status-compatibility.mapper';

export const REEL_LIST_SELECT = {
  id: true,
  userId: true,
  mediaKey: true,
  title: true,
  description: true,
  tags: true,
  status: true,
  mediaStatus: true,
  indexStatus: true,
  visibility: true,
  viewCount: true,
  thumbnailKey: true,
  hlsMasterKey: true,
  transcriptionAudioManifestKey: true,
  mediaOutput: true,
  mediaEdit: true,
  outputDurationMs: true,
  processingStage: true,
  processingMessage: true,
  processingProgress: true,
  processingAttemptId: true,
  processingStartedAt: true,
  processingFailedAt: true,
  processingCompletedAt: true,
  processingErrorCode: true,
  processingErrorDetail: true,
  mediaAttemptId: true,
  indexAttemptId: true,
  sourceDurationMs: true,
  sourceWidth: true,
  sourceHeight: true,
  sourceFps: true,
  sourceBitrateKbps: true,
  sourceHasAudio: true,
  sourceRotation: true,
  sourceOrientation: true,
  sourceLengthClass: true,
  sourceAspectRatio: true,
  sourceEffectiveWidth: true,
  sourceEffectiveHeight: true,
  encodedVariantCount: true,
  encodedMaxHeight: true,
  encodedFps: true,
  seriesId: true,
  episodeNumber: true,
  series: {
    select: {
      id: true,
      title: true,
    },
  },
  transcriptSegments: true,
  createdAt: true,
  updatedAt: true,
} as const;

export function toReelDomain(record: Record<string, unknown>): Reel {
  const reel = new Reel();

  reel.id = record['id'] as string;
  reel.userId = record['userId'] as string;
  reel.mediaKey = record['mediaKey'] as string;
  reel.title = (record['title'] as string | null) ?? undefined;
  reel.description = (record['description'] as string | null) ?? undefined;
  reel.tags = (record['tags'] as string[]) ?? [];
  const persistedLegacyStatus = record['status'] as Reel['status'];
  reel.mediaStatus =
    (record['mediaStatus'] as Reel['mediaStatus'] | undefined) ??
    (persistedLegacyStatus === 'COMPLETED'
      ? 'COMPLETED'
      : persistedLegacyStatus === 'FAILED'
        ? 'FAILED'
        : persistedLegacyStatus === 'PROCESSING'
          ? 'PROCESSING'
          : 'PENDING');
  reel.indexStatus =
    (record['indexStatus'] as Reel['indexStatus'] | undefined) ??
    (persistedLegacyStatus === 'COMPLETED' ? 'COMPLETED' : 'NOT_REQUESTED');
  reel.status = mapReelLegacyStatus({
    mediaStatus: reel.mediaStatus,
    indexStatus: reel.indexStatus,
  });
  reel.visibility = (record['visibility'] as Reel['visibility']) ?? 'public';
  reel.viewCount = record['viewCount'] as bigint;
  reel.transcript = (record['transcript'] as string | null) ?? undefined;
  reel.transcriptVtt = (record['transcriptVtt'] as string | null) ?? undefined;
  reel.transcriptSegments =
    (record['transcriptSegments'] as TranscriptSegment[] | null) ?? undefined;
  reel.thumbnailKey = (record['thumbnailKey'] as string | null) ?? undefined;
  reel.hlsMasterKey = (record['hlsMasterKey'] as string | null) ?? undefined;
  reel.transcriptionAudioManifestKey =
    (record['transcriptionAudioManifestKey'] as string | null) ?? undefined;
  reel.mediaOutput =
    (record['mediaOutput'] as ReelMediaOutput | null) ?? undefined;
  reel.mediaEdit = (record['mediaEdit'] as ReelMediaEdit | null) ?? undefined;
  reel.outputDurationMs =
    (record['outputDurationMs'] as number | null) ?? undefined;
  reel.processingStage =
    (record['processingStage'] as string | null) ?? undefined;
  reel.processingMessage =
    (record['processingMessage'] as string | null) ?? undefined;
  reel.processingProgress =
    (record['processingProgress'] as number | null) ?? undefined;
  reel.processingAttemptId =
    (record['processingAttemptId'] as string | null) ?? undefined;
  reel.processingStartedAt =
    (record['processingStartedAt'] as Date | null) ?? undefined;
  reel.processingFailedAt =
    (record['processingFailedAt'] as Date | null) ?? undefined;
  reel.processingCompletedAt =
    (record['processingCompletedAt'] as Date | null) ?? undefined;
  reel.processingErrorCode =
    (record['processingErrorCode'] as string | null) ?? undefined;
  reel.processingErrorDetail =
    (record['processingErrorDetail'] as string | null) ?? undefined;
  reel.mediaAttemptId =
    (record['mediaAttemptId'] as string | null) ?? undefined;
  reel.indexAttemptId =
    (record['indexAttemptId'] as string | null) ?? undefined;
  reel.indexVersion = (record['indexVersion'] as string | null) ?? undefined;
  reel.indexCompletedAt =
    (record['indexCompletedAt'] as Date | null) ?? undefined;
  reel.indexDocumentCount =
    (record['indexDocumentCount'] as number | null) ?? undefined;
  reel.indexSectionCount =
    (record['indexSectionCount'] as number | null) ?? undefined;
  reel.indexChunkCount =
    (record['indexChunkCount'] as number | null) ?? undefined;
  reel.indexEmbeddingProvider =
    (record['indexEmbeddingProvider'] as string | null) ?? undefined;
  reel.indexEmbeddingModel =
    (record['indexEmbeddingModel'] as string | null) ?? undefined;
  reel.indexEmbeddingDimensions =
    (record['indexEmbeddingDimensions'] as number | null) ?? undefined;
  reel.indexEmbeddingVersion =
    (record['indexEmbeddingVersion'] as string | null) ?? undefined;
  reel.sourceDurationMs =
    (record['sourceDurationMs'] as number | null) ?? undefined;
  reel.sourceWidth = (record['sourceWidth'] as number | null) ?? undefined;
  reel.sourceHeight = (record['sourceHeight'] as number | null) ?? undefined;
  reel.sourceFps = (record['sourceFps'] as number | null) ?? undefined;
  reel.sourceBitrateKbps =
    (record['sourceBitrateKbps'] as number | null) ?? undefined;
  reel.sourceHasAudio =
    (record['sourceHasAudio'] as boolean | null) ?? undefined;
  reel.sourceRotation =
    (record['sourceRotation'] as number | null) ?? undefined;
  reel.sourceOrientation =
    (record['sourceOrientation'] as Reel['sourceOrientation'] | null) ??
    undefined;
  reel.sourceLengthClass =
    (record['sourceLengthClass'] as Reel['sourceLengthClass'] | null) ??
    undefined;
  reel.sourceAspectRatio =
    (record['sourceAspectRatio'] as number | null) ?? undefined;
  reel.sourceEffectiveWidth =
    (record['sourceEffectiveWidth'] as number | null) ?? undefined;
  reel.sourceEffectiveHeight =
    (record['sourceEffectiveHeight'] as number | null) ?? undefined;
  reel.encodedVariantCount =
    (record['encodedVariantCount'] as number | null) ?? undefined;
  reel.encodedMaxHeight =
    (record['encodedMaxHeight'] as number | null) ?? undefined;
  reel.encodedFps = (record['encodedFps'] as number | null) ?? undefined;
  const series = record['series'] as
    | { id: string; title: string }
    | null
    | undefined;
  const episodeNumber =
    (record['episodeNumber'] as number | null | undefined) ?? undefined;
  reel.series =
    series && episodeNumber !== undefined
      ? {
          id: series.id,
          title: series.title,
          episodeNumber,
        }
      : undefined;
  reel.createdAt = record['createdAt'] as Date;
  reel.updatedAt = record['updatedAt'] as Date;

  return reel;
}

export function toReelSeriesDomain(
  record: Record<string, unknown>,
): ReelSeries {
  return new ReelSeries({
    id: record['id'] as string,
    ownerId: record['ownerId'] as string,
    title: record['title'] as string,
    description: (record['description'] as string | null) ?? undefined,
    visibility: record['visibility'] as ReelSeries['visibility'],
    createdAt: record['createdAt'] as Date,
    updatedAt: record['updatedAt'] as Date,
    reels: (
      (record['reels'] as Record<string, unknown>[] | undefined) ?? []
    ).map((reel) => toReelDomain(reel)),
  });
}