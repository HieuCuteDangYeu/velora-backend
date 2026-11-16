/**
 * Small, dependency-free concurrency helpers for work that shares a tiny
 * database pool (content-service runs Prisma with a handful of connections).
 */

export function readBoundedIntEnv(
  name: string,
  fallback: number,
  max: number,
  env: NodeJS.ProcessEnv = process.env,
): number {
  const parsed = Number(env[name]);
  if (!Number.isInteger(parsed) || parsed < 1) return fallback;
  return Math.min(parsed, max);
}

/**
 * Like Promise.allSettled over `items`, but runs at most `limit` workers at once.
 * Results keep the order of `items`.
 */
export async function settleWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  worker: (item: T) => Promise<R>,
): Promise<PromiseSettledResult<R>[]> {
  const results: PromiseSettledResult<R>[] = new Array<PromiseSettledResult<R>>(
    items.length,
  );
  let next = 0;

  const run = async (): Promise<void> => {
    while (next < items.length) {
      const index = next;
      next += 1;
      try {
        results[index] = {
          status: 'fulfilled',
          value: await worker(items[index]),
        };
      } catch (reason: unknown) {
        results[index] = { status: 'rejected', reason };
      }
    }
  };

  await Promise.all(
    Array.from({ length: Math.min(Math.max(limit, 1), items.length) }, run),
  );
  return results;
}

/**
 * FIFO counting semaphore with a bounded queue. `acquire` resolves to a release
 * function, or null when the queue is already full (caller should back off).
 */
export class ConcurrencyGate {
  private active = 0;
  private readonly waiters: Array<(release: () => void) => void> = [];

  constructor(
    private readonly maxActive: number,
    private readonly maxQueued: number,
  ) {}

  get queued(): number {
    return this.waiters.length;
  }

  async acquire(): Promise<(() => void) | null> {
    if (this.active < this.maxActive) {
      this.active += 1;
      return this.createRelease();
    }
    if (this.waiters.length >= this.maxQueued) return null;

    return await new Promise<() => void>((resolve) => {
      this.waiters.push(resolve);
    });
  }

  private createRelease(): () => void {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const next = this.waiters.shift();
      if (next) {
        // Hand the slot straight to the next waiter; `active` stays the same.
        next(this.createRelease());
      } else {
        this.active -= 1;
      }
    };
  }
}
