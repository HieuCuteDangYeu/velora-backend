import type { RecommendationCandidateSource } from '@content/domain/interfaces/recommendation.interface';

export interface RecommendationFeedSessionItem {
  reelId: string;
  primarySource: RecommendationCandidateSource;
  sources: RecommendationCandidateSource[];
}

export interface RecommendationFeedSession {
  feedSessionId: string;
  viewerId: string;
  algorithmVersion: string;
  generatedAt: string;
  items: RecommendationFeedSessionItem[];
}

export interface IRecommendationFeedSessionRepository {
  get(feedSessionId: string): Promise<RecommendationFeedSession | null>;
  save(session: RecommendationFeedSession, ttlSeconds: number): Promise<void>;
}
