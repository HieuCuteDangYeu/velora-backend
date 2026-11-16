import type {
  CanViewReelContentResponse,
  FriendFeedAudienceResponse,
} from '@common/friend/interfaces/friend-content-access.interface';
import type { IFriendContentAccessService } from '@content/domain/interfaces/friend-content-access.service.interface';
import { TtlPromiseCache } from '@content/application/services/ttl-promise-cache';
import { Inject, Injectable, Logger } from '@nestjs/common';
import { ClientProxy } from '@nestjs/microservices';
import { catchError, firstValueFrom, of, throwError, timeout } from 'rxjs';

// The audience (friends plus blocked/blocking users) is fetched from friend-service on
// every friends feed, tag page and recommendation refill. Reusing it for a few seconds
// removes that hop from the hot path; a new block or unfriend therefore reaches these
// feeds up to this long later. A recommendation session already keeps its own audience
// snapshot for the whole session, so this is tighter than what feeds had before.
export const FEED_AUDIENCE_CACHE_TTL_MS = 15_000;

@Injectable()
export class FriendContentAccessAdapter implements IFriendContentAccessService {
  private readonly logger = new Logger(FriendContentAccessAdapter.name);
  private readonly audienceCache =
    new TtlPromiseCache<FriendFeedAudienceResponse>(FEED_AUDIENCE_CACHE_TTL_MS);

  constructor(
    @Inject('FRIEND_SERVICE_RMQ')
    private readonly friendClient: ClientProxy,
  ) {}

  async getFeedAudience(viewerId: string): Promise<FriendFeedAudienceResponse> {
    const audience = await this.audienceCache.get(viewerId, () =>
      this.fetchFeedAudience(viewerId),
    );

    // Callers get their own arrays so none can change what the next caller sees.
    return {
      ...audience,
      friendUserIds: [...audience.friendUserIds],
      excludedUserIds: [...audience.excludedUserIds],
    };
  }

  private fetchFeedAudience(
    viewerId: string,
  ): Promise<FriendFeedAudienceResponse> {
    return firstValueFrom(
      this.friendClient
        .send<FriendFeedAudienceResponse>('friend.get_reel_feed_audience', {
          userId: viewerId,
        })
        .pipe(
          timeout(5000),
          catchError((error: unknown) => {
            this.logger.warn(
              `Friend feed audience lookup failed: ${this.describeError(
                error,
              )}`,
            );

            return throwError(() => error);
          }),
        ),
    );
  }

  async canView(input: {
    viewerId: string;
    ownerId: string;
    visibility: 'public' | 'friends' | 'private';
  }): Promise<boolean> {
    const response = await firstValueFrom(
      this.friendClient
        .send<CanViewReelContentResponse>('friend.can_view_reel_content', input)
        .pipe(
          timeout(5000),
          catchError((error: unknown) => {
            this.logger.warn(
              `Reel content access lookup failed: ${this.describeError(error)}`,
            );

            return of({
              allowed: false,
            });
          }),
        ),
    );

    return response.allowed;
  }

  private describeError(error: unknown): string {
    if (error instanceof Error) {
      return error.message;
    }

    return String(error);
  }
}
