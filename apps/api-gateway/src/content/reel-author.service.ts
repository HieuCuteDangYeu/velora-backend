import { ReelAuthorSummary } from '@common/content/interfaces/reel-response.interface';
import { PublicUserProfile } from '@common/user/interfaces/public-user-profile.types';
import { Inject, Injectable, Logger } from '@nestjs/common';
import { ClientProxy } from '@nestjs/microservices';
import { catchError, lastValueFrom, of, timeout } from 'rxjs';

// Author names and avatars change rarely and are only display data, so list responses
// reuse a looked-up profile for a minute instead of calling user-service every page.
export const REEL_AUTHOR_CACHE_TTL_MS = 60_000;
const REEL_AUTHOR_LOOKUP_TIMEOUT_MS = 3_000;
const REEL_AUTHOR_CACHE_MAX_ENTRIES = 5_000;

@Injectable()
export class ReelAuthorService {
  private readonly logger = new Logger(ReelAuthorService.name);
  private readonly authorCache = new Map<
    string,
    { expiresAt: number; author: ReelAuthorSummary }
  >();

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

    for (const userId of uniqueIds) {
      const cached = this.authorCache.get(userId);
      if (cached && cached.expiresAt > now) {
        authorsById.set(userId, cached.author);
      } else {
        missingIds.push(userId);
      }
    }

    if (missingIds.length === 0) {
      return authorsById;
    }

    const profiles = await lastValueFrom(
      this.userClient
        .send<PublicUserProfile[]>('user.find_public_by_ids', missingIds)
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

    for (const userId of missingIds) {
      authorsById.set(userId, this.buildFallbackAuthor(userId));
    }

    if (this.authorCache.size >= REEL_AUTHOR_CACHE_MAX_ENTRIES) {
      this.authorCache.clear();
    }

    for (const profile of profiles) {
      const author = this.toAuthorSummary(profile);
      authorsById.set(profile.id, author);
      // Only real profiles are cached, so a failed lookup is retried next time.
      this.authorCache.set(profile.id, {
        expiresAt: now + REEL_AUTHOR_CACHE_TTL_MS,
        author,
      });
    }

    return authorsById;
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
