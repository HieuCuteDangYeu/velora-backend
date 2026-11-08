import { RateLimitService } from './rate-limit.service';
import type { RateLimitDecision } from './rate-limit.types';

const config = (values: Record<string, string> = {}) =>
  ({ get: (key: string) => values[key] }) as never;

const failingRedis = () =>
  ({
    defineCommand: jest.fn(),
    rateLimitConsume: jest.fn().mockRejectedValue(new Error('ECONNREFUSED')),
  }) as never;

const workingRedis = (reply: [number, number, number]) => {
  const rateLimitConsume = jest.fn().mockResolvedValue(reply);
  return {
    redis: { defineCommand: jest.fn(), rateLimitConsume } as never,
    rateLimitConsume,
  };
};

describe('RateLimitService', () => {
  it('uses the shared store and reports its decision', async () => {
    const { redis, rateLimitConsume } = workingRedis([0, 0, 4_200]);
    const service = new RateLimitService(redis, config());
    const decision = await service.check('auth_login_ip', 'ip:1.2.3.4');
    expect(decision).toMatchObject({
      allowed: false,
      source: 'redis',
      retryAfterSeconds: 5,
    });
    const [key, capacity] = rateLimitConsume.mock.calls[0] as unknown[];
    expect(key).toBe('rl:{auth_login_ip:ip:1.2.3.4}');
    expect(capacity).toBe(10);
  });

  it('falls back to a local limit for abusable paths when Redis is down', async () => {
    const service = new RateLimitService(
      failingRedis(),
      config({ RATE_LIMIT_AUTH_LOGIN_IP_LIMIT: '2' }),
    );
    const results: RateLimitDecision[] = [];
    for (let i = 0; i < 3; i += 1) {
      results.push(await service.check('auth_login_ip', 'ip:9.9.9.9'));
    }
    expect(results.map((r) => r.allowed)).toEqual([true, true, false]);
    expect(results[0].source).toBe('local');
  });

  it('lets low-risk paths through when Redis is down', async () => {
    const service = new RateLimitService(failingRedis(), config());
    for (let i = 0; i < 100; i += 1) {
      expect((await service.check('public_share_ip', 'ip:1')).allowed).toBe(
        true,
      );
    }
  });

  it('opens the breaker so a dead Redis is not retried on every request', async () => {
    const redis = failingRedis();
    const service = new RateLimitService(redis, config());
    for (let i = 0; i < 10; i += 1) {
      await service.check('public_share_ip', 'ip:1');
    }
    const calls = (redis as unknown as { rateLimitConsume: jest.Mock })
      .rateLimitConsume.mock.calls.length;
    expect(calls).toBe(3);
  });

  it('times out a hung Redis instead of stalling the request', async () => {
    const redis = {
      defineCommand: jest.fn(),
      rateLimitConsume: jest.fn(() => new Promise(() => undefined)),
    } as never;
    const service = new RateLimitService(
      redis,
      config({ RATE_LIMIT_REDIS_TIMEOUT_MS: '20' }),
    );
    const decision = await service.check('auth_login_ip', 'ip:1');
    expect(decision).toMatchObject({ allowed: true, source: 'local' });
  });

  it('works without any Redis and honours the kill switch', async () => {
    const local = new RateLimitService(undefined, config());
    expect((await local.check('ai_turn_minute', 'u:1')).source).toBe('local');

    const off = new RateLimitService(
      undefined,
      config({ RATE_LIMIT_ENABLED: 'false' }),
    );
    expect(await off.check('auth_login_ip', 'ip:1')).toMatchObject({
      allowed: true,
      source: 'bypass',
    });
  });

  it('applies env overrides and ignores invalid ones', () => {
    const service = new RateLimitService(
      undefined,
      config({
        RATE_LIMIT_AI_TURN_DAY_LIMIT: '50',
        RATE_LIMIT_AI_TURN_DAY_WINDOW_SECONDS: 'abc',
      }),
    );
    expect(service.policy('ai_turn_day')).toMatchObject({
      limit: 50,
      windowSeconds: 86_400,
    });
  });
});
