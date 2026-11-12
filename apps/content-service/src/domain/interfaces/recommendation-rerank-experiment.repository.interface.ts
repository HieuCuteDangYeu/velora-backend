export type RecommendationRerankArm = 'treatment' | 'control';

export interface RecommendationRerankExposure {
  feedSessionId: string;
  reelId: string;
  userId: string;
  arm: RecommendationRerankArm;
  /** 1-based position in the feature-ranked order, before the cross-encoder. */
  baseRank: number;
  /** 1-based position after the cross-encoder shift (the order treatment serves). */
  rerankedRank: number;
  crossScore: number;
  topK: number;
  weight: number;
}

export interface IRecommendationRerankExperimentRepository {
  record(exposures: RecommendationRerankExposure[]): Promise<void>;
}
