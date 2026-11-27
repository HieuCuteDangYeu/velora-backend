import Redis from 'ioredis';
import {
  MAX_RESET_CODE_ATTEMPTS,
  RedisPasswordResetCodeStore,
} from './redis-password-reset-code.store';

// Runs the Lua script against a real Redis. Set RESET_CODE_REDIS_URL to enable.
const redisUrl = process.env.RESET_CODE_REDIS_URL;
const describeWithRedis = redisUrl ? describe : describe.skip;

describeWithRedis('RedisPasswordResetCodeStore (real Redis)', () => {
  let redis: Redis;
  let store: RedisPasswordResetCodeStore;

  beforeAll(() => {
    redis = new Redis(redisUrl!);
    store = new RedisPasswordResetCodeStore(redis);
  });
  beforeEach(() => redis.flushdb());
  afterAll(() => redis.quit());

  it('accepts a code only for the user it was issued to', async () => {
    await store.issue('alice', '482913', 900);

    await expect(store.check('bob', '482913', { consume: true })).resolves.toBe(false);
    await expect(store.check('alice', '482913', { consume: true })).resolves.toBe(true);
  });

  it('keeps the code after a non-consuming check and deletes it once consumed', async () => {
    await store.issue('alice', '482913', 900);

    await expect(store.check('alice', '482913', { consume: false })).resolves.toBe(true);
    await expect(store.check('alice', '482913', { consume: true })).resolves.toBe(true);
    await expect(store.check('alice', '482913', { consume: true })).resolves.toBe(false);
  });

  it('lets two users hold the same code without overwriting each other', async () => {
    await store.issue('alice', '482913', 900);
    await store.issue('bob', '482913', 900);

    await expect(store.check('alice', '482913', { consume: true })).resolves.toBe(true);
    await expect(store.check('bob', '482913', { consume: true })).resolves.toBe(true);
  });

  it('drops the code after too many wrong guesses, even when sent in parallel', async () => {
    await store.issue('alice', '482913', 900);

    const guesses = Array.from({ length: 20 }, (_, i) =>
      store.check('alice', String(100000 + i), { consume: false }),
    );
    await expect(Promise.all(guesses)).resolves.toEqual(Array(20).fill(false));

    expect(MAX_RESET_CODE_ATTEMPTS).toBe(5);
    await expect(store.check('alice', '482913', { consume: true })).resolves.toBe(false);
  });

  it('replaces the old code and attempt count when a new code is issued', async () => {
    await store.issue('alice', '111111', 900);
    for (let i = 0; i < MAX_RESET_CODE_ATTEMPTS - 1; i++) {
      await store.check('alice', '000000', { consume: false });
    }
    await store.issue('alice', '222222', 900);

    await expect(store.check('alice', '111111', { consume: false })).resolves.toBe(false);
    await expect(store.check('alice', '222222', { consume: true })).resolves.toBe(true);
    expect(await redis.ttl('reset_password:user:alice')).toBe(-2);
  });

  it('stores a hash, not the code, with the TTL set', async () => {
    await store.issue('alice', '482913', 900);
    const stored = await redis.hgetall('reset_password:user:alice');

    expect(JSON.stringify(stored)).not.toContain('482913');
    expect(await redis.ttl('reset_password:user:alice')).toBeGreaterThan(890);
  });
});
