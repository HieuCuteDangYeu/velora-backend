import { ConfigService } from '@nestjs/config';
import {
  GroqKeyPool,
  GroqKeyPoolExhaustedError,
} from './groq-key-pool.service';

function makeConfig(overrides: Record<string, string> = {}): ConfigService {
  return {
    get: (key: string) => overrides[key],
    getOrThrow: (key: string) => {
      const v = overrides[key];
      if (v === undefined) throw new Error(`Missing ${key}`);
      return v;
    },
  } as unknown as ConfigService;
}

function initPool(
  keys: string,
  extra: Record<string, string> = {},
): GroqKeyPool {
  const pool = new GroqKeyPool(makeConfig({ GROQ_API_KEYS: keys, ...extra }));
  pool.onModuleInit();
  return pool;
}

function fakeHeaders(map: Record<string, string> = {}): Headers {
  return new Headers(map);
}

afterEach(() => {
  // Ensure cleanup timers are cleared.
  jest.restoreAllMocks();
});

describe('GroqKeyPool', () => {
  describe('initialization', () => {
    it('loads keys from GROQ_API_KEYS (comma-separated)', () => {
      const pool = initPool('gsk_a,gsk_b,gsk_c');
      expect(pool.size).toBe(3);
      pool.onModuleDestroy();
    });

    it('falls back to GROQ_API_KEY when GROQ_API_KEYS is not set', () => {
      const pool = new GroqKeyPool(makeConfig({ GROQ_API_KEY: 'gsk_single' }));
      pool.onModuleInit();
      expect(pool.size).toBe(1);
      const { key } = pool.acquire();
      expect(key).toBe('gsk_single');
      pool.onModuleDestroy();
    });

    it('deduplicates keys', () => {
      const pool = initPool('gsk_a,gsk_b,gsk_a');
      expect(pool.size).toBe(2);
      pool.onModuleDestroy();
    });

    it('throws when no keys are configured', () => {
      expect(() => {
        const pool = new GroqKeyPool(makeConfig({}));
        pool.onModuleInit();
      }).toThrow('Missing required Groq API key');
    });

    it('ignores empty entries in comma-separated list', () => {
      const pool = initPool(',gsk_a,,gsk_b,');
      expect(pool.size).toBe(2);
      pool.onModuleDestroy();
    });
  });

  describe('round-robin acquisition', () => {
    it('rotates through keys in order', () => {
      const pool = initPool('gsk_a,gsk_b,gsk_c');
      expect(pool.acquire().key).toBe('gsk_a');
      expect(pool.acquire().key).toBe('gsk_b');
      expect(pool.acquire().key).toBe('gsk_c');
      expect(pool.acquire().key).toBe('gsk_a');
      pool.onModuleDestroy();
    });

    it('returns stable index for each key', () => {
      const pool = initPool('gsk_a,gsk_b');
      const first = pool.acquire();
      const second = pool.acquire();
      expect(first.index).toBe(0);
      expect(second.index).toBe(1);
      pool.onModuleDestroy();
    });
  });

  describe('TPM cooldown', () => {
    it('skips keys in cooldown', () => {
      const pool = initPool('gsk_a,gsk_b,gsk_c');
      pool.acquire(); // gsk_a, index 0
      pool.reportRateLimited(0, fakeHeaders({ 'retry-after': '10' }));
      // Next acquire should skip gsk_a
      expect(pool.acquire().key).toBe('gsk_b');
      expect(pool.acquire().key).toBe('gsk_c');
      // gsk_a is still in cooldown
      expect(pool.acquire().key).toBe('gsk_b');
      pool.onModuleDestroy();
    });

    it('respects retry-after header for cooldown duration', () => {
      const pool = initPool('gsk_a,gsk_b');
      pool.reportRateLimited(0, fakeHeaders({ 'retry-after': '2' }));
      expect(pool.acquire().key).toBe('gsk_b');
      pool.onModuleDestroy();
    });

    it('uses x-ratelimit-reset-tokens when retry-after is absent', () => {
      const pool = initPool('gsk_a,gsk_b');
      pool.reportRateLimited(
        0,
        fakeHeaders({ 'x-ratelimit-reset-tokens': '5s' }),
      );
      expect(pool.acquire().key).toBe('gsk_b');
      pool.onModuleDestroy();
    });
  });

  describe('TPD exhaustion', () => {
    it('marks key as exhausted when daily limit keywords detected', () => {
      const pool = initPool('gsk_a,gsk_b');
      pool.reportRateLimited(
        0,
        fakeHeaders(),
        'Rate limit reached: tokens per day',
      );
      // gsk_a should be skipped
      expect(pool.acquire().key).toBe('gsk_b');
      expect(pool.acquire().key).toBe('gsk_b');
      pool.onModuleDestroy();
    });

    it('marks key as exhausted when reset time > 1 hour', () => {
      const pool = initPool('gsk_a,gsk_b');
      pool.reportRateLimited(
        0,
        fakeHeaders({ 'x-ratelimit-reset-tokens': '12h30m' }),
      );
      // gsk_a should be marked as TPD-exhausted (reset > 1 hour)
      expect(pool.acquire().key).toBe('gsk_b');
      pool.onModuleDestroy();
    });

    it('clears TPD exhaustion after UTC midnight', () => {
      const pool = initPool('gsk_a,gsk_b');
      // Manually exhaust key 0 for "yesterday"
      pool.reportTPDExhausted(0);
      // Simulate time passing to the next day by manipulating the state
      // We can use the cleanup method indirectly — set exhaustedOnUtcDate to yesterday
      const yesterday = new Date(Date.now() - 86_400_000)
        .toISOString()
        .slice(0, 10);
      // Access internal state for testing
      (pool as any).keys[0].exhaustedOnUtcDate = yesterday;
      // Now it should be cleared on acquire
      expect(pool.acquire().key).toBe('gsk_a');
      pool.onModuleDestroy();
    });

    it('throws GroqKeyPoolExhaustedError when all keys are exhausted', () => {
      const pool = initPool('gsk_a,gsk_b');
      pool.reportTPDExhausted(0);
      pool.reportTPDExhausted(1);
      expect(() => pool.acquire()).toThrow(GroqKeyPoolExhaustedError);
      try {
        pool.acquire();
      } catch (e) {
        const error = e as GroqKeyPoolExhaustedError;
        expect(error.totalKeys).toBe(2);
        expect(error.exhaustedKeys).toBe(2);
        expect(error.code).toBe('GROQ_KEY_POOL_EXHAUSTED');
      }
      pool.onModuleDestroy();
    });
  });

  describe('success reporting', () => {
    it('records remaining tokens from headers', () => {
      const pool = initPool('gsk_a');
      const { index } = pool.acquire();
      pool.reportSuccess(
        index,
        fakeHeaders({
          'x-ratelimit-remaining-tokens': '5000',
          'x-ratelimit-remaining-requests': '42',
        }),
      );
      // Key should still be available
      expect(pool.acquire().key).toBe('gsk_a');
      pool.onModuleDestroy();
    });

    it('resets consecutive failures on success', () => {
      const pool = initPool('gsk_a,gsk_b');
      // Cause 4 failures
      pool.reportTransientFailure(0);
      pool.reportTransientFailure(0);
      pool.reportTransientFailure(0);
      pool.reportTransientFailure(0);
      // Report success — should reset
      pool.reportSuccess(0, fakeHeaders());
      // Key should still be available (not tripped to circuit breaker)
      expect(pool.acquire().key).toBe('gsk_a');
      pool.onModuleDestroy();
    });
  });

  describe('circuit breaker', () => {
    it('puts key in cooldown after 5 consecutive failures', () => {
      const pool = initPool('gsk_a,gsk_b');
      for (let i = 0; i < 5; i++) pool.reportTransientFailure(0);
      // Next acquire should trigger circuit breaker on key 0
      expect(pool.acquire().key).toBe('gsk_b');
      pool.onModuleDestroy();
    });
  });

  describe('single-key backward compatibility', () => {
    it('works with a single key (no rotation needed)', () => {
      const pool = initPool('gsk_only');
      expect(pool.acquire().key).toBe('gsk_only');
      expect(pool.acquire().key).toBe('gsk_only');
      pool.reportSuccess(0, fakeHeaders());
      expect(pool.acquire().key).toBe('gsk_only');
      pool.onModuleDestroy();
    });

    it('throws exhausted error when single key hits TPD', () => {
      const pool = initPool('gsk_only');
      pool.reportTPDExhausted(0);
      expect(() => pool.acquire()).toThrow(GroqKeyPoolExhaustedError);
      pool.onModuleDestroy();
    });
  });

  describe('documentation link and RPM exclusion', () => {
    it('does not mark key as TPD-exhausted when error mentions RPM with doc link', () => {
      const pool = initPool('gsk_a,gsk_b');
      pool.reportRateLimited(
        0,
        fakeHeaders({ 'retry-after': '1' }),
        'Rate limit reached for model in org on requests per minute (RPM): Limit 30, Used 30. Visit https://console.groq.com/docs/rate-limits for more information on reload times and daily limits.',
      );
      // Key 0 should only have TPM cooldown, NOT TPD exhaustion
      expect(pool.acquire().key).toBe('gsk_b');
      // If we advance past cooldown, key 0 should be available again
      (pool as any).keys[0].cooldownUntil = 0;
      expect(pool.acquire().key).toBe('gsk_a');
      pool.onModuleDestroy();
    });
  });

  describe('acquireAsync', () => {
    it('waits for cooldown to expire instead of throwing', async () => {
      const pool = initPool('gsk_a,gsk_b');
      // Set short cooldown of 100ms on both keys, with cooldownUntil > now + 1000 to trigger throw in acquire()
      const now = Date.now();
      (pool as any).keys[0].cooldownUntil = now + 1500;
      (pool as any).keys[1].cooldownUntil = now + 1500;
      // acquire() would throw because both keys are in cooldown > 1s:
      expect(() => pool.acquire()).toThrow(GroqKeyPoolExhaustedError);

      // Now set a real short cooldown of 150ms on key 0 and test acquireAsync
      (pool as any).keys[0].cooldownUntil = Date.now() + 150;
      // acquireAsync() should wait and succeed:
      const result = await pool.acquireAsync(500);
      expect(result.key).toBe('gsk_a');
      pool.onModuleDestroy();
    });
  });
});
