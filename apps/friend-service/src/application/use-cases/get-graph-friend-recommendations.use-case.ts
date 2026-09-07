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

    const [rawCandidates, relationshipUserIds, blockedUserIds] =
      await Promise.all([
        this.friendGraphRepository.findTwoHopCandidates(userId),
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

    const ranked = eligible
      .map((candidate) => ({
        candidate,
        graphScore:
          0.6 *
            (candidate.mutualFriendCount / maxMutualFriendCount) +
          0.4 * (candidate.adamicAdarScore / maxAdamicAdarScore),
      }))
      .sort((left, right) => {
        if (right.graphScore !== left.graphScore) {
          return right.graphScore - left.graphScore;
        }

        if (
          right.candidate.mutualFriendCount !==
          left.candidate.mutualFriendCount
        ) {
          return (
            right.candidate.mutualFriendCount -
            left.candidate.mutualFriendCount
          );
        }

        if (
          right.candidate.adamicAdarScore !== left.candidate.adamicAdarScore
        ) {
          return (
            right.candidate.adamicAdarScore - left.candidate.adamicAdarScore
          );
        }

        return left.candidate.userId < right.candidate.userId
          ? -1
          : left.candidate.userId > right.candidate.userId
            ? 1
            : 0;
      })
      .slice(0, limit);

    const candidates = ranked.map(({ candidate, graphScore }) => ({
      userId: candidate.userId,
      mutualFriendCount: candidate.mutualFriendCount,
      adamicAdarScore: Number(candidate.adamicAdarScore.toFixed(6)),
      graphScore: Number(graphScore.toFixed(6)),
      candidateSources,
    }));

    return {
      candidates,
      excludedUserIds,
    };
  }
}
