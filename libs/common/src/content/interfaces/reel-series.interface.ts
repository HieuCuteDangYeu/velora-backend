import type { ReelVisibility } from '@common/content/schemas/reel-visibility.schema';

export interface ReelSeriesSummary {
  id: string;
  title: string;
  episodeNumber: number;
}

export interface ReelSeriesResponse<TReel> {
  id: string;
  ownerId: string;
  title: string;
  description?: string;
  visibility: ReelVisibility;
  createdAt: string;
  updatedAt: string;
  reels: TReel[];
}

export interface PaginatedReelSeries<TReel> {
  items: ReelSeriesResponse<TReel>[];
  nextCursor: string | null;
}

export interface ReelSeriesListSummary {
  id: string;
  ownerId: string;
  title: string;
  description?: string;
  visibility: ReelVisibility;
  createdAt: string;
  updatedAt: string;
  episodeCount: number;
  firstReelId?: string;
  coverThumbnailKey?: string;
}

export interface ReelSeriesListItem extends Omit<ReelSeriesListSummary, 'coverThumbnailKey'> {
  coverThumbnailUrl?: string;
}

export interface PaginatedReelSeriesList {
  items: ReelSeriesListItem[];
  nextCursor: string | null;
}

export interface ReelSeriesMetadataResponse
  extends Omit<ReelSeriesListSummary, 'coverThumbnailKey' | 'firstReelId'> {}

export interface ReelSeriesEpisodeCursor {
  episodeNumber: number;
  id: string;
}

export interface ReelSeriesEpisodesPage<TReel> {
  series: ReelSeriesMetadataResponse;
  items: TReel[];
  previousCursor: string | null;
  nextCursor: string | null;
}
