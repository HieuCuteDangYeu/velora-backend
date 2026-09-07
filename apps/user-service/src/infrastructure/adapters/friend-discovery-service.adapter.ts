import type { FriendFeedAudienceResponse } from '@common/friend/interfaces/friend-content-access.interface';
import type { FriendGraphRecommendationResponse } from '@common/friend/interfaces/friend-recommendation.interface';
import { FriendGraphRecommendationResponseSchema } from '@common/friend/schemas/friend-recommendation.schema';
import { Inject, Injectable, Logger } from '@nestjs/common';
import { ClientProxy } from '@nestjs/microservices';
import type { IFriendDiscoveryService } from '@user/domain/interfaces/friend-discovery.service.interface';
import { catchError, lastValueFrom, throwError, timeout } from 'rxjs';

@Injectable()
export class FriendDiscoveryServiceAdapter implements IFriendDiscoveryService {
  private readonly logger = new Logger(FriendDiscoveryServiceAdapter.name);

  constructor(
    @Inject('FRIEND_SERVICE_RMQ')
    private readonly friendClient: ClientProxy,
  ) {}

  async getAudience(userId: string): Promise<FriendFeedAudienceResponse> {
    return await lastValueFrom(
      this.friendClient
        .send<FriendFeedAudienceResponse>('friend.get_reel_feed_audience', {
          userId,
        })
        .pipe(
          timeout(5000),
          catchError((error: unknown) => {
            const message =
              error instanceof Error ? error.message : String(error);

            this.logger.error(`RPC Error [getAudience]: ${message}`);

            // Fail closed. Search and recommendation endpoints must not
            // return users when block/friend exclusions cannot be loaded.
            return throwError(
              () => new Error('Failed to load friend discovery exclusions'),
            );
          }),
        ),
    );
  }

  async getGraphRecommendations(
    userId: string,
    limit: number,
  ): Promise<FriendGraphRecommendationResponse> {
    const response = await lastValueFrom(
      this.friendClient
        .send<unknown>('friend.get_graph_recommendations', {
          userId,
          limit,
        })
        .pipe(
          timeout(5000),
          catchError((error: unknown) => {
            const message =
              error instanceof Error ? error.message : String(error);

            this.logger.error(
              `RPC Error [getGraphRecommendations]: ${message}`,
            );

            return throwError(
              () => new Error('Failed to load graph friend recommendations'),
            );
          }),
        ),
    );

    return this.validateGraphRecommendationResponse(userId, response);
  }

  private validateGraphRecommendationResponse(
    viewerId: string,
    response: unknown,
  ): FriendGraphRecommendationResponse {
    const parsed = FriendGraphRecommendationResponseSchema.safeParse(response);

    if (!parsed.success) {
      this.logger.error(
        `Invalid graph recommendation response: ${parsed.error.message}`,
      );
      throw new Error('Invalid graph friend recommendation response');
    }

    const { candidates, excludedUserIds } = parsed.data;
    const excludedSet = new Set(excludedUserIds);

    if (excludedSet.size !== excludedUserIds.length) {
      throw new Error('Invalid graph friend recommendation exclusions');
    }

    if (!excludedSet.has(viewerId)) {
      throw new Error('Incomplete graph friend recommendation exclusions');
    }

    const candidateIds = candidates.map((candidate) => candidate.userId);
    const candidateSet = new Set(candidateIds);

    if (candidateSet.size !== candidateIds.length) {
      throw new Error('Invalid graph friend recommendation candidates');
    }

    if (candidateIds.some((candidateId) => excludedSet.has(candidateId))) {
      throw new Error('Conflicting graph friend recommendation candidates');
    }

    return parsed.data;
  }
}
