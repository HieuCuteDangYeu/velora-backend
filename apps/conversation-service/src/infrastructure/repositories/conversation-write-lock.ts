import { randomUUID } from 'node:crypto';
import type Redis from 'ioredis';

/** Releases a lease only while it still holds the lock (compare-and-delete). */
const RELEASE_SCRIPT =
  "if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('del', KEYS[1]) else return 0 end";

export interface ConversationWriteLease {
  release(): Promise<void>;
}

interface LockOptions {
  /** How long a crashed holder blocks a conversation at most. */
  ttlMs?: number;
  /** After this long without the lock the write goes ahead unlocked. */
  maxWaitMs?: number;
  /** Set false to turn the lock off entirely. */
  enabled?: boolean;
  onTimeout?: (conversationId: string) => void;
}

type LockRedis = Pick<Redis, 'set' | 'eval'>;

const sleep = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * Cross-replica mutex for the message write of one conversation.
 *
 * PrismaChatRepository already queues writes per conversation inside one
 * process. With several conversation-service replicas two processes can update
 * the same conversation document in parallel, Mongo answers with write
 * conflicts (Prisma P2034) and every conflict costs a backoff and, eventually,
 * a failed message. This lock makes the replicas take turns per conversation.
 *
 * It never gets in the way of delivery: when Redis fails, answers something
 * unexpected, or the lock stays taken for maxWaitMs, acquire() returns null and
 * the caller writes without it, exactly as before the lock existed.
 */
export class ConversationWriteLock {
  private readonly ttlMs: number;
  private readonly maxWaitMs: number;
  private readonly enabled: boolean;

  constructor(
    private readonly redis: LockRedis,
    private readonly options: LockOptions = {},
  ) {
    this.ttlMs = options.ttlMs ?? 10_000;
    this.maxWaitMs = options.maxWaitMs ?? 1_500;
    this.enabled = options.enabled ?? true;
  }

  async acquire(
    conversationId: string,
  ): Promise<ConversationWriteLease | null> {
    if (!this.enabled) return null;

    const key = `chat:msgwrite:${conversationId}`;
    const token = randomUUID();
    const deadline = Date.now() + this.maxWaitMs;

    for (let attempt = 0; ; attempt++) {
      let reply: unknown;
      try {
        reply = await this.redis.set(key, token, 'PX', this.ttlMs, 'NX');
      } catch {
        return null;
      }
      if (reply === 'OK') {
        return {
          release: async () => {
            try {
              await this.redis.eval(RELEASE_SCRIPT, 1, key, token);
            } catch {
              // The ttl frees the lock; a failed release must not fail the write.
            }
          },
        };
      }
      // null is "someone else holds it"; anything else is not a real Redis answer.
      if (reply !== null) return null;
      if (Date.now() >= deadline) {
        this.options.onTimeout?.(conversationId);
        return null;
      }
      // A write takes a few milliseconds: poll quickly, with jitter so two
      // waiting replicas do not retry in lockstep.
      await sleep(4 + Math.min(attempt, 6) * 3 + Math.floor(Math.random() * 6));
    }
  }
}
