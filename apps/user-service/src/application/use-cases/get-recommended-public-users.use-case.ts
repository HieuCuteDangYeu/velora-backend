import { Inject, Injectable } from '@nestjs/common';
import type { IFriendDiscoveryService } from '@user/domain/interfaces/friend-discovery.service.interface';
import type { IRecommendationConfig } from '@user/domain/interfaces/recommendation-config.interface';
import type { IRecommendationTelemetryService } from '@user/domain/interfaces/recommendation-telemetry-service.interface';
import type {
  GetRecommendedPublicUsersInput,
  RecommendedPublicUserProfile,
} from '@user/domain/interfaces/recommended-public-user.interface';
import type { IUserRepository } from '@user/domain/interfaces/user.repository.interface';

@Injectable()
export class GetRecommendedPublicUsersUseCase {
  constructor(
    @Inject('IUserRepository')
    private readonly userRepository: IUserRepository,

    @Inject('IFriendDiscoveryService')
    private readonly friendDiscoveryService: IFriendDiscoveryService,

    @Inject('IRecommendationConfig')
    private readonly recommendationConfig: IRecommendationConfig,

    @Inject('IRecommendationTelemetryService')
    private readonly recommendationTelemetryService: IRecommendationTelemetryService,
  ) {}

  async execute(
    input: GetRecommendedPublicUsersInput,
  ): Promise<RecommendedPublicUserProfile[]> {
    const limit = Math.min(Math.max(input.limit ?? 20, 1), 30);

    const feedSessionId = input.feedSessionId ?? globalThis.crypto.randomUUID();

    const algorithmVersion = this.recommendationConfig.getAlgorithmVersion();

    const graphCandidateSource = this.recommendationConfig.getCandidateSource();

    const featureFlags = this.recommendationConfig.getFeatureFlags();

    const startedAt = Date.now();

    try {
      const graphResponse =
        await this.friendDiscoveryService.getGraphRecommendations(
          input.viewerId,
          Math.min(limit * 4, 100),
        );

      const graphUsers = graphResponse.candidates.length
        ? await this.userRepository.findByIds(
            graphResponse.candidates.map((candidate) => candidate.userId),
          )
        : [];

      const usersById = new Map(
        graphUsers
          .filter((user) => user.id)
          .map((user) => [user.id!, user] as const),
      );

      const graphRankedUsers = graphResponse.candidates
        .flatMap((candidate) => {
          const user = usersById.get(candidate.userId);

          if (!user?.username) {
            return [];
          }

          return [{ candidate, user }];
        })
        .slice(0, limit);

      const remaining = Math.max(0, limit - graphRankedUsers.length);

      const fallbackUsers = remaining
        ? await this.userRepository.findRecommendedPublicUsers({
            limit: remaining,
            excludedUserIds: [
              ...new Set([
                ...graphResponse.excludedUserIds,
                ...graphResponse.candidates.map(
                  (candidate) => candidate.userId,
                ),
              ]),
            ],
          })
        : [];

      const generatedAt = new Date().toISOString();

      const rankedUsers = [
        ...graphRankedUsers.map(({ user, candidate }) => ({
          user,
          candidateSource: graphCandidateSource,
          candidateSources: candidate.candidateSources,
          mutualFriendCount: candidate.mutualFriendCount,
        })),
        ...fallbackUsers.map((user) => ({
          user,
          candidateSource: 'PUBLIC_USER_FALLBACK',
          candidateSources: ['PUBLIC_USER_FALLBACK'],
          mutualFriendCount: undefined,
        })),
      ];

      const result = rankedUsers.map((item, index) => ({
        id: item.user.id!,
        fullName: item.user.fullName,
        username: item.user.username,
        picture: item.user.picture,
        isVerified: item.user.isVerified,
        mutualFriendCount: item.mutualFriendCount,
        recommendation: {
          recommendationId: globalThis.crypto.randomUUID(),
          feedSessionId,
          algorithmVersion,
          candidateSource: item.candidateSource,
          candidateSources: item.candidateSources,
          rank: index + 1,
          generatedAt,
        },
      }));

      const telemetryCandidateSource =
        graphRankedUsers.length > 0
          ? fallbackUsers.length > 0
            ? `${graphCandidateSource}_WITH_PUBLIC_FALLBACK`
            : graphCandidateSource
          : 'PUBLIC_USER_FALLBACK';

      this.publishTelemetry({
        eventId: globalThis.crypto.randomUUID(),
        recommendationType: 'USER',
        algorithmVersion,
        feedSessionId,
        route: 'user.get_recommended_public',
        candidateSource: telemetryCandidateSource,
        requestedLimit: limit,
        returnedItems: result.length,
        latencyMs: Math.max(0, Date.now() - startedAt),
        outcome: 'SUCCEEDED',
        featureFlags,
        occurredAt: generatedAt,
      });

      return result;
    } catch (error) {
      const occurredAt = new Date().toISOString();

      this.publishTelemetry({
        eventId: globalThis.crypto.randomUUID(),
        recommendationType: 'USER',
        algorithmVersion,
        feedSessionId,
        route: 'user.get_recommended_public',
        candidateSource: graphCandidateSource,
        requestedLimit: limit,
        returnedItems: 0,
        latencyMs: Math.max(0, Date.now() - startedAt),
        outcome: 'FAILED',
        errorCode: this.errorCode(error),
        featureFlags,
        occurredAt,
      });

      throw error;
    }
  }

  private publishTelemetry(
    event: Parameters<IRecommendationTelemetryService['publish']>[0],
  ): void {
    if (!this.recommendationConfig.isTelemetryEnabled()) {
      return;
    }

    this.recommendationTelemetryService.publish(event);
  }

  private errorCode(error: unknown): string {
    if (error instanceof Error && error.name.trim()) {
      return error.name.slice(0, 100);
    }

    return 'UNKNOWN_ERROR';
  }
}
