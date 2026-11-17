import { ReelAuthorSummary } from '@common/content/interfaces/reel-response.interface';
import { PublicUserProfile } from '@common/user/interfaces/public-user-profile.types';
import { Inject, Injectable, Logger } from '@nestjs/common';
import { ClientProxy } from '@nestjs/microservices';
import { catchError, lastValueFrom, of, timeout } from 'rxjs';

// Author names and avatars change rarely and are only display data, so list responses
// reuse a looked-up profile instead of calling user-service every page. A profile is fresh
// for a minute; after that it is still served (up to the stale limit) while one background
// lookup refreshes it, so no request waits for user-service once an author is known. The
// lookup measured 0.6-1.6 s while user-service was busy, and every request that met an
// expired entry paid that, each with a lookup of its own.
export const REEL_AUTHOR_CACHE_TTL_MS = 60_000;
export const REEL_AUTHOR_STALE_LIMIT_MS = 30 * 60_000;
const REEL_AUTHOR_LOOKUP_TIMEOUT_MS = 3_000;
const REEL_AUTHOR_CACHE_MAX_ENTRIES = 5_000;

@Injectable()
export class ReelAuthorService {
  private readonly logger = new Logger(ReelAuthorService.name);
  private readonly authorCache = new Map<
    string,
    { expiresAt: number; staleUntil: number; author: ReelAuthorSummary }
  >();
  // One lookup per author at a time, shared by every request that needs it.
  private readonly lookups = new Map<string, Promise<void>>();

  constructor(
    @Inject('USER_SERVICE') private readonly userClient: ClientProxy,
  ) {}

  async loadAuthorMap(
    userIds: string[],
  ): Promise<Map<string, ReelAuthorSummary>> {
    const uniqueIds = [...new Set(userIds.filter(Boolean))];

    if (uniqueIds.length === 0) {
      return new Map();
    }

    const now = Date.now();
    const authorsById = new Map<string, ReelAuthorSummary>();
    const missingIds: string[] = [];
    const staleIds: string[] = [];

    for (const userId of uniqueIds) {
      const cached = this.authorCache.get(userId);
      if (cached && cached.staleUntil > now) {
        authorsById.set(userId, cached.author);
        if (cached.expiresAt <= now) staleIds.push(userId);
      } else {
        missingIds.push(userId);
      }
    }

    if (staleIds.length > 0) {
      // Not awaited: the stale profile is good enough for this response.
      void this.lookup(staleIds);
    }

    if (missingIds.length === 0) {
      return authorsById;
    }

    await this.lookup(missingIds);

    for (const userId of missingIds) {
      authorsById.set(
        userId,
        this.authorCache.get(userId)?.author ??
          this.buildFallbackAuthor(userId),
      );
    }

    return authorsById;
  }

  /** Looks the ids up, joining any lookup already running for them. Never rejects. */
  private lookup(userIds: string[]): Promise<void> {
    const toFetch = userIds.filter((userId) => !this.lookups.has(userId));

    if (toFetch.length > 0) {
      const fetching = this.fetchProfiles(toFetch).finally(() => {
        for (const userId of toFetch) this.lookups.delete(userId);
      });
      for (const userId of toFetch) this.lookups.set(userId, fetching);
    }

    const pending = new Set<Promise<void>>();
    for (const userId of userIds) {
      const running = this.lookups.get(userId);
      if (running) pending.add(running);
    }

    return Promise.all([...pending]).then(() => undefined);
  }

  private async fetchProfiles(userIds: string[]): Promise<void> {
    const profiles = await lastValueFrom(
      this.userClient
        .send<PublicUserProfile[]>('user.find_public_by_ids', userIds)
        .pipe(
          timeout(REEL_AUTHOR_LOOKUP_TIMEOUT_MS),
          catchError((error: unknown) => {
            const message =
              error instanceof Error ? error.message : String(error);

            this.logger.warn(
              `Failed to load reel author summaries: ${message}`,
            );

            return of([] as PublicUserProfile[]);
          }),
        ),
    );

    if (this.authorCache.size >= REEL_AUTHOR_CACHE_MAX_ENTRIES) {
      this.authorCache.clear();
    }

    const now = Date.now();
    for (const profile of profiles) {
      // Only real profiles are cached, so a failed lookup is retried next time.
      this.authorCache.set(profile.id, {
        expiresAt: now + REEL_AUTHOR_CACHE_TTL_MS,
        staleUntil: now + REEL_AUTHOR_STALE_LIMIT_MS,
        author: this.toAuthorSummary(profile),
      });
    }
  }

  resolveAuthor(
    authorsById: Map<string, ReelAuthorSummary>,
    userId: string,
  ): ReelAuthorSummary {
    return authorsById.get(userId) ?? this.buildFallbackAuthor(userId);
  }

  private toAuthorSummary(profile: PublicUserProfile): ReelAuthorSummary {
    return {
      id: profile.id,
      username: profile.username,
      displayName: profile.fullName ?? null,
      avatarUrl: profile.picture,
      isVerified: profile.isVerified,
    };
  }

  private buildFallbackAuthor(userId: string): ReelAuthorSummary {
    return {
      id: userId,
      username: null,
      displayName: null,
      avatarUrl: null,
      isVerified: null,
    };
  }
}
