import type { RecommendationFeatureFlags } from '@common/recommendation/interfaces/recommendation-metadata.interface';

export interface IRecommendationConfig {
  getAlgorithmVersion(): string;
  getCandidateSource(): string;
  getFeatureFlags(): RecommendationFeatureFlags;
  getFeedSessionTtlSeconds(): number;
  getFeedSlateSize(): number;
  isTelemetryEnabled(): boolean;
}
