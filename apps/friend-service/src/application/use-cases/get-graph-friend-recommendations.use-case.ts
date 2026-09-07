import type {
  FriendGraphCandidateSource,
  FriendGraphRecommendationResponse,
} from '@common/friend/interfaces/friend-recommendation.interface';
import type { IFriendGraphRepository } from '@friend/domain/interfaces/friend-graph.repository.interface';
import type { IUserBlockRepository } from '@friend/domain/interfaces/user-block.repository.interface';
import { Inject, Injectable } from '@nestjs/common';

@Injectable()
export class GetGraphFriendRecommendationsUseCase {
  constructor(
    @Inject('IFriendGraphRepository')
    private readonly friendGraphRepository: IFriendGraphRepository,
    @Inject('IUserBlockRepository')
    private readonly userBlockRepository: IUserBlockRepository,
  ) {}

  async execute(
    userId: string,
    requestedLimit = 20,
  ): Promise<FriendGraphRecommendationResponse> {
    const limit = Math.min(Math.max(requestedLimit, 1), 100);
    const candidatePoolSize = Math.min(Math.max(limit * 4, 50), 200);

    const [rawCandidates, relationshipUserIds, blockedUserIds] =
      await Promise.all([
        this.friendGraphRepository.findTwoHopCandidates(
          userId,
          candidatePoolSize,
        ),
        this.friendGraphRepository.listRelationshipUserIds(userId),
        this.userBlockRepository.listExcludedUserIds(userId),
      ]);

    const excludedUserIds = [
      ...new Set([userId, ...relationshipUserIds, ...blockedUserIds]),
    ];
    const excludedSet = new Set(excludedUserIds);

    const eligible = rawCandidates.filter(
      (candidate) => !excludedSet.has(candidate.userId),
    );

    const maxMutualFriendCount = Math.max(
      1,
      ...eligible.map((candidate) => candidate.mutualFriendCount),
    );
    const maxAdamicAdarScore = Math.max(
      Number.EPSILON,
      ...eligible.map((candidate) => candidate.adamicAdarScore),
    );

    const candidateSources: FriendGraphCandidateSource[] = [
      'MUTUAL_FRIENDS',
      'ADAMIC_ADAR',
    ];

    const candidates = eligible
      .map((candidate) => {
        const mutualScore =
          candidate.mutualFriendCount / maxMutualFriendCount;
        const adamicAdarScore =
          candidate.adamicAdarScore / maxAdamicAdarScore;

        return {
          userId: candidate.userId,
          mutualFriendCount: candidate.mutualFriendCount,
          adamicAdarScore: Number(candidate.adamicAdarScore.toFixed(6)),
          graphScore: Number(
            (0.6 * mutualScore + 0.4 * adamicAdarScore).toFixed(6),
          ),
          candidateSources,
        };
      })
      .sort(
        (left, right) =>
          right.graphScore - left.graphScore ||
          right.mutualFriendCount - left.mutualFriendCount ||
          right.adamicAdarScore - left.adamicAdarScore ||
          left.userId.localeCompare(right.userId),
      )
      .slice(0, limit);

    return {
      candidates,
      excludedUserIds,
    };
  }
}
