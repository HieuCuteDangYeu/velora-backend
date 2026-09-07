import { TranscriptSegment } from '@common/ai/interfaces/transcription-result.interface';
import type { CompleteReelIndexCommand } from '@common/processing/interfaces/complete-reel-index.interface';
import type { ReelContextAccessRequest } from '@common/content/interfaces/reel-context-search-request.interface';
import type {
  ReelIndexStatus,
  ReelMediaStatus,
  ReelSourceLengthClass,
  ReelSourceOrientation,
} from '@common/content/interfaces/reel-state.interface';
import type { ReelMediaJob } from '@common/processing/interfaces/reel-media-job.interface';
import type { ReelMediaOutput } from '@common/processing/interfaces/reel-media-output.interface';
import {
  SearchSuggestionItem,
  SearchSuggestionType,
} from '@common/search/interfaces/search-suggestions-response.interface';
import { ReelShareLink } from '../entities/reel-share-link.entity';
import { ReelShare } from '../entities/reel-share.entity';
import { Reel } from '../entities/reel.entity';

export interface ReelProcessingMediaMetadata {
  sourceDurationMs?: number;
  outputDurationMs?: number;
  sourceWidth?: number;
  sourceHeight?: number;
  sourceFps?: number;
  sourceBitrateKbps?: number;
  sourceHasAudio?: boolean;
  sourceRotation?: number;
  sourceCodec?: string;
  sourcePixelFormat?: string;
  sourceAudioCodec?: string;
  sourceFileSizeBytes?: number;
  sourceVariableFrameRate?: boolean;
  sourceOrientation?: ReelSourceOrientation;
  sourceLengthClass?: ReelSourceLengthClass;
  sourceAspectRatio?: number;
  sourceEffectiveWidth?: number;
  sourceEffectiveHeight?: number;
  encodedVariantCount?: number;
  encodedMaxHeight?: number;
  encodedFps?: number;
}

export interface ReelListQuery {
  userId?: string;
  viewerId?: string;
  visibility?: 'public' | 'private';
  limit?: number;
  cursor?: { createdAt: Date; id: string };
  onlyPublished?: boolean;
  ranked?: boolean;
}

export interface RecommendedReelsQuery {
  viewerId: string;
  limit?: number;
  cursor?: ReelCursor;
  excludeRecentlySeen?: boolean;
  excludedUserIds?: string[];
}

export interface ReelUpdateData {
  title?: string;
  description?: string;
  tags?: string[];
  visibility?: 'public' | 'friends' | 'private';
}

export interface ReelCursor {
  createdAt: Date;
  id: string;
}

export interface ReelProfileContextQuery {
  anchor: Reel;
  before: number;
  after: number;
}

export interface ReelProfileContextResult {
  items: Reel[];
  selectedIndex: number;
  previousCursor: ReelCursor | null;
  nextCursor: ReelCursor | null;
}

export interface ReelShareCreateInput {
  reelId: string;
  ownerId: string;
  sharedByUserId: string;
  sharedWithUserId?: string | null;
  conversationId: string;
  messageId?: string | null;
}

export interface ReelShareLinkCreateInput {
  reelId: string;
  ownerId: string;
  token: string;
  createdBy: string;
  expiresAt?: Date | null;
}

export interface ReelShareLinkWithReel {
  link: ReelShareLink;
  reel: Reel;
}

export interface ReelViewEventInput {
  reelId: string;
  userId: string;
  sessionId?: string;
  eventType:
    | 'IMPRESSION'
    | 'WATCH_START'
    | 'WATCH_PROGRESS'
    | 'WATCH_END'
    | 'SKIP'
    | 'COMPLETE'
    | 'REPLAY'
    | 'PAUSE'
    | 'RESUME'
    | 'MUTE'
    | 'UNMUTE';
  watchMs?: number;
  durationMs?: number;
  percentageWatched?: number;
  muted?: boolean;
  completed?: boolean;
  replayed?: boolean;
  skipped?: boolean;
}

export interface ReelSearchQuery {
  query: string;
  viewerId?: string;
  limit?: number;
}

export interface SearchSuggestionsQuery {
  viewerId?: string;
  type?: SearchSuggestionType;
  limit?: number;
}

export type SearchSuggestion = SearchSuggestionItem;

export interface ReelMediaOutboxEventInput {
  id: string;
  eventType: string;
  payload: ReelMediaJob;
  createdAt: Date;
}

export interface ReelSearchResult {
  reel: Reel;
  score: number;
}

export interface FriendsReelsQuery {
  friendUserIds: string[];
  excludedUserIds?: string[];
  limit?: number;
  cursor?: ReelCursor;
}

export interface IContentRepository {
  createReelWithMediaJob(
    reel: Partial<Reel>,
    outboxEvent: ReelMediaOutboxEventInput,
  ): Promise<Reel>;

  queueReelProcessingAttemptWithMediaJob(
    reelId: string,
    mediaAttemptId: string,
    indexAttemptId: string,
    outboxEvent: ReelMediaOutboxEventInput,
  ): Promise<Reel>;

  claimProcessingAttempt(input: {
    reelId: string;
    processingAttemptId: string;
    allowReclaim?: boolean;
  }): Promise<boolean>;

  completeMediaProcessing(input: {
    reelId: string;
    mediaAttemptId: string;
    mediaMetadata: ReelProcessingMediaMetadata;
    mediaOutput: ReelMediaOutput;
  }): Promise<boolean>;

  updateMediaStatus(input: {
    reelId: string;
    mediaAttemptId: string;
    mediaStatus: ReelMediaStatus;
  }): Promise<boolean>;

  updateIndexStatus(input: {
    reelId: string;
    indexAttemptId: string;
    indexStatus: ReelIndexStatus;
  }): Promise<boolean>;

  claimIndexingAttempt(input: {
    reelId: string;
    indexAttemptId: string;
    allowReclaim?: boolean;
  }): Promise<boolean>;

  reportIndexingProgress(input: {
    reelId: string;
    indexAttemptId: string;
    stage: string;
    progress: number;
  }): Promise<boolean>;

  completeIndexing(input: CompleteReelIndexCommand): Promise<boolean>;

  failIndexing(input: {
    reelId: string;
    indexAttemptId: string;
    errorDetail: string;
  }): Promise<boolean>;

  queueReelIndexingAttempt(reelId: string): Promise<string | null>;

  updateReelStatus(
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
  ): Promise<Reel>;

  findById(id: string): Promise<Reel | null>;

  shareReel(input: ReelShareCreateInput): Promise<ReelShare>;

  updateReelShareMessageId(
    shareId: string,
    messageId: string,
  ): Promise<ReelShare>;

  createReelShareLink(input: ReelShareLinkCreateInput): Promise<ReelShareLink>;

  findActiveReelShareLinkByReelAndCreator(input: {
    reelId: string;
    createdBy: string;
    now: Date;
  }): Promise<ReelShareLink | null>;

  findReelShareLinkByToken(
    token: string,
  ): Promise<ReelShareLinkWithReel | null>;

  incrementReelShareLinkClickCount(id: string): Promise<ReelShareLink>;

  revokeReelShareLink(input: {
    token: string;
    revokedByUserId: string;
  }): Promise<ReelShareLink | null>;

  findAccessibleSharedReelIds(
    input: ReelContextAccessRequest,
  ): Promise<string[]>;

  findSearchablePublicReels(ids: string[]): Promise<Reel[]>;

  getSearchSuggestions(
    query: SearchSuggestionsQuery,
  ): Promise<SearchSuggestion[]>;

  listRecommendedReels(query: RecommendedReelsQuery): Promise<{
    items: Reel[];
    nextCursor: ReelCursor | null;
  }>;

  listReels(query: ReelListQuery): Promise<{
    items: Reel[];
    nextCursor: ReelCursor | null;
  }>;

  getProfileReelContext(
    query: ReelProfileContextQuery,
  ): Promise<ReelProfileContextResult>;

  updateReel(
    id: string,
    data: ReelUpdateData,
    userId: string,
  ): Promise<Reel | null>;

  deleteReel(id: string, userId: string): Promise<boolean>;

  listFriendsReels(query: FriendsReelsQuery): Promise<{
    items: Reel[];
    nextCursor: ReelCursor | null;
  }>;
}
