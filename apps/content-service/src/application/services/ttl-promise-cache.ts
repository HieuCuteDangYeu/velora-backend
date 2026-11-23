/**
 * Tiny in-process cache of in-flight/settled promises with a fixed TTL.
 * Concurrent callers for one key share a single load, and a failed load is
 * dropped so the next caller retries instead of replaying the error. `shouldCache`
 * can also keep chosen results (say, denials) from being remembered.
 *
 * With `refreshAheadMs`, a hit in the last that-many milliseconds of its life still returns
 * the cached value at once, and one background load replaces it. Callers that are
 * active keep finding a warm entry instead of one of them waiting on every expiry. An entry
 * never lives longer than the ttl, and a failed refresh keeps the old entry until then,
 * so the freshness bound is the same as without it.
 */
export class TtlPromiseCache<T> {
  private readonly entries = new Map<
    string,
    { expiresAt: number; value: Promise<T>; refreshing?: boolean }
  >();

  constructor(
    private readonly ttlMs: number,
    private readonly maxEntries = 2_000,
    private readonly now: () => number = Date.now,
    private readonly shouldCache: (value: T) => boolean = () => true,
    private readonly refreshAheadMs = 0,
  ) {}

  get(key: string, load: () => Promise<T>): Promise<T> {
    const now = this.now();
    const hit = this.entries.get(key);
    if (hit && hit.expiresAt > now) {
      if (
        this.refreshAheadMs > 0 &&
        !hit.refreshing &&
        hit.expiresAt - now <= this.refreshAheadMs
      ) {
        this.refresh(key, hit, load);
      }
      return hit.value;
    }

    this.evict(now);
    const value = load();
    this.entries.set(key, { expiresAt: now + this.ttlMs, value });
    const drop = () => {
      if (this.entries.get(key)?.value === value) this.entries.delete(key);
    };
    value.then((resolved) => {
      if (!this.shouldCache(resolved)) drop();
    }, drop);
    return value;
  }

  private refresh(
    key: string,
    current: { expiresAt: number; value: Promise<T>; refreshing?: boolean },
    load: () => Promise<T>,
  ): void {
    current.refreshing = true;
    let next: Promise<T>;
    try {
      next = load();
    } catch {
      current.refreshing = false;
      return;
    }
    next.then(
      (resolved) => {
        if (this.entries.get(key) === current && this.shouldCache(resolved)) {
          this.entries.set(key, {
            expiresAt: this.now() + this.ttlMs,
            value: next,
          });
        } else {
          current.refreshing = false;
        }
      },
      () => {
        current.refreshing = false;
      },
    );
  }

  private evict(now: number): void {
    for (const [key, entry] of this.entries) {
      if (entry.expiresAt <= now) this.entries.delete(key);
    }
    while (this.entries.size >= this.maxEntries) {
      const oldest = this.entries.keys().next();
      if (oldest.done) break;
      this.entries.delete(oldest.value);
    }
  }
}
