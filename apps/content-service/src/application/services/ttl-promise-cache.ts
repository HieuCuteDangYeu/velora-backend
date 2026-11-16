/**
 * Tiny in-process cache of in-flight/settled promises with a fixed TTL.
 * Concurrent callers for one key share a single load, and a failed load is
 * dropped so the next caller retries instead of replaying the error.
 */
export class TtlPromiseCache<T> {
  private readonly entries = new Map<
    string,
    { expiresAt: number; value: Promise<T> }
  >();

  constructor(
    private readonly ttlMs: number,
    private readonly maxEntries = 2_000,
    private readonly now: () => number = Date.now,
  ) {}

  get(key: string, load: () => Promise<T>): Promise<T> {
    const now = this.now();
    const hit = this.entries.get(key);
    if (hit && hit.expiresAt > now) return hit.value;

    this.evict(now);
    const value = load();
    this.entries.set(key, { expiresAt: now + this.ttlMs, value });
    value.catch(() => {
      if (this.entries.get(key)?.value === value) this.entries.delete(key);
    });
    return value;
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
