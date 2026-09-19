import type { Reel } from '@content/domain/entities/reel.entity';
import type {
  IRecommendationFeedCacheRepository,
  RecommendationGlobalSlate,
} from '@content/domain/interfaces/recommendation-feed-cache.repository.interface';
import type { RecommendationFeedSessionItem } from '@content/domain/interfaces/recommendation-feed-session.repository.interface';
import { Inject, Injectable, Logger } from '@nestjs/common';
import type Redis from 'ioredis';

const GLOBAL_SLATE_KEY = 'reels:recommended:global';
const REEL_ENTITY_KEY_PREFIX = 'reel:entity:';
const INVALIDATED_REEL_TTL_SECONDS = 3 * 60 * 60;
const REEL_DATE_FIELDS = [
  'createdAt',
  'updatedAt',
  'processingStartedAt',
  'processingFailedAt',
  'processingCompletedAt',
  'indexCompletedAt',
] as const;

const SAVE_REEL_SCRIPT = `
local currentVersion = 0
local hasVersion = false
local invalidated = false
local raw = redis.call('GET', KEYS[1])
if raw then
  local ok, parsed = pcall(cjson.decode, raw)
  if ok and type(parsed) == 'table' then
    local version = tonumber(parsed['version'])
    if version then
      currentVersion = version
      hasVersion = true
    end
    invalidated = parsed['invalidated'] == true
  end
end

local incomingVersion = tonumber(ARGV[3]) or 0
if (invalidated and not hasVersion) or currentVersion > incomingVersion then
  return 0
end
if invalidated and incomingVersion <= currentVersion then
  return 0
end

local reel = cjson.decode(ARGV[1])
redis.call(
  'SET',
  KEYS[1],
  cjson.encode({ version = incomingVersion, reel = reel }),
  'EX',
  ARGV[2]
)
return 1
`;

const INVALIDATE_REEL_SCRIPT = `
local version = 0
local hasVersion = false
local raw = redis.call('GET', KEYS[1])
if raw then
  local ok, parsed = pcall(cjson.decode, raw)
  if ok and type(parsed) == 'table' then
    local currentVersion = tonumber(parsed['version'])
    if currentVersion then
      version = currentVersion
      hasVersion = true
    end
  end
end

if not hasVersion then
  local now = redis.call('TIME')
  version = tonumber(now[1]) * 1000 + math.floor(tonumber(now[2]) / 1000)
end
if version < 1 then version = 1 end

redis.call(
  'SET',
  KEYS[1],
  '{"invalidated":true,"version":' .. version .. '}',
  'EX',
  ARGV[1]
)
return version
`;

@Injectable()
export class RedisRecommendationFeedCacheRepository implements IRecommendationFeedCacheRepository {
  private readonly logger = new Logger(
    RedisRecommendationFeedCacheRepository.name,
  );
  private readonly invalidatedReelIds = new Set<string>();

  constructor(
    @Inject('REDIS_CLIENT')
    private readonly redis: Redis,
  ) {}

  async getGlobalSlate(): Promise<RecommendationGlobalSlate | null> {
    try {
      await this.ensureConnected();
      const raw = await this.redis.get(GLOBAL_SLATE_KEY);
      return raw ? this.parseGlobalSlate(raw) : null;
    } catch (error: unknown) {
      this.logger.warn(
        `Recommendation global slate cache unavailable: ${this.describeError(error)}`,
      );
      return null;
    }
  }

  async saveGlobalSlate(
    slate: RecommendationGlobalSlate,
    ttlSeconds: number,
  ): Promise<void> {
    try {
      await this.ensureConnected();
      await this.redis.set(
        GLOBAL_SLATE_KEY,
        JSON.stringify(slate),
        'EX',
        Math.max(1, Math.floor(ttlSeconds)),
      );
    } catch (error: unknown) {
      this.logger.warn(
        `Unable to cache recommendation global slate: ${this.describeError(error)}`,
      );
    }
  }

  async getReels(reelIds: string[]): Promise<Reel[]> {
    const ids = [...new Set(reelIds.filter(Boolean))];
    if (ids.length === 0) return [];

    try {
      await this.ensureConnected();
      const values = await this.redis.mget(
        ...ids.map((id) => this.reelKey(id)),
      );
      const reels: Reel[] = [];

      for (let index = 0; index < values.length; index += 1) {
        const raw = values[index];
        if (!raw) continue;

        const id = ids[index];
        const reel = this.parseReel(raw, id);
        if (reel && !this.invalidatedReelIds.has(id)) reels.push(reel);
      }

      return reels;
    } catch (error: unknown) {
      this.logger.warn(
        `Recommendation reel entity cache unavailable: ${this.describeError(error)}`,
      );
      return [];
    }
  }

  async saveReels(reels: Reel[], ttlSeconds: number): Promise<void> {
    const eligible = reels.filter(
      (reel) =>
        reel.mediaStatus === 'COMPLETED' && reel.visibility === 'public',
    );
    if (eligible.length === 0) return;

    try {
      await this.ensureConnected();
      const ttl = Math.max(1, Math.floor(ttlSeconds));
      const pipeline = this.redis.pipeline();

      for (const reel of eligible) {
        pipeline.eval(
          SAVE_REEL_SCRIPT,
          1,
          this.reelKey(reel.id),
          this.serializeReel(reel),
          ttl,
          this.reelVersion(reel),
        );
      }

      const results = await pipeline.exec();
      const commandError = results?.find((entry) => entry?.[0])?.[0];
      if (commandError) throw commandError;

      for (let index = 0; index < eligible.length; index += 1) {
        const result = results?.[index]?.[1];
        if (result === 1 || result === '1') {
          this.invalidatedReelIds.delete(eligible[index].id);
        }
      }
    } catch (error: unknown) {
      this.logger.warn(
        `Unable to cache recommendation reel entities: ${this.describeError(error)}`,
      );
    }
  }

  async invalidateReels(reelIds: string[]): Promise<void> {
    const ids = [...new Set(reelIds.filter(Boolean))];
    if (ids.length === 0) return;
    for (const id of ids) {
      this.invalidatedReelIds.add(id);
    }

    try {
      await this.ensureConnected();
      const pipeline = this.redis.pipeline();
      for (const id of ids) {
        pipeline.eval(
          INVALIDATE_REEL_SCRIPT,
          1,
          this.reelKey(id),
          INVALIDATED_REEL_TTL_SECONDS,
        );
      }
      const results = await pipeline.exec();
      const commandError = results?.find((entry) => entry?.[0])?.[0];
      if (commandError) throw commandError;

      for (const id of ids) {
        this.invalidatedReelIds.delete(id);
      }
    } catch (error: unknown) {
      this.logger.warn(
        `Unable to invalidate recommendation reel entities: ${this.describeError(error)}`,
      );
    }
  }

  private parseGlobalSlate(raw: string): RecommendationGlobalSlate | null {
    const parsed = JSON.parse(raw) as Partial<RecommendationGlobalSlate>;
    if (
      typeof parsed.generatedAt !== 'string' ||
      !Array.isArray(parsed.items)
    ) {
      return null;
    }

    const items = parsed.items.filter(
      (item): item is RecommendationFeedSessionItem =>
        !!item &&
        typeof item.reelId === 'string' &&
        typeof item.primarySource === 'string' &&
        Array.isArray(item.sources) &&
        item.sources.every((source) => typeof source === 'string'),
    );

    return items.length === parsed.items.length
      ? { generatedAt: parsed.generatedAt, items }
      : null;
  }

  private serializeReel(reel: Reel): string {
    return JSON.stringify(
      { ...reel, recommendation: undefined },
      (_key, value: unknown) =>
        typeof value === 'bigint'
          ? { __recommendationBigInt: value.toString() }
          : value,
    );
  }

  private parseReel(raw: string, expectedId: string): Reel | null {
    try {
      const parsed = JSON.parse(raw, (_key, value: unknown) => {
        if (
          value &&
          typeof value === 'object' &&
          '__recommendationBigInt' in value
        ) {
          const encoded = (value as { __recommendationBigInt?: unknown })
            .__recommendationBigInt;
          if (typeof encoded === 'string' && /^\d+$/.test(encoded)) {
            return BigInt(encoded);
          }
        }
        return value;
      }) as Record<string, unknown>;
      const envelope = parsed['reel'];
      const reel =
        envelope && typeof envelope === 'object' && !Array.isArray(envelope)
          ? (envelope as Record<string, unknown>)
          : parsed;

      if (
        parsed['invalidated'] === true ||
        reel['id'] !== expectedId ||
        typeof reel['userId'] !== 'string' ||
        typeof reel['mediaKey'] !== 'string' ||
        reel['mediaStatus'] !== 'COMPLETED' ||
        reel['visibility'] !== 'public' ||
        typeof reel['viewCount'] !== 'bigint'
      ) {
        return null;
      }

      for (const field of REEL_DATE_FIELDS) {
        const value = reel[field];
        if (value === undefined || value === null) continue;
        if (typeof value !== 'string') return null;
        const date = new Date(value);
        if (Number.isNaN(date.getTime())) return null;
        reel[field] = date;
      }

      if (
        !(reel['createdAt'] instanceof Date) ||
        !(reel['updatedAt'] instanceof Date)
      ) {
        return null;
      }

      return reel as unknown as Reel;
    } catch (error: unknown) {
      this.logger.warn(
        `Ignoring malformed recommendation reel entity ${expectedId}: ${this.describeError(error)}`,
      );
      return null;
    }
  }

  private reelVersion(reel: Reel): number {
    const version = reel.updatedAt?.getTime();
    return Number.isFinite(version) && version >= 0 ? Math.floor(version) : 0;
  }

  private async ensureConnected(): Promise<void> {
    if (this.redis.status === 'wait') {
      await this.redis.connect();
    }
  }

  private reelKey(reelId: string): string {
    return `${REEL_ENTITY_KEY_PREFIX}${reelId}`;
  }

  private describeError(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
  }
}
