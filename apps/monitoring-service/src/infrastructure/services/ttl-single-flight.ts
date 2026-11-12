/**
 * Shares one in-flight load between concurrent callers and keeps a successful
 * result for `ttlMs`. A failed load is never cached, so the next caller retries
 * immediately. Same contract the overview endpoint has always had.
 */
export class TtlSingleFlight<T> {
  private promise: Promise<T> | null = null;
  private expiresAt = 0;

  constructor(
    private readonly ttlMs: number,
    private readonly now: () => number = Date.now,
  ) {}

  get(load: () => Promise<T>): Promise<T> {
    if (!this.promise || this.now() >= this.expiresAt) {
      // Hold the slot open until the load settles so callers share it.
      this.expiresAt = Infinity;
      const current: Promise<T> = load().then(
        (value) => {
          if (this.promise === current)
            this.expiresAt = this.now() + this.ttlMs;
          return value;
        },
        (error: unknown) => {
          if (this.promise === current) this.promise = null;
          throw error;
        },
      );
      this.promise = current;
    }

    return this.promise;
  }
}

/** One TtlSingleFlight per key. Keys must come from a bounded set. */
export class KeyedTtlSingleFlight<T> {
  private readonly slots = new Map<string, TtlSingleFlight<T>>();

  constructor(
    private readonly ttlMs: number,
    private readonly now: () => number = Date.now,
  ) {}

  get(key: string, load: () => Promise<T>): Promise<T> {
    let slot = this.slots.get(key);
    if (!slot) {
      slot = new TtlSingleFlight<T>(this.ttlMs, this.now);
      this.slots.set(key, slot);
    }

    return slot.get(load);
  }
}
