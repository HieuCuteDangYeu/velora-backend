import type { RecommendationMetadata } from '@common/recommendation/interfaces/recommendation-metadata.interface';

export interface PublicUserProfile {
  id: string;
  fullName: string;
  username: string | null;
  picture: string | null;
  isVerified: boolean;
}

export interface RecommendedPublicUserProfile extends PublicUserProfile {
  mutualFriendCount?: number;
  recommendation: RecommendationMetadata;
}
