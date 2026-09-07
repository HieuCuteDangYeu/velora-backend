export type FriendGraphCandidateSource =
  | 'MUTUAL_FRIENDS'
  | 'ADAMIC_ADAR';

export interface FriendGraphRecommendationCandidate {
  userId: string;
  mutualFriendCount: number;
  adamicAdarScore: number;
  graphScore: number;
  candidateSources: FriendGraphCandidateSource[];
}

export interface FriendGraphRecommendationResponse {
  candidates: FriendGraphRecommendationCandidate[];
  excludedUserIds: string[];
}
