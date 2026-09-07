import { TranscriptSegment } from '@common/ai/interfaces/transcription-result.interface';
import type { ReelMediaEdit } from '@common/content/schemas/reel-edit.schema';
import type {
  LegacyReelStatus,
  ReelIndexStatus,
  ReelMediaStatus,
  ReelSourceLengthClass,
  ReelSourceOrientation,
} from '@common/content/interfaces/reel-state.interface';
import type { RecommendationMetadata } from '@common/recommendation/interfaces/recommendation-metadata.interface';

export type ReelVisibility = 'public' | 'friends' | 'private';
export type ReelPlaybackPresentation = 'PORTRAIT_COVER' | 'FIT_WITH_LETTERBOX';

export interface ReelAuthorSummary {
  id: string;
  username: string | null;
  displayName: string | null;
  avatarUrl: string | null;
  isVerified: boolean | null;
}

export interface ReelListItem {
  id: string;
  userId: string;
  mediaKey: string;
  hlsMasterKey?: string;
  title?: string;
  description?: string;
  tags: string[];
  status: LegacyReelStatus;
  mediaStatus: ReelMediaStatus;
  indexStatus: ReelIndexStatus;
  visibility: ReelVisibility;
  viewCount: number;
  thumbnailKey?: string;
  thumbnailUrl?: string;
  processingStage?: string;
  processingMessage?: string;
  processingProgress?: number;
  durationMs?: number;
  outputDurationMs?: number;
  sourceOrientation?: ReelSourceOrientation;
  sourceLengthClass?: ReelSourceLengthClass;
  edit?: ReelMediaEdit;
  playbackPresentation?: ReelPlaybackPresentation;
  sourceAspectRatio?: number;
  sourceEffectiveWidth?: number;
  sourceEffectiveHeight?: number;
  streamUrl: string;
  createdAt: string;
  recommendation?: RecommendationMetadata;
}

export interface ReelDetail extends ReelListItem {
  transcript?: string;
  transcriptVtt?: string;
  transcriptSegments?: TranscriptSegment[];
}

export interface ReelFeedListItem extends ReelListItem {
  author: ReelAuthorSummary;
}

export interface PaginatedReels<T> {
  items: T[];
  nextCursor: string | null;
  total?: number;
  feedSessionId?: string;
  algorithmVersion?: string;
  generatedAt?: string;
}
