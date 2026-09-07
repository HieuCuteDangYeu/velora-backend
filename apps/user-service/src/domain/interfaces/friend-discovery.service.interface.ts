import type { FriendFeedAudienceResponse } from '@common/friend/interfaces/friend-content-access.interface';
import type { FriendGraphRecommendationResponse } from '@common/friend/interfaces/friend-recommendation.interface';

export interface IFriendDiscoveryService {
  getAudience(userId: string): Promise<FriendFeedAudienceResponse>;

  getGraphRecommendations(
    userId: string,
    limit: number,
  ): Promise<FriendGraphRecommendationResponse>;
}
