import type { Reel } from '@content/domain/entities/reel.entity';
import type { RecommendationFeedSessionItem } from '@content/domain/interfaces/recommendation-feed-session.repository.interface';

export interface RecommendationGlobalSlate {
  generatedAt: string;
  items: RecommendationFeedSessionItem[];
}

export interface IRecommendationFeedCacheRepository {
  getGlobalSlate(): Promise<RecommendationGlobalSlate | null>;
  saveGlobalSlate(
    slate: RecommendationGlobalSlate,
    ttlSeconds: number,
  ): Promise<void>;
  getReels(reelIds: string[]): Promise<Reel[]>;
  saveReels(reels: Reel[], ttlSeconds: number): Promise<void>;
  invalidateReels(reelIds: string[]): Promise<void>;
}
