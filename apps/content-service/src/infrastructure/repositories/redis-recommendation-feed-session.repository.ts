import type {
  IRecommendationFeedSessionRepository,
  RecommendationFeedSession,
} from '@content/domain/interfaces/recommendation-feed-session.repository.interface';
import { Inject, Injectable, Logger } from '@nestjs/common';
import type Redis from 'ioredis';

@Injectable()
export class RedisRecommendationFeedSessionRepository
  implements IRecommendationFeedSessionRepository
{
  private readonly logger = new Logger(
    RedisRecommendationFeedSessionRepository.name,
  );

  constructor(
    @Inject('REDIS_CLIENT')
    private readonly redis: Redis,
  ) {}

  async get(feedSessionId: string): Promise<RecommendationFeedSession | null> {
    try {
      const raw = await this.redis.get(this.key(feedSessionId));

      if (!raw) {
        return null;
      }

      const parsed = JSON.parse(raw) as Partial<RecommendationFeedSession>;

      if (
        parsed.feedSessionId !== feedSessionId ||
        typeof parsed.viewerId !== 'string' ||
        typeof parsed.algorithmVersion !== 'string' ||
        typeof parsed.generatedAt !== 'string' ||
        !Array.isArray(parsed.items)
      ) {
        this.logger.warn(
          `Ignoring malformed recommendation feed session ${feedSessionId}`,
        );
        return null;
      }

      return parsed as RecommendationFeedSession;
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
      await this.redis.set(
        this.key(session.feedSessionId),
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

  private key(feedSessionId: string): string {
    return `recommendation:reel-feed:v2:${feedSessionId}`;
  }

  private describeError(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
  }
}
