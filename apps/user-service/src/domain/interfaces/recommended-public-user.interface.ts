import type { RecommendationMetadata } from '@common/recommendation/interfaces/recommendation-metadata.interface';

export interface GetRecommendedPublicUsersInput {
  viewerId: string;
  limit?: number;
  feedSessionId?: string;
  offset?: number;
}

export interface RecommendedPublicUserProfile {
  id: string;
  fullName: string;
  username: string | null;
  picture: string | null;
  isVerified: boolean;
  mutualFriendCount?: number;
  recommendation: RecommendationMetadata;
}
