import { randomUUID } from 'node:crypto';

import type Redis from 'ioredis';

type LockRedis = Pick<Redis, 'set' | 'eval'>;

export type ConversationWriteLockHandle = {
  /** False when the lock was not obtained; the write then relies on Mongo's own conflict retry. */
  held: boolean;
  release: () => Promise<void>;
};

export type ConversationWriteLockOptions = {
  ttlMs?: number;
  maxWaitMs?: number;
  retryMinMs?: number;
  retryMaxMs?: number;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  random?: () => number;
};

// The lock is deleted only by the token that set it, so a holder whose lease
// already expired cannot release the next holder's lock.
const RELEASE_SCRIPT =
  "if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('del', KEYS[1]) else return 0 end";

const unheld: ConversationWriteLockHandle = {
  held: false,
  release: () => Promise.resolve(),
};

/**
 * Serializes message transactions of one conversation across service replicas.
 *
 * Every message updates the conversation document (its preview) inside the
 * transaction, so two replicas writing to the same conversation abort each
 * other with P2034. The per-process queue already serializes one replica; this
 * lock extends that to all of them. It is an optimisation, never a correctness
 * requirement: when Redis is unavailable or the lock is not obtained in time the
 * caller proceeds and Mongo's conflict detection plus the retry loop still keep
 * the data consistent.
 */
export class ConversationWriteLock {
  private readonly ttlMs: number;
  private readonly maxWaitMs: number;
  private readonly retryMinMs: number;
  private readonly retryMaxMs: number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly now: () => number;
  private readonly random: () => number;

  constructor(
    private readonly redis: LockRedis,
    options: ConversationWriteLockOptions = {},
  ) {
    // The lease must outlive the longest message transaction (5 s).
    this.ttlMs = options.ttlMs ?? 6_000;
    this.maxWaitMs = options.maxWaitMs ?? 1_000;
    this.retryMinMs = options.retryMinMs ?? 2;
    this.retryMaxMs = options.retryMaxMs ?? 6;
    this.sleep =
      options.sleep ??
      ((ms) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
    this.now = options.now ?? Date.now;
    this.random = options.random ?? Math.random;
  }

  async acquire(conversationId: string): Promise<ConversationWriteLockHandle> {
    const key = `chat:write-lock:${conversationId}`;
    const token = randomUUID();
    const startedAt = this.now();
    try {
      for (;;) {
        const reply = await this.redis.set(key, token, 'PX', this.ttlMs, 'NX');
        if (reply === 'OK') {
          return { held: true, release: () => this.release(key, token) };
        }
        if (this.now() - startedAt >= this.maxWaitMs) return unheld;
        await this.sleep(
          this.retryMinMs +
            Math.floor(this.random() * (this.retryMaxMs - this.retryMinMs + 1)),
        );
      }
    } catch {
      return unheld;
    }
  }

  private async release(key: string, token: string): Promise<void> {
    try {
      await this.redis.eval(RELEASE_SCRIPT, 1, key, token);
    } catch {
      // The lease expires on its own.
    }
  }
}
