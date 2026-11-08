/**
 * What to do when the shared store (Redis) cannot answer in time.
 * - `local`: enforce the same limit per process in memory. Use for abusable or
 *   expensive paths (login, AI turns): the limit degrades to per-instance but
 *   never disappears.
 * - `allow`: let the request through. Use for low-risk paths.
 * A store outage must never become a hard denial of service.
 */
export type RateLimitStoreFailureMode = 'local' | 'allow';

export interface RateLimitPolicy {
  name: string;
  /** Bucket capacity: the burst allowed, and the sustained count per window. */
  limit: number;
  windowSeconds: number;
  onStoreFailure: RateLimitStoreFailureMode;
}

export interface RateLimitDecision {
  allowed: boolean;
  limit: number;
  remaining: number;
  retryAfterSeconds: number;
  /** Which backend produced the decision. */
  source: 'redis' | 'local' | 'bypass';
}

/** Port: an atomic token-bucket consumer. Implementations must be race-free across replicas. */
export interface RateLimitStore {
  consume(
    key: string,
    policy: RateLimitPolicy,
    cost?: number,
  ): Promise<RateLimitDecision>;
}

export const RATE_LIMIT_REDIS = Symbol('RATE_LIMIT_REDIS');
