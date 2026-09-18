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
