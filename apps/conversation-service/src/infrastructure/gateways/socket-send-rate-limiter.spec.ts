import {
  sendRateLimitFromEnv,
  takeSendToken,
} from './socket-send-rate-limiter';

describe('socket send rate limiter', () => {
  const limit = { ratePerSecond: 10, burst: 3 };

  it('allows a burst, then refuses with the wait until the next token', () => {
    const data: Record<string, unknown> = {};
    const t = 1_000_000;
    expect(takeSendToken(data, limit, t)).toEqual({ allowed: true });
    expect(takeSendToken(data, limit, t)).toEqual({ allowed: true });
    expect(takeSendToken(data, limit, t)).toEqual({ allowed: true });
    expect(takeSendToken(data, limit, t)).toEqual({
      allowed: false,
      retryAfterMs: 100,
    });
  });

  it('refills at the configured rate and never above the burst', () => {
    const data: Record<string, unknown> = {};
    const t = 1_000_000;
    for (let i = 0; i < 3; i++) takeSendToken(data, limit, t);
    expect(takeSendToken(data, limit, t + 100).allowed).toBe(true);
    expect(takeSendToken(data, limit, t + 100).allowed).toBe(false);
    // A long pause refills to the burst, not beyond it.
    for (let i = 0; i < 3; i++)
      expect(takeSendToken(data, limit, t + 60_000).allowed).toBe(true);
    expect(takeSendToken(data, limit, t + 60_000).allowed).toBe(false);
  });

  it('keeps one bucket per socket', () => {
    const a: Record<string, unknown> = {};
    const b: Record<string, unknown> = {};
    for (let i = 0; i < 3; i++) takeSendToken(a, limit, 0);
    expect(takeSendToken(a, limit, 0).allowed).toBe(false);
    expect(takeSendToken(b, limit, 0).allowed).toBe(true);
  });

  it('reads its settings from the environment', () => {
    expect(sendRateLimitFromEnv({})).toEqual({ ratePerSecond: 10, burst: 30 });
    expect(
      sendRateLimitFromEnv({
        CHAT_SOCKET_SEND_RATE: '5',
        CHAT_SOCKET_SEND_BURST: '8',
      }),
    ).toEqual({ ratePerSecond: 5, burst: 8 });
    expect(sendRateLimitFromEnv({ CHAT_SOCKET_SEND_RATE: 'OFF' })).toBeNull();
    expect(sendRateLimitFromEnv({ CHAT_SOCKET_SEND_RATE: 'fast' })).toEqual({
      ratePerSecond: 10,
      burst: 30,
    });
    expect(takeSendToken({}, null)).toEqual({ allowed: true });
  });
});
