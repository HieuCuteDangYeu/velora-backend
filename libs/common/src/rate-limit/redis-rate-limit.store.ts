import type { Redis } from 'ioredis';
import type {
  RateLimitDecision,
  RateLimitPolicy,
  RateLimitStore,
} from './rate-limit.types';

/**
 * Atomic token bucket. One round trip, race-free across any number of gateway
 * replicas. Time comes from Redis (TIME), so replicas with skewed clocks agree.
 * Every key gets a TTL (time to refill fully): the shared Redis runs
 * volatile-lru, so a key without a TTL would never be evicted.
 */
export const TOKEN_BUCKET_LUA = `
local capacity = tonumber(ARGV[1])
local refill_per_ms = tonumber(ARGV[2])
local cost = tonumber(ARGV[3])
local ttl_ms = tonumber(ARGV[4])
local t = redis.call('TIME')
local now = tonumber(t[1]) * 1000 + math.floor(tonumber(t[2]) / 1000)
local data = redis.call('HMGET', KEYS[1], 'tokens', 'ts')
local tokens = tonumber(data[1])
local ts = tonumber(data[2])
if tokens == nil or ts == nil then
  tokens = capacity
  ts = now
end
tokens = math.min(capacity, tokens + math.max(0, now - ts) * refill_per_ms)
local allowed = 0
local retry_ms = 0
if tokens >= cost then
  tokens = tokens - cost
  allowed = 1
else
  retry_ms = math.ceil((cost - tokens) / refill_per_ms)
end
redis.call('HSET', KEYS[1], 'tokens', tostring(tokens), 'ts', tostring(now))
redis.call('PEXPIRE', KEYS[1], ttl_ms)
return { allowed, math.floor(tokens), retry_ms }
`;

type RateLimitRedis = Redis & {
  rateLimitConsume?: (
    key: string,
    capacity: number,
    refillPerMs: number,
    cost: number,
    ttlMs: number,
  ) => Promise<[number, number, number]>;
};

export class RedisRateLimitStore implements RateLimitStore {
  private readonly redis: RateLimitRedis;

  constructor(redis: Redis) {
    this.redis = redis;
    if (typeof this.redis.rateLimitConsume !== 'function') {
      this.redis.defineCommand('rateLimitConsume', {
        numberOfKeys: 1,
        lua: TOKEN_BUCKET_LUA,
      });
    }
  }

  async consume(
    key: string,
    policy: RateLimitPolicy,
    cost = 1,
  ): Promise<RateLimitDecision> {
    const refillPerMs = policy.limit / (policy.windowSeconds * 1000);
    const ttlMs = Math.ceil(policy.limit / refillPerMs) + 1000;
    const [allowed, remaining, retryMs] = await this.redis.rateLimitConsume!(
      key,
      policy.limit,
      refillPerMs,
      cost,
      ttlMs,
    );
    return {
      allowed: allowed === 1,
      limit: policy.limit,
      remaining,
      retryAfterSeconds:
        allowed === 1 ? 0 : Math.max(1, Math.ceil(retryMs / 1000)),
      source: 'redis',
    };
  }
}
