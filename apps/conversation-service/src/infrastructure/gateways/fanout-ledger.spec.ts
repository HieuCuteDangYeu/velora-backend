import { FANOUT_TTL_SECONDS, FanoutLedger } from './fanout-ledger';

function fakeRedis() {
  const keys = new Set<string>();
  return {
    keys,
    set: jest.fn((key: string) => {
      keys.add(key);
      return Promise.resolve('OK');
    }),
    exists: jest.fn((key: string) => Promise.resolve(keys.has(key) ? 1 : 0)),
  };
}

describe('FanoutLedger', () => {
  const now = 1_800_000_000_000;

  it('asks for a broadcast only for a recent message that was never broadcast', async () => {
    const redis = fakeRedis();
    const ledger = new FanoutLedger(redis as never, () => now);
    expect(await ledger.needsBroadcast('m1', new Date(now - 1_000))).toBe(true);
    ledger.markBroadcast('m1');
    await Promise.resolve();
    expect(await ledger.needsBroadcast('m1', new Date(now - 1_000))).toBe(
      false,
    );
  });

  it('leaves old messages alone (the ledger no longer knows about them)', async () => {
    const ledger = new FanoutLedger(fakeRedis() as never, () => now);
    const old = new Date(now - (FANOUT_TTL_SECONDS + 1) * 1_000);
    expect(await ledger.needsBroadcast('m2', old)).toBe(false);
  });

  it('never causes a second broadcast when Redis fails or does not answer', async () => {
    const failing = new FanoutLedger(
      {
        set: jest.fn(),
        exists: jest.fn(() => Promise.reject(new Error('down'))),
      } as never,
      () => now,
    );
    expect(await failing.needsBroadcast('m3', new Date(now))).toBe(false);
    const silent = new FanoutLedger(
      {
        set: jest.fn(),
        exists: jest.fn(() => new Promise<number>(() => undefined)),
      } as never,
      () => now,
    );
    expect(await silent.needsBroadcast('m4', new Date(now))).toBe(false);
  });

  it('keeps the mark for the TTL and ignores a failing write', () => {
    const redis = {
      set: jest.fn(() => Promise.reject(new Error('down'))),
      exists: jest.fn(),
    };
    new FanoutLedger(redis as never).markBroadcast('m5');
    expect(redis.set).toHaveBeenCalledWith(
      'chat:fanout:m5',
      '1',
      'EX',
      FANOUT_TTL_SECONDS,
    );
  });
});
