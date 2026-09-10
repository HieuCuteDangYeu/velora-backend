export const DEFAULT_CALL_NO_ANSWER_TIMEOUT_MS = 30_000;

/**
 * The ringing deadline is part of the server-owned lifecycle contract. A
 * malformed deployment variable must not turn it into `NaN`/zero in one
 * process while another process advertises a different deadline to clients.
 */
export function getCallNoAnswerTimeoutMs(): number {
  const parsed = Number(process.env.CALL_NO_ANSWER_TIMEOUT_MS);
  return Number.isFinite(parsed) && parsed > 0
    ? Math.floor(parsed)
    : DEFAULT_CALL_NO_ANSWER_TIMEOUT_MS;
}

export function getSessionRingTimeoutMs(value: number | undefined): number {
  if (typeof value === 'number' && Number.isFinite(value) && value > 0) {
    return Math.floor(value);
  }
  return getCallNoAnswerTimeoutMs();
}

/**
 * Redis can contain a session written by an older build or a partially
 * migrated deployment. Never let an invalid serialized date crash fan-out or
 * turn the in-memory prompt timeout into an immediate `NaN` timeout.
 */
export function getSessionExpiryDate(
  expiresAt: Date | undefined,
  ringTimeoutMs: number | undefined,
  now = new Date(),
): Date {
  if (expiresAt instanceof Date && Number.isFinite(expiresAt.getTime())) {
    return expiresAt;
  }
  return new Date(now.getTime() + getSessionRingTimeoutMs(ringTimeoutMs));
}
