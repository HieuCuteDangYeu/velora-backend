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
  consume(userId: string): Promise<AiTurnLimitDecision>;
}
