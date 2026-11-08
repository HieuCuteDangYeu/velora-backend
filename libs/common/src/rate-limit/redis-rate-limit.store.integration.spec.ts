import Redis from 'ioredis';
import { RateLimitService } from './rate-limit.service';
import { RedisRateLimitStore } from './redis-rate-limit.store';
import type { RateLimitDecision, RateLimitPolicy } from './rate-limit.types';

// Opt-in: needs a real Redis (the token bucket is a Lua script).
//   docker run --rm -d -p 16379:6379 redis:8.6
//   RATE_LIMIT_TEST_REDIS_URL=redis://127.0.0.1:16379 npx jest redis-rate-limit.store.integration
const url = process.env.RATE_LIMIT_TEST_REDIS_URL;
const describeRedis = url ? describe : describe.skip;

const policy: RateLimitPolicy = {
  name: 'auth_login_ip',
  limit: 5,
  windowSeconds: 60,
  onStoreFailure: 'local',
};

describeRedis('RedisRateLimitStore (real Redis)', () => {
  let redis: Redis;
  const run = `t${Date.now()}`;

  beforeAll(() => {
    redis = new Redis(url!);
  });
  afterAll(async () => {
    await redis.quit();
  });

  it('grants exactly `limit` requests under heavy concurrency', async () => {
    const store = new RedisRateLimitStore(redis);
    const results = await Promise.all(
      Array.from({ length: 50 }, () =>
        store.consume(`rl:{${run}:race}`, policy),
      ),
    );
    expect(results.filter((r) => r.allowed)).toHaveLength(5);
    expect(results.find((r) => !r.allowed)?.retryAfterSeconds).toBeGreaterThan(
      0,
    );
  });

  it('shares one budget across independent clients (replicas)', async () => {
    const other = new Redis(url!);
    try {
      const a = new RedisRateLimitStore(redis);
      const b = new RedisRateLimitStore(other);
      const results = await Promise.all(
        Array.from({ length: 40 }, (_, i) =>
          (i % 2 ? a : b).consume(`rl:{${run}:replicas}`, policy),
        ),
      );
      expect(results.filter((r) => r.allowed)).toHaveLength(5);
    } finally {
      await other.quit();
    }
  });

  it('refills over time and always sets a TTL', async () => {
    const fast: RateLimitPolicy = { ...policy, limit: 2, windowSeconds: 2 };
    const store = new RedisRateLimitStore(redis);
    const key = `rl:{${run}:refill}`;
    await store.consume(key, fast);
    await store.consume(key, fast);
    expect((await store.consume(key, fast)).allowed).toBe(false);
    await new Promise((resolve) => setTimeout(resolve, 1_100));
    expect((await store.consume(key, fast)).allowed).toBe(true);
    const ttl = await redis.pttl(key);
    expect(ttl).toBeGreaterThan(0);
  });

  it('works end to end through RateLimitService', async () => {
    const service = new RateLimitService(redis, undefined);
    const decisions: RateLimitDecision[] = [];
    for (let i = 0; i < 11; i += 1) {
      decisions.push(await service.check('auth_login_ip', `ip:${run}`));
    }
    expect(decisions.filter((d) => d.allowed)).toHaveLength(10);
    expect(decisions[10]).toMatchObject({ allowed: false, source: 'redis' });
  });
});
