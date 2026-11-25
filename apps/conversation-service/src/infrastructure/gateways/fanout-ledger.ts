import type Redis from 'ioredis';

/**
 * Remembers, for a few minutes, which messages were broadcast to their
 * conversation.
 *
 * A send whose write committed but whose first attempt still reported an error
 * (for example a database that answered late) is never broadcast: the client
 * resends, the retry finds the stored message and, by design, only reconciles
 * the sender. The fault tests found thousands of such messages reaching the
 * other members only through the history. With this ledger the retry can tell
 * a message that was broadcast from one that was not, and broadcast the latter
 * exactly once more. Redis trouble never causes a second broadcast: when the
 * ledger cannot answer, the message is treated as broadcast.
 */
export const FANOUT_TTL_SECONDS = 600;
const ANSWER_WITHIN_MS = 500;
const keyOf = (messageId: string) => `chat:fanout:${messageId}`;

type LedgerRedis = Pick<Redis, 'set' | 'exists'>;

function within<T>(promise: Promise<T>, ms: number): Promise<T | undefined> {
  let timer: NodeJS.Timeout | undefined;
  return Promise.race([
    promise,
    new Promise<undefined>((resolve) => {
      timer = setTimeout(() => resolve(undefined), ms);
    }),
  ]).finally(() => clearTimeout(timer));
}

export class FanoutLedger {
  constructor(
    private readonly redis: LedgerRedis,
    private readonly now: () => number = Date.now,
  ) {}

  /** Fire and forget: called after the broadcast went out. */
  markBroadcast(messageId: string): void {
    try {
      void this.redis
        .set(keyOf(messageId), '1', 'EX', FANOUT_TTL_SECONDS)
        .catch(() => undefined);
    } catch {
      // Never let the ledger break a send; the mark is only an optimisation.
    }
  }

  /**
   * True when a retry should broadcast the stored message: it is recent enough
   * for the ledger to know about it, and the ledger says it was never broadcast.
   */
  async needsBroadcast(messageId: string, createdAt: Date): Promise<boolean> {
    if (this.now() - createdAt.getTime() > FANOUT_TTL_SECONDS * 1000)
      return false;
    try {
      const pending = this.redis.exists(keyOf(messageId));
      pending.catch(() => undefined);
      const exists = await within(pending, ANSWER_WITHIN_MS);
      return exists === 0;
    } catch {
      return false;
    }
  }
}
