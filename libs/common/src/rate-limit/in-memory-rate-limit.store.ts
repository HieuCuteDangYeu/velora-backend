import type {
  RateLimitDecision,
  RateLimitPolicy,
  RateLimitStore,
} from './rate-limit.types';

interface Bucket {
  tokens: number;
  updatedAtMs: number;
  expiresAtMs: number;
}

const MAX_BUCKETS = 50_000;

/**
 * Per-process token bucket. It is the degraded-mode fallback when Redis is
 * unreachable, and the reference implementation the Lua script mirrors.
 */
export class InMemoryRateLimitStore implements RateLimitStore {
  private readonly buckets = new Map<string, Bucket>();

  constructor(private readonly now: () => number = Date.now) {}

  consume(
    key: string,
    policy: RateLimitPolicy,
    cost = 1,
  ): Promise<RateLimitDecision> {
    const nowMs = this.now();
    const refillPerMs = policy.limit / (policy.windowSeconds * 1000);
    const existing = this.buckets.get(key);
    let tokens = policy.limit;
    if (existing && existing.expiresAtMs > nowMs) {
      tokens = Math.min(
        policy.limit,
        existing.tokens +
          Math.max(0, nowMs - existing.updatedAtMs) * refillPerMs,
      );
    }

    let allowed = false;
    let retryAfterMs = 0;
    if (tokens >= cost) {
      tokens -= cost;
      allowed = true;
    } else {
      retryAfterMs = Math.ceil((cost - tokens) / refillPerMs);
    }

    const ttlMs = Math.ceil(policy.limit / refillPerMs) + 1000;
    this.buckets.delete(key);
    this.buckets.set(key, {
      tokens,
      updatedAtMs: nowMs,
      expiresAtMs: nowMs + ttlMs,
    });
    this.evictIfNeeded(nowMs);

    return Promise.resolve({
      allowed,
      limit: policy.limit,
      remaining: Math.max(0, Math.floor(tokens)),
      retryAfterSeconds: allowed
        ? 0
        : Math.max(1, Math.ceil(retryAfterMs / 1000)),
      source: 'local',
    });
  }

  private evictIfNeeded(nowMs: number): void {
    if (this.buckets.size <= MAX_BUCKETS) return;
    for (const [key, bucket] of this.buckets) {
      if (bucket.expiresAtMs <= nowMs) this.buckets.delete(key);
    }
    // Map iterates in insertion order and consume() re-inserts, so the head is
    // the least recently used entry.
    while (this.buckets.size > MAX_BUCKETS) {
      const oldest = this.buckets.keys().next();
      if (oldest.done) break;
      this.buckets.delete(oldest.value);
    }
  }
}
