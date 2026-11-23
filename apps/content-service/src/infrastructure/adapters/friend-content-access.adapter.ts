import type {
  CanViewReelContentResponse,
  FriendFeedAudienceResponse,
} from '@common/friend/interfaces/friend-content-access.interface';
import type { IFriendContentAccessService } from '@content/domain/interfaces/friend-content-access.service.interface';
import { ThrottledWarn } from '@content/application/services/throttled-warn';
import { TtlPromiseCache } from '@content/application/services/ttl-promise-cache';
import {
  Inject,
  Injectable,
  Logger,
  type OnModuleDestroy,
  type OnModuleInit,
} from '@nestjs/common';
import { ClientProxy } from '@nestjs/microservices';
import {
  TimeoutError,
  catchError,
  firstValueFrom,
  of,
  retry,
  throwError,
  timeout,
} from 'rxjs';

const FEED_AUDIENCE_ATTEMPT_TIMEOUT_MS = 2_000;

// The audience (friends plus blocked/blocking users) is fetched from friend-service on
// every friends feed, tag page and recommendation refill. Reusing it for a few seconds
// removes that hop from the hot path; a new block or unfriend therefore reaches these
// feeds up to this long later. A recommendation session already keeps its own audience
// snapshot for the whole session, so this is tighter than what feeds had before.
export const FEED_AUDIENCE_CACHE_TTL_MS = 15_000;
// An audience is refreshed in the background during its last 5 s, so a viewer who keeps
// browsing never waits for friend-service at an expiry (13 of 158,605 requests did at 1550
// viewers, when the lookup timed out twice). It is never older than the ttl above, so the
// bound on how late a block takes effect is unchanged.
export const FEED_AUDIENCE_REFRESH_AHEAD_MS = 5_000;
// Same window for "this viewer may open this owner's reels". Only a yes is remembered, so
// a newly allowed viewer gets in at once and only a new block can lag, by up to this long.
export const REEL_ACCESS_CACHE_TTL_MS = 15_000;

// friend-service runs on another node and keeps its own database connections. After a few
// minutes without traffic the first audience lookup measured 1.2-2.6 s instead of 0.6-0.8 s
// (60 s and 120 s idle were fine, 240 s was not), which left a new feed session without its
// audience snapshot while the app was already asking for page 2. A cheap lookup for a user
// that has no friends keeps those connections warm. 0 turns it off.
const WARMUP_INTERVAL_MS = (() => {
  const parsed = Number(process.env.REEL_FRIEND_WARMUP_INTERVAL_MS);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 60_000;
})();
export const FRIEND_WARMUP_USER_ID = '00000000-0000-4000-8000-000000000000';

@Injectable()
export class FriendContentAccessAdapter
  implements IFriendContentAccessService, OnModuleInit, OnModuleDestroy
{
  private readonly logger = new Logger(FriendContentAccessAdapter.name);
  private readonly throttledWarn = new ThrottledWarn(this.logger);
  private warmupTimer: NodeJS.Timeout | undefined;
  private readonly audienceCache =
    new TtlPromiseCache<FriendFeedAudienceResponse>(
      FEED_AUDIENCE_CACHE_TTL_MS,
      2_000,
      Date.now,
      () => true,
      FEED_AUDIENCE_REFRESH_AHEAD_MS,
    );
  private readonly accessCache = new TtlPromiseCache<boolean>(
    REEL_ACCESS_CACHE_TTL_MS,
    5_000,
    Date.now,
    (allowed) => allowed,
  );

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
          // The lookup answers in about 0.8 s, but a request is now and then lost or stuck
          // behind the other node for the whole old 5 s timeout while a feed page waits for it.
          // A second attempt after 2 s usually succeeds; any other error is not retried.
          timeout(FEED_AUDIENCE_ATTEMPT_TIMEOUT_MS),
          retry({
            count: 1,
            delay: (error: unknown) =>
              error instanceof TimeoutError ? of(0) : throwError(() => error),
          }),
          catchError((error: unknown) => {
            this.throttledWarn.warn(
              'audience-lookup-failed',
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
    // friend-service answers these two before it touches its database, so answer them
    // here and skip the round trip to the other node (about 225 ms) with the same result.
    if (input.viewerId === input.ownerId) return true;
    if (input.visibility === 'private') return false;

    return await this.accessCache.get(
      `${input.viewerId}|${input.ownerId}|${input.visibility}`,
      () => this.fetchCanView(input),
    );
  }

  onModuleInit(): void {
    if (WARMUP_INTERVAL_MS <= 0) return;

    this.warmupTimer = setInterval(() => {
      void this.warmUp();
    }, WARMUP_INTERVAL_MS);
    this.warmupTimer.unref();
    void this.warmUp();
  }

  onModuleDestroy(): void {
    if (this.warmupTimer) clearInterval(this.warmupTimer);
    this.warmupTimer = undefined;
  }

  private async warmUp(): Promise<void> {
    try {
      await firstValueFrom(
        this.friendClient
          .send('friend.get_reel_feed_audience', {
            userId: FRIEND_WARMUP_USER_ID,
          })
          .pipe(timeout(5000)),
      );
    } catch (error: unknown) {
      this.logger.debug(
        `Friend-service warm-up skipped: ${this.describeError(error)}`,
      );
    }
  }

  private async fetchCanView(input: {
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
            this.throttledWarn.warn(
              'access-lookup-failed',
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
