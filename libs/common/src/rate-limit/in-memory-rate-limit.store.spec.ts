import { InMemoryRateLimitStore } from './in-memory-rate-limit.store';
import type { RateLimitPolicy } from './rate-limit.types';

const policy: RateLimitPolicy = {
  name: 'auth_login_ip',
  limit: 3,
  windowSeconds: 60,
  onStoreFailure: 'local',
};

describe('InMemoryRateLimitStore', () => {
  it('allows the burst, then denies with a retry hint', async () => {
    let now = 1_000_000;
    const store = new InMemoryRateLimitStore(() => now);
    for (let i = 0; i < 3; i += 1) {
      expect((await store.consume('k', policy)).allowed).toBe(true);
    }
    const denied = await store.consume('k', policy);
    expect(denied).toMatchObject({ allowed: false, remaining: 0 });
    // 3 tokens per 60s => one token every 20s.
    expect(denied.retryAfterSeconds).toBe(20);
    now += 20_000;
    expect((await store.consume('k', policy)).allowed).toBe(true);
  });

  it('isolates keys and never refills above capacity', async () => {
    let now = 0;
    const store = new InMemoryRateLimitStore(() => now);
    await store.consume('a', policy);
    expect((await store.consume('b', policy)).remaining).toBe(2);
    now += 10 * 60_000;
    expect((await store.consume('a', policy)).remaining).toBe(2);
  });
});
