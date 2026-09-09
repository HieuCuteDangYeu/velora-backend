import { GetGraphFriendRecommendationsUseCase } from '@friend/application/use-cases/get-graph-friend-recommendations.use-case';
import { Controller } from '@nestjs/common';
import { MessagePattern, Payload } from '@nestjs/microservices';

@Controller()
export class FriendRecommendationController {
  constructor(
    private readonly getGraphFriendRecommendationsUseCase: GetGraphFriendRecommendationsUseCase,
  ) {}

  @MessagePattern('friend.get_graph_recommendations')
  async getGraphRecommendations(
    @Payload()
    data: {
      userId: string;
      limit?: number;
    },
  ) {
    return await this.getGraphFriendRecommendationsUseCase.execute(
      data.userId,
      data.limit ?? 20,
    );
  }
}
