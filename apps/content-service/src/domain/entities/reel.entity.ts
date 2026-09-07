import { TranscriptSegment } from '@common/ai/interfaces/transcription-result.interface';
import type {
  LegacyReelStatus,
  ReelIndexStatus,
  ReelMediaStatus,
  ReelSourceLengthClass,
  ReelSourceOrientation,
} from '@common/content/interfaces/reel-state.interface';
import { ReelVisibility } from '@common/content/schemas/reel-visibility.schema';
import type { RecommendationMetadata } from '@common/recommendation/interfaces/recommendation-metadata.interface';
import type { ReelMediaOutput } from '@common/processing/interfaces/reel-media-output.interface';
import type { ReelMediaEdit } from '@common/content/schemas/reel-edit.schema';

export class Reel {
  id: string;
  userId: string;
  mediaKey: string;
  title?: string;
  description?: string;
  tags: string[];
  status: LegacyReelStatus;
  mediaStatus: ReelMediaStatus;
  indexStatus: ReelIndexStatus;
  visibility: ReelVisibility;
  viewCount: bigint;
  transcript?: string;
  transcriptVtt?: string;
  transcriptSegments?: TranscriptSegment[];
  thumbnailKey?: string;
  hlsMasterKey?: string;
  transcriptionAudioManifestKey?: string;
  mediaOutput?: ReelMediaOutput;
  mediaEdit?: ReelMediaEdit;
  outputDurationMs?: number;
  processingStage?: string;
  processingMessage?: string;
  processingProgress?: number;
  processingAttemptId?: string;
  processingStartedAt?: Date;
  processingFailedAt?: Date;
  processingCompletedAt?: Date;
  processingErrorCode?: string;
  processingErrorDetail?: string;
  mediaAttemptId?: string;
  indexAttemptId?: string;
  indexVersion?: string;
  indexCompletedAt?: Date;
  indexDocumentCount?: number;
  indexSectionCount?: number;
  indexChunkCount?: number;
  indexEmbeddingProvider?: string;
  indexEmbeddingModel?: string;
  indexEmbeddingDimensions?: number;
  indexEmbeddingVersion?: string;
  sourceDurationMs?: number;
  sourceWidth?: number;
  sourceHeight?: number;
  sourceFps?: number;
  sourceBitrateKbps?: number;
  sourceHasAudio?: boolean;
  sourceRotation?: number;
  sourceOrientation?: ReelSourceOrientation;
  sourceLengthClass?: ReelSourceLengthClass;
  sourceAspectRatio?: number;
  sourceEffectiveWidth?: number;
  sourceEffectiveHeight?: number;
  encodedVariantCount?: number;
  encodedMaxHeight?: number;
  encodedFps?: number;
  createdAt: Date;
  updatedAt: Date;
  recommendation?: RecommendationMetadata;
}
