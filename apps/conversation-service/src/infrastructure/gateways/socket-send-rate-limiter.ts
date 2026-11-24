/**
 * Token bucket per socket for send_message.
 *
 * A phone sends a few messages a second at most, even when it flushes its
 * offline queue, so the defaults (10 per second, bursts of 30) never touch a
 * person. They stop one socket (a bug or a script) from flooding a
 * conversation and the write path. CHAT_SOCKET_SEND_RATE=off turns it off,
 * for example for a load test that drives many messages through few sockets.
 */
export type SendRateLimit = { ratePerSecond: number; burst: number } | null;

export type SendRateDecision =
  | { allowed: true }
  | { allowed: false; retryAfterMs: number };

type Bucket = { tokens: number; updatedAt: number };

const BUCKET_KEY = 'sendRateBucket';

export function sendRateLimitFromEnv(
  env: Record<string, string | undefined> = process.env,
): SendRateLimit {
  const rawRate = env.CHAT_SOCKET_SEND_RATE?.trim().toLowerCase();
  if (rawRate === 'off') return null;
  const rate = positive(rawRate, 10);
  const burst = Math.max(1, positive(env.CHAT_SOCKET_SEND_BURST, 30));
  return { ratePerSecond: rate, burst };
}

function positive(raw: string | undefined, fallback: number): number {
  const value = Number(raw);
  return raw && Number.isFinite(value) && value > 0 ? value : fallback;
}

/** Takes one token from the socket's bucket; the bucket lives in socket.data. */
export function takeSendToken(
  data: Record<string, unknown>,
  limit: SendRateLimit,
  now: number = Date.now(),
): SendRateDecision {
  if (!limit) return { allowed: true };
  const previous = data[BUCKET_KEY] as Bucket | undefined;
  const elapsed = previous ? Math.max(0, now - previous.updatedAt) : 0;
  const tokens = previous
    ? Math.min(
        limit.burst,
        previous.tokens + (elapsed / 1_000) * limit.ratePerSecond,
      )
    : limit.burst;
  if (tokens >= 1) {
    data[BUCKET_KEY] = { tokens: tokens - 1, updatedAt: now };
    return { allowed: true };
  }
  data[BUCKET_KEY] = { tokens, updatedAt: now };
  return {
    allowed: false,
    retryAfterMs: Math.ceil(((1 - tokens) / limit.ratePerSecond) * 1_000),
  };
}
