import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

/** Per-key runtime state tracked by the pool. */
interface KeyState {
  /** The raw API key string. */
  readonly key: string;
  /** Stable index used for acquire/report round-trips. */
  readonly index: number;
  /** Epoch ms until which this key should not be used (TPM cooldown). 0 = available. */
  cooldownUntil: number;
  /** UTC date string (YYYY-MM-DD) when the key hit its daily limit. '' = available. */
  exhaustedOnUtcDate: string;
  /** Last-known remaining tokens from rate-limit headers. */
  remainingTokens: number | undefined;
  /** Last-known remaining requests from rate-limit headers. */
  remainingRequests: number | undefined;
  /** Epoch ms when the key was last handed out. */
  lastUsedAt: number;
  /** Consecutive transient failures (network errors, 5xx). */
  consecutiveFailures: number;
}

/** Thrown when every key in the pool is exhausted or in cooldown. */
export class GroqKeyPoolExhaustedError extends Error {
  readonly code = 'GROQ_KEY_POOL_EXHAUSTED' as const;

  constructor(
    readonly totalKeys: number,
    readonly exhaustedKeys: number,
    readonly cooldownKeys: number,
  ) {
    super(
      `All ${totalKeys} Groq API keys are unavailable ` +
        `(${exhaustedKeys} TPD-exhausted, ${cooldownKeys} in cooldown)`,
    );
    this.name = 'GroqKeyPoolExhaustedError';
  }
}

@Injectable()
export class GroqKeyPool implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(GroqKeyPool.name);
  private keys: KeyState[] = [];
  private roundRobinIndex = 0;
  private cleanupTimer: ReturnType<typeof setInterval> | undefined;

  constructor(private readonly config: ConfigService) {}

  // ──────────────────────────── Lifecycle ────────────────────────────

  onModuleInit(): void {
    this.keys = this.loadKeys();
    this.logger.log(`Groq key pool initialized with ${this.keys.length} key(s)`);
    // Periodic cleanup every 60 s: clear expired cooldowns and TPD resets.
    this.cleanupTimer = setInterval(() => this.cleanup(), 60_000);
    this.cleanupTimer.unref();
  }

  onModuleDestroy(): void {
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
      this.cleanupTimer = undefined;
    }
  }

  // ──────────────────────────── Public API ────────────────────────────

  /** Returns a healthy key via round-robin, skipping cooldown/exhausted keys. */
  acquire(): { key: string; index: number } {
    const now = Date.now();
    const todayUtc = this.utcDateString(now);
    const total = this.keys.length;
    let exhaustedCount = 0;
    let cooldownCount = 0;

    // Try up to `total` keys starting from the round-robin cursor.
    for (let attempt = 0; attempt < total; attempt++) {
      const idx = (this.roundRobinIndex + attempt) % total;
      const state = this.keys[idx];

      // Skip TPD-exhausted keys (unless it's a new UTC day).
      if (state.exhaustedOnUtcDate && state.exhaustedOnUtcDate >= todayUtc) {
        exhaustedCount++;
        continue;
      }
      // Clear stale TPD exhaustion from a previous day.
      if (state.exhaustedOnUtcDate && state.exhaustedOnUtcDate < todayUtc) {
        state.exhaustedOnUtcDate = '';
        state.remainingTokens = undefined;
        state.remainingRequests = undefined;
        state.consecutiveFailures = 0;
      }

      // Skip keys in TPM cooldown.
      if (state.cooldownUntil > now) {
        cooldownCount++;
        continue;
      }
      // Clear expired cooldown.
      if (state.cooldownUntil > 0 && state.cooldownUntil <= now) {
        state.cooldownUntil = 0;
      }

      // Skip keys with too many consecutive failures (circuit breaker: 5 failures → 30s cooldown).
      if (state.consecutiveFailures >= 5) {
        state.cooldownUntil = now + 30_000;
        state.consecutiveFailures = 0;
        cooldownCount++;
        continue;
      }

      // Found a healthy key — advance cursor past it.
      this.roundRobinIndex = (idx + 1) % total;
      state.lastUsedAt = now;
      return { key: state.key, index: state.index };
    }

    throw new GroqKeyPoolExhaustedError(total, exhaustedCount, cooldownCount);
  }

  /**
   * Record a successful API call. Reads rate-limit headers to track remaining quota.
   */
  reportSuccess(index: number, headers: Headers): void {
    const state = this.at(index);
    if (!state) return;
    state.consecutiveFailures = 0;
    state.cooldownUntil = 0;

    const remainingTokens = this.headerInt(headers, 'x-ratelimit-remaining-tokens');
    const remainingRequests = this.headerInt(headers, 'x-ratelimit-remaining-requests');
    if (remainingTokens !== undefined) state.remainingTokens = remainingTokens;
    if (remainingRequests !== undefined) state.remainingRequests = remainingRequests;
  }

  /**
   * Record a 429 rate-limit response. Sets TPM cooldown from headers.
   * If evidence suggests TPD exhaustion, marks the key dead until UTC midnight.
   */
  reportRateLimited(index: number, headers: Headers, responseBody?: string): void {
    const state = this.at(index);
    if (!state) return;

    // Check for TPD exhaustion evidence.
    if (this.isTPDExhaustion(headers, responseBody)) {
      this.reportTPDExhausted(index);
      return;
    }

    // TPM cooldown: use retry-after or x-ratelimit-reset-tokens.
    const cooldownMs = this.parseCooldownMs(headers);
    state.cooldownUntil = Date.now() + Math.max(cooldownMs, 1_000);
    this.logger.debug(
      `Key #${index} rate-limited, cooldown ${cooldownMs}ms ` +
        `(until ${new Date(state.cooldownUntil).toISOString()})`,
    );
  }

  /** Mark a key as TPD-exhausted until the next UTC midnight. */
  reportTPDExhausted(index: number): void {
    const state = this.at(index);
    if (!state) return;
    state.exhaustedOnUtcDate = this.utcDateString(Date.now());
    state.remainingTokens = 0;
    this.logger.warn(
      `Key #${index} marked TPD-exhausted for ${state.exhaustedOnUtcDate}`,
    );
  }

  /** Record a transient failure (network error, 5xx). Short cooldown after threshold. */
  reportTransientFailure(index: number): void {
    const state = this.at(index);
    if (!state) return;
    state.consecutiveFailures++;
  }

  /** Number of keys in the pool. Useful for diagnostics. */
  get size(): number {
    return this.keys.length;
  }

  // ──────────────────────────── Internals ────────────────────────────

  private loadKeys(): KeyState[] {
    // Prefer comma-separated GROQ_API_KEYS, fall back to single GROQ_API_KEY.
    const multiRaw = this.config.get<string>('GROQ_API_KEYS')?.trim();
    const singleRaw = this.config.get<string>('GROQ_API_KEY')?.trim();

    let rawKeys: string[];
    if (multiRaw) {
      rawKeys = multiRaw
        .split(',')
        .map((k) => k.trim())
        .filter(Boolean);
    } else if (singleRaw) {
      rawKeys = [singleRaw];
    } else {
      throw new Error(
        'Missing required Groq API key configuration. ' +
          'Set GROQ_API_KEYS (comma-separated) or GROQ_API_KEY in the environment.',
      );
    }

    // Deduplicate (same key appearing twice is a misconfiguration, not extra quota).
    const seen = new Set<string>();
    const unique = rawKeys.filter((k) => {
      if (seen.has(k)) {
        this.logger.warn('Duplicate Groq API key detected and skipped');
        return false;
      }
      seen.add(k);
      return true;
    });

    if (unique.length === 0) {
      throw new Error('No valid Groq API keys found in configuration.');
    }

    return unique.map((key, index) => ({
      key,
      index,
      cooldownUntil: 0,
      exhaustedOnUtcDate: '',
      remainingTokens: undefined,
      remainingRequests: undefined,
      lastUsedAt: 0,
      consecutiveFailures: 0,
    }));
  }

  private at(index: number): KeyState | undefined {
    return this.keys[index];
  }

  private cleanup(): void {
    const now = Date.now();
    const todayUtc = this.utcDateString(now);
    for (const state of this.keys) {
      if (state.cooldownUntil > 0 && state.cooldownUntil <= now) {
        state.cooldownUntil = 0;
      }
      if (state.exhaustedOnUtcDate && state.exhaustedOnUtcDate < todayUtc) {
        this.logger.log(`Key #${state.index} TPD exhaustion cleared (new UTC day)`);
        state.exhaustedOnUtcDate = '';
        state.remainingTokens = undefined;
        state.remainingRequests = undefined;
        state.consecutiveFailures = 0;
      }
    }
  }

  /**
   * Detect TPD (daily) exhaustion from response evidence.
   * Groq signals daily limits differently from per-minute limits:
   * - Body contains "daily" or "tokens per day" keywords
   * - Reset time is > 1 hour (daily limits reset at UTC midnight, not within minutes)
   */
  private isTPDExhaustion(headers: Headers, responseBody?: string): boolean {
    // Check response body for daily-limit keywords.
    if (responseBody) {
      const lower = responseBody.toLowerCase();
      if (
        /\b(tokens?\s+per\s+day|daily\s+(token|limit|quota|allocation)|tpd)\b/.test(lower) ||
        /\b(daily|per[_\s-]?day)\b/.test(lower)
      ) {
        return true;
      }
    }

    // Check if reset time is far away (> 1 hour implies daily, not per-minute).
    const resetTokens = headers.get('x-ratelimit-reset-tokens')?.trim();
    if (resetTokens) {
      const resetMs = this.parseDurationMs(resetTokens);
      if (resetMs !== undefined && resetMs > 3_600_000) {
        return true;
      }
    }

    return false;
  }

  private parseCooldownMs(headers: Headers): number {
    // 1) Explicit retry-after header.
    const retryAfter = this.parseRetryAfterMs(headers.get('retry-after'));
    if (retryAfter !== undefined) return retryAfter;

    // 2) x-ratelimit-reset-tokens duration.
    const resetTokens = headers.get('x-ratelimit-reset-tokens')?.trim();
    if (resetTokens) {
      const ms = this.parseDurationMs(resetTokens);
      if (ms !== undefined) return ms;
    }

    // 3) x-ratelimit-reset-requests duration.
    const resetRequests = headers.get('x-ratelimit-reset-requests')?.trim();
    if (resetRequests) {
      const ms = this.parseDurationMs(resetRequests);
      if (ms !== undefined) return ms;
    }

    // Default: 5 seconds.
    return 5_000;
  }

  private parseRetryAfterMs(value: string | null): number | undefined {
    if (!value) return undefined;
    const seconds = Number(value);
    if (Number.isFinite(seconds) && seconds >= 0) {
      return Math.min(Math.round(seconds * 1_000), 86_400_000);
    }
    const timestamp = Date.parse(value);
    if (Number.isFinite(timestamp)) {
      return Math.min(Math.max(timestamp - Date.now(), 0), 86_400_000);
    }
    return undefined;
  }

  /** Parse Groq-style duration strings like "1m30s", "500ms", "2.5s". */
  private parseDurationMs(value: string): number | undefined {
    const normalized = value.trim().toLowerCase();
    const matches = [...normalized.matchAll(/(\d+(?:\.\d+)?)(ms|s|m|h)/g)];
    if (matches.length === 0) return undefined;
    const consumed = matches.map((m) => m[0]).join('');
    if (consumed !== normalized) return undefined;
    const multipliers = { ms: 1, s: 1_000, m: 60_000, h: 3_600_000 } as const;
    const ms = matches.reduce(
      (total, m) =>
        total + Number(m[1]) * multipliers[m[2] as keyof typeof multipliers],
      0,
    );
    return Number.isFinite(ms) ? Math.min(Math.round(ms), 86_400_000) : undefined;
  }

  private headerInt(headers: Headers, name: string): number | undefined {
    const raw = headers.get(name)?.trim();
    if (!raw) return undefined;
    const value = Number(raw);
    return Number.isFinite(value) ? Math.max(0, Math.round(value)) : undefined;
  }

  private utcDateString(epochMs: number): string {
    return new Date(epochMs).toISOString().slice(0, 10);
  }
}
