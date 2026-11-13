import { PresenceRegistry } from './presence-registry';

// A small in-memory stand-in for the sorted-set commands the registry uses.
const makeFakeRedis = () => {
  const sets = new Map<string, Map<string, number>>();
  const set = (key: string) => {
    const existing = sets.get(key) ?? new Map<string, number>();
    sets.set(key, existing);
    return existing;
  };
  const ops = {
    zremrangebyscore: (key: string, _min: string, max: number) => {
      for (const [member, score] of set(key)) {
        if (score <= max) set(key).delete(member);
      }
      return 0;
    },
    zcount: (key: string, min: number) =>
      [...set(key).values()].filter((score) => score >= min).length,
    zadd: (key: string, ...args: (number | string)[]) => {
      for (let i = 0; i < args.length; i += 2)
        set(key).set(String(args[i + 1]), Number(args[i]));
      return 1;
    },
    zrem: (key: string, member: string) => (set(key).delete(member) ? 1 : 0),
    pexpire: () => 1,
  };
  const chain = () => {
    const queued: (() => unknown)[] = [];
    const proxy: Record<string, unknown> = {};
    for (const [name, fn] of Object.entries(ops)) {
      proxy[name] = (...args: never[]) => {
        queued.push(() => (fn as (...a: never[]) => unknown)(...args));
        return proxy;
      };
    }
    proxy.exec = () =>
      Promise.resolve(queued.map((run) => [null, run()] as [null, unknown]));
    return proxy;
  };
  return {
    sets,
    multi: jest.fn(chain),
    pipeline: jest.fn(chain),
    zcount: jest.fn((key: string, min: number) =>
      Promise.resolve(ops.zcount(key, min)),
    ),
  };
};

describe('PresenceRegistry', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2026-11-14T00:00:00Z'));
  });
  afterEach(() => jest.useRealTimers());

  it('reports whether the user already had a live socket on connect', async () => {
    const redis = makeFakeRedis();
    const registry = new PresenceRegistry(redis as never);

    expect(await registry.connect('u1', 's1')).toBe(false);
    expect(await registry.connect('u1', 's2')).toBe(true);
    expect(await registry.isOnline('u1')).toBe(true);
    expect(await registry.isOnline('u2')).toBe(false);
  });

  it('keeps the user online until their last socket disconnects', async () => {
    const registry = new PresenceRegistry(makeFakeRedis() as never);
    await registry.connect('u1', 's1');
    await registry.connect('u1', 's2');

    expect(await registry.disconnect('u1', 's1')).toBe(true);
    expect(await registry.disconnect('u1', 's2')).toBe(false);
    expect(await registry.isOnline('u1')).toBe(false);
  });

  it('counts sockets of different replicas together', async () => {
    const redis = makeFakeRedis();
    const macReplica = new PresenceRegistry(redis as never);
    const laptopReplica = new PresenceRegistry(redis as never);
    expect(macReplica.instanceId).not.toBe(laptopReplica.instanceId);

    await macReplica.connect('u1', 'same-socket-id');
    expect(await laptopReplica.connect('u1', 'same-socket-id')).toBe(true);
    // Each replica removes only its own socket.
    expect(await macReplica.disconnect('u1', 'same-socket-id')).toBe(true);
    expect(await laptopReplica.disconnect('u1', 'same-socket-id')).toBe(false);
  });

  it('stops counting sockets that were never refreshed (a replica that died)', async () => {
    const registry = new PresenceRegistry(makeFakeRedis() as never, {
      ttlMs: 45_000,
    });
    await registry.connect('u1', 's1');
    jest.advanceTimersByTime(44_000);
    expect(await registry.isOnline('u1')).toBe(true);
    jest.advanceTimersByTime(2_000);
    expect(await registry.isOnline('u1')).toBe(false);
  });

  it('keeps live sockets online by refreshing them on a timer', async () => {
    const redis = makeFakeRedis();
    const registry = new PresenceRegistry(redis as never, {
      ttlMs: 45_000,
      refreshMs: 15_000,
    });
    await registry.connect('u1', 's1');
    registry.startHeartbeat(() => [{ userId: 'u1', socketId: 's1' }]);

    for (let i = 0; i < 6; i++) await jest.advanceTimersByTimeAsync(15_000);
    expect(await registry.isOnline('u1')).toBe(true);

    registry.stopHeartbeat();
    await jest.advanceTimersByTimeAsync(60_000);
    expect(await registry.isOnline('u1')).toBe(false);
  });

  it('survives a failing refresh and reports it', async () => {
    const redis = makeFakeRedis();
    redis.pipeline.mockImplementation(() => {
      throw new Error('redis down');
    });
    const onError = jest.fn();
    const registry = new PresenceRegistry(redis as never, { refreshMs: 1_000 });
    registry.startHeartbeat(() => [{ userId: 'u1', socketId: 's1' }], onError);

    await jest.advanceTimersByTimeAsync(1_000);
    expect(onError).toHaveBeenCalledTimes(1);
    await jest.advanceTimersByTimeAsync(1_000);
    expect(onError).toHaveBeenCalledTimes(2);
    registry.stopHeartbeat();
  });

  it('does not start a heartbeat when switched off', () => {
    const registry = new PresenceRegistry(makeFakeRedis() as never, {
      enabled: false,
    });
    registry.startHeartbeat(() => []);
    expect(jest.getTimerCount()).toBe(0);
  });

  it('refreshes large sets in chunks', async () => {
    const redis = makeFakeRedis();
    const registry = new PresenceRegistry(redis as never);
    const sockets = Array.from({ length: 600 }, (_, i) => ({
      userId: `u${i}`,
      socketId: `s${i}`,
    }));
    await registry.refresh(sockets);
    // 600 users x (zadd + pexpire) = 1200 commands, flushed every 500.
    expect(redis.pipeline.mock.calls.length).toBeGreaterThanOrEqual(3);
    expect(await registry.isOnline('u599')).toBe(true);
  });
});
