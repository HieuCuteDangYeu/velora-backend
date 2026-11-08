import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Redis } from 'ioredis';
import { InMemoryRateLimitStore } from './in-memory-rate-limit.store';
import {
  resolveRateLimitPolicy,
  type RateLimitConfigReader,
  type RateLimitPolicyName,
} from './rate-limit.policies';
import {
  RATE_LIMIT_REDIS,
  type RateLimitDecision,
  type RateLimitPolicy,
  type RateLimitStore,
} from './rate-limit.types';
import { RedisRateLimitStore } from './redis-rate-limit.store';

const BREAKER_FAILURE_THRESHOLD = 3;
const BREAKER_OPEN_MS = 5_000;
const DEFAULT_REDIS_TIMEOUT_MS = 100;
const LOG_INTERVAL_MS = 10_000;

/**
 * Decides whether a subject may proceed under a named policy.
 *
 * State lives only in Redis, so any number of replicas share one budget.
 * If Redis is slow or down the service degrades per policy (see
 * RateLimitStoreFailureMode) behind a small circuit breaker, so a Redis outage
 * costs at most `RATE_LIMIT_REDIS_TIMEOUT_MS` once per breaker window.
 */
@Injectable()
export class RateLimitService {
  private readonly logger = new Logger(RateLimitService.name);
  private readonly redisStore?: RateLimitStore;
  private readonly localStore: RateLimitStore;
  private readonly config: RateLimitConfigReader;
  private readonly policies = new Map<string, RateLimitPolicy>();
  private readonly lastLogAt = new Map<string, number>();
  private consecutiveFailures = 0;
  private breakerOpenUntil = 0;

  constructor(
    @Optional() @Inject(RATE_LIMIT_REDIS) redis?: Redis,
    @Optional() config?: ConfigService,
    @Optional() localStore?: InMemoryRateLimitStore,
  ) {
    this.config = config ?? {
      get: <T = string>(key: string) => process.env[key] as T | undefined,
    };
    this.localStore = localStore ?? new InMemoryRateLimitStore();
    this.redisStore = redis ? new RedisRateLimitStore(redis) : undefined;
  }

  get enabled(): boolean {
    const raw = this.config.get<string>('RATE_LIMIT_ENABLED');
    return !(raw !== undefined && ['false', '0', 'off'].includes(String(raw)));
  }

  policy(name: RateLimitPolicyName): RateLimitPolicy {
    let policy = this.policies.get(name);
    if (!policy) {
      policy = resolveRateLimitPolicy(name, this.config);
      this.policies.set(name, policy);
    }
    return policy;
  }

  async check(
    name: RateLimitPolicyName,
    subject: string,
    cost = 1,
  ): Promise<RateLimitDecision> {
    const policy = this.policy(name);
    if (!this.enabled) {
      return {
        allowed: true,
        limit: policy.limit,
        remaining: policy.limit,
        retryAfterSeconds: 0,
        source: 'bypass',
      };
    }

    // The hash tag keeps one subject's keys in one slot if Redis moves to Cluster.
    const key = `rl:{${name}:${subject}}`;
    const now = Date.now();
    if (this.redisStore && now >= this.breakerOpenUntil) {
      try {
        const decision = await this.withTimeout(
          this.redisStore.consume(key, policy, cost),
        );
        this.consecutiveFailures = 0;
        return decision;
      } catch (error: unknown) {
        this.recordStoreFailure(name, error, now);
      }
    }

    if (policy.onStoreFailure === 'local') {
      return this.localStore.consume(key, policy, cost);
    }
    return {
      allowed: true,
      limit: policy.limit,
      remaining: policy.limit,
      retryAfterSeconds: 0,
      source: 'bypass',
    };
  }

  /** Logs a denial at most once per policy per interval so an attack cannot flood the logs. */
  logDenied(name: RateLimitPolicyName, decision: RateLimitDecision): void {
    this.logThrottled(
      `deny:${name}`,
      `rate limit exceeded policy=${name} source=${decision.source} retry_after_s=${decision.retryAfterSeconds}`,
    );
  }

  private recordStoreFailure(
    name: RateLimitPolicyName,
    error: unknown,
    now: number,
  ): void {
    this.consecutiveFailures += 1;
    if (this.consecutiveFailures >= BREAKER_FAILURE_THRESHOLD) {
      this.breakerOpenUntil = now + BREAKER_OPEN_MS;
      this.consecutiveFailures = 0;
    }
    const reason = error instanceof Error ? error.message : 'unknown';
    this.logThrottled(
      'store-failure',
      `rate limit store unavailable policy=${name} fallback=${this.policy(name).onStoreFailure} reason=${reason.slice(0, 120)}`,
    );
  }

  private logThrottled(key: string, message: string): void {
    const now = Date.now();
    if (now - (this.lastLogAt.get(key) ?? 0) < LOG_INTERVAL_MS) return;
    this.lastLogAt.set(key, now);
    this.logger.warn(message);
  }

  private withTimeout<T>(promise: Promise<T>): Promise<T> {
    const configured = Number(
      this.config.get<string>('RATE_LIMIT_REDIS_TIMEOUT_MS'),
    );
    const timeoutMs =
      Number.isFinite(configured) && configured > 0
        ? configured
        : DEFAULT_REDIS_TIMEOUT_MS;
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(
        () => reject(new Error(`timeout after ${timeoutMs}ms`)),
        timeoutMs,
      );
    });
    return Promise.race([promise, timeout]).finally(() => {
      if (timer) clearTimeout(timer);
    });
  }
}
