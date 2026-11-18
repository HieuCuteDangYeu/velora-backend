export interface AiTurnLimitDecision {
  allowed: boolean;
  /** Seconds until the user may ask again; 0 when allowed. */
  retryAfterSeconds: number;
}

/**
 * Port for the per-user budget on paid AI replies. Consuming is atomic and
 * shared across service replicas; the mechanism is an infrastructure concern.
 */
export interface IAiTurnLimiter {
  /** `withImage` also spends the tighter photo budget, because the turn costs a vision call. */
  consume(
    userId: string,
    options?: { withImage?: boolean },
  ): Promise<AiTurnLimitDecision>;
}
