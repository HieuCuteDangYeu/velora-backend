/**
 * Logs a repeating warning at most once per interval for each key, and says how many
 * identical warnings were left out since the last line.
 *
 * Under load a feed request used to log a warning of its own for every slow lookup or
 * deferred refill: about 1,000 lines a second per replica at 1550 viewers, and writing
 * them was a fifth of the service's CPU (CPU profile, 2026-11-23). One line per interval
 * still shows that it is happening, with an example and a count. Use fixed keys, not ids:
 * the key set must stay small.
 */
export class ThrottledWarn {
  private readonly state = new Map<
    string,
    { lastLoggedAt: number; suppressed: number }
  >();

  constructor(
    private readonly logger: { warn(message: string): void },
    private readonly intervalMs = 10_000,
    private readonly now: () => number = Date.now,
  ) {}

  warn(key: string, message: string): void {
    const now = this.now();
    const entry = this.state.get(key);

    if (entry && now - entry.lastLoggedAt < this.intervalMs) {
      entry.suppressed += 1;
      return;
    }

    const suppressed = entry?.suppressed ?? 0;
    this.state.set(key, { lastLoggedAt: now, suppressed: 0 });
    this.logger.warn(
      suppressed > 0
        ? `${message} (+${suppressed} similar in the last ${Math.round(
            (now - (entry?.lastLoggedAt ?? now)) / 1000,
          )}s)`
        : message,
    );
  }
}
