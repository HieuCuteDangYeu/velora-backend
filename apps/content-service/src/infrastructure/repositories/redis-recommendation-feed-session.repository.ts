import type {
  IRecommendationFeedSessionRepository,
  RecommendationFeedSession,
} from '@content/domain/interfaces/recommendation-feed-session.repository.interface';
import { Inject, Injectable, Logger } from '@nestjs/common';
import { randomUUID } from 'crypto';
import type Redis from 'ioredis';

const RELEASE_REFILL_LOCK_SCRIPT = `
if redis.call('GET', KEYS[1]) == ARGV[1] then
  return redis.call('DEL', KEYS[1])
end
return 0
`;

@Injectable()
export class RedisRecommendationFeedSessionRepository implements IRecommendationFeedSessionRepository {
  private readonly logger = new Logger(
    RedisRecommendationFeedSessionRepository.name,
  );

  constructor(
    @Inject('REDIS_CLIENT')
    private readonly redis: Redis,
  ) {}

  async get(feedSessionId: string): Promise<RecommendationFeedSession | null> {
    try {
      await this.ensureConnected();
      const raw = await this.redis.get(this.key(feedSessionId));

      if (!raw) {
        return null;
      }

      return this.parseSession(raw, feedSessionId);
    } catch (error: unknown) {
      this.logger.warn(
        `Recommendation feed session cache unavailable for ${feedSessionId}: ${this.describeError(error)}`,
      );
      return null;
    }
  }

  async save(
    session: RecommendationFeedSession,
    ttlSeconds: number,
  ): Promise<void> {
    try {
      await this.ensureConnected();
      const key = this.key(session.feedSessionId);
      const existingRaw = await this.redis.get(key);

      if (existingRaw) {
        const existing = this.parseSession(existingRaw, session.feedSessionId);

        if (existing && existing.viewerId !== session.viewerId) {
          this.logger.warn(
            `Refusing to overwrite recommendation feed session ${session.feedSessionId} owned by another viewer`,
          );
          return;
        }
      }

      await this.redis.set(
        key,
        JSON.stringify(session),
        'EX',
        Math.max(1, Math.floor(ttlSeconds)),
      );
    } catch (error: unknown) {
      this.logger.warn(
        `Unable to cache recommendation feed session ${session.feedSessionId}: ${this.describeError(error)}`,
      );
    }
  }

  async tryAcquireRefillLock(
    feedSessionId: string,
    ttlSeconds: number,
  ): Promise<string | null> {
    try {
      await this.ensureConnected();
      const lockToken = randomUUID();
      const result = await this.redis.set(
        this.refillLockKey(feedSessionId),
        lockToken,
        'EX',
        Math.max(1, Math.floor(ttlSeconds)),
        'NX',
      );
      return result === 'OK' ? lockToken : null;
    } catch (error: unknown) {
      this.logger.warn(
        `Unable to acquire recommendation refill lock ${feedSessionId}: ${this.describeError(error)}`,
      );
      return null;
    }
  }

  async releaseRefillLock(
    feedSessionId: string,
    lockToken: string,
  ): Promise<void> {
    try {
      await this.ensureConnected();
      await this.redis.eval(
        RELEASE_REFILL_LOCK_SCRIPT,
        1,
        this.refillLockKey(feedSessionId),
        lockToken,
      );
    } catch (error: unknown) {
      this.logger.warn(
        `Unable to release recommendation refill lock ${feedSessionId}: ${this.describeError(error)}`,
      );
    }
  }

  private parseSession(
    raw: string,
    expectedFeedSessionId: string,
  ): RecommendationFeedSession | null {
    const parsed = JSON.parse(raw) as Partial<RecommendationFeedSession>;

    if (
      parsed.feedSessionId !== expectedFeedSessionId ||
      typeof parsed.viewerId !== 'string' ||
      typeof parsed.algorithmVersion !== 'string' ||
      typeof parsed.generatedAt !== 'string' ||
      (parsed.personalizedRefillComplete !== undefined &&
        typeof parsed.personalizedRefillComplete !== 'boolean') ||
      (parsed.excludedUserIds !== undefined &&
        (!Array.isArray(parsed.excludedUserIds) ||
          parsed.excludedUserIds.some((id) => typeof id !== 'string'))) ||
      !Array.isArray(parsed.items)
    ) {
      this.logger.warn(
        `Ignoring malformed recommendation feed session ${expectedFeedSessionId}`,
      );
      return null;
    }

    return parsed as RecommendationFeedSession;
  }

  private async ensureConnected(): Promise<void> {
    if (this.redis.status === 'wait') {
      await this.redis.connect();
    }
  }

  private key(feedSessionId: string): string {
    return `recommendation:reel-feed:v2:${feedSessionId}`;
  }

  private refillLockKey(feedSessionId: string): string {
    return `${this.key(feedSessionId)}:refill-lock`;
  }

  private describeError(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
  }
}
