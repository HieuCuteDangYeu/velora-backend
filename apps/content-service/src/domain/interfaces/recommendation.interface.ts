import type { Reel } from '@content/domain/entities/reel.entity';
import type { ReelCursor } from '@content/domain/interfaces/content.repository.interface';

export const RECOMMENDATION_CANDIDATE_SOURCES = [
  'RECENT_QUALITY',
  'TRENDING',
  'TAG_AFFINITY',
  'CREATOR_AFFINITY',
  'CONTENT_SIMILARITY',
  'SEMANTIC',
  'SOCIAL',
  'EXPLORATION',
] as const;

export type RecommendationCandidateSource =
  (typeof RECOMMENDATION_CANDIDATE_SOURCES)[number];

export interface RecommendationCandidateQuery {
  viewerId: string;
  limit: number;
  cursor?: ReelCursor;
  excludedUserIds: string[];
  excludedReelIds?: string[];
  friendUserIds: string[];
}

export interface RecommendationCandidateEvidence {
  reelId: string;
  source: RecommendationCandidateSource;
  sourceScore: number;
  reasons: string[];
}

export interface MergedRecommendationCandidate {
  reelId: string;
  primarySource: RecommendationCandidateSource;
  sources: RecommendationCandidateSource[];
  sourceScores: Partial<Record<RecommendationCandidateSource, number>>;
  reasons: string[];
  candidateScore: number;
}

export interface RecommendationReelEngagement {
  impressionCount: number;
  completionCount: number;
  replayCount: number;
  skipCount: number;
  averagePercentageWatched: number;
  completionRate: number;
  replayRate: number;
  skipRate: number;
  trendingScore: number;
}

export interface RecommendationRankingSnapshot {
  tagAffinityByTag: Record<string, number>;
  creatorAffinityByCreatorId: Record<string, number>;
  sessionTagIntentByTag: Record<string, number>;
  sessionCreatorIntentByCreatorId: Record<string, number>;
  recentCreatorImpressionsByCreatorId: Record<string, number>;
  recentTagImpressionsByTag: Record<string, number>;
  recentlySeenReelIds: string[];
  engagementByReelId: Record<string, RecommendationReelEngagement>;
}

export interface RecommendationRankingRequest {
  viewerId: string;
  reelIds: string[];
  feedSessionId: string;
}

export interface RecommendationScoreComponents {
  candidateScore: number;
  tagAffinityScore: number;
  creatorAffinityScore: number;
  contentSimilarityScore: number;
  trendingScore: number;
  freshnessScore: number;
  qualityScore: number;
  completionRate: number;
  replayRate: number;
  sessionIntentScore: number;
  skipRate: number;
  recentlySeenPenalty: number;
  creatorFatiguePenalty: number;
  topicFatiguePenalty: number;
}

export interface InternalRecommendationExplanation {
  strongestPositiveSignals: string[];
  appliedPenalties: string[];
  diversityAdjustments: string[];
  rawScore: number;
  finalScore: number;
}

export interface RankedRecommendationItem {
  reel: Reel;
  candidate: MergedRecommendationCandidate;
  dominantTopic: string | null;
  scoreComponents: RecommendationScoreComponents;
  explanation: InternalRecommendationExplanation;
  score: number;
}

export interface RecommendationPipelineResult {
  items: RankedRecommendationItem[];
  nextCursor: ReelCursor | null;
  rawCandidateCount: number;
  deduplicatedCandidateCount: number;
  sourceCounts: Partial<Record<RecommendationCandidateSource, number>>;
}
