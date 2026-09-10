import { CallServiceRuntimeLease } from '../../../src/infrastructure/runtime/call-service-runtime-lease.service';

type RedisDouble = {
  set: jest.Mock;
  eval: jest.Mock;
  disconnect: jest.Mock;
};

function createRedis(overrides?: Partial<RedisDouble>): RedisDouble {
  return {
    set: jest.fn().mockResolvedValue('OK'),
    eval: jest.fn().mockResolvedValue(1),
    disconnect: jest.fn(),
    ...overrides,
  };
}

describe('CallServiceRuntimeLease', () => {
  const originalEnvironment = { ...process.env };

  beforeEach(() => {
    jest.useFakeTimers();
    process.env.CALL_SINGLE_INSTANCE_GUARD = 'true';
    process.env.CALL_RUNTIME_LEASE_TTL_MS = '9000';
    process.env.CALL_RUNTIME_LEASE_KEY = 'call-service:test-runtime-lease';
  });

  afterEach(() => {
    jest.useRealTimers();
    process.env = { ...originalEnvironment };
  });

  it('fails startup instead of allowing a second call runtime to serve media', async () => {
    const redis = createRedis({ set: jest.fn().mockResolvedValue(null) });
    const lease = new CallServiceRuntimeLease(redis as never);

    await expect(lease.acquire()).rejects.toThrow(
      'Another call-service instance already holds the runtime lease',
    );
    expect(redis.eval).not.toHaveBeenCalled();
    await lease.onModuleDestroy();
  });

  it('shares an in-flight acquire and renews only after it owns the lease', async () => {
    let resolveAcquire: (result: 'OK') => void = () => undefined;
    const redis = createRedis({
      set: jest.fn(
        () =>
          new Promise<'OK'>((resolve) => {
            resolveAcquire = resolve;
          }),
      ),
    });
    const lease = new CallServiceRuntimeLease(redis as never);

    const first = lease.acquire();
    const second = lease.acquire();
    expect(redis.set).toHaveBeenCalledTimes(1);

    resolveAcquire('OK');
    await Promise.all([first, second]);
    await jest.advanceTimersByTimeAsync(3000);

    expect(redis.eval).toHaveBeenCalledWith(
      expect.stringContaining('PEXPIRE'),
      1,
      'call-service:test-runtime-lease',
      expect.any(String),
      '9000',
    );
    await lease.onModuleDestroy();
  });

  it('fails closed when another instance takes the lease during renewal', async () => {
    const redis = createRedis({ eval: jest.fn().mockResolvedValue(0) });
    const lease = new CallServiceRuntimeLease(redis as never);
    const onLost = jest.fn();
    lease.onLeaseLost(onLost);
    await lease.acquire();

    await jest.advanceTimersByTimeAsync(3000);
    await Promise.resolve();

    expect(onLost).toHaveBeenCalledWith(
      expect.objectContaining({
        message: 'Call runtime lease ownership was lost',
      }),
    );
    expect(() => lease.assertHeld()).toThrow('lease is not held');
    await lease.onModuleDestroy();
  });

  it('releases only its own lease and never issues an unconditional delete', async () => {
    const redis = createRedis();
    const lease = new CallServiceRuntimeLease(redis as never);
    await lease.acquire();
    await lease.onModuleDestroy();

    expect(redis.eval).toHaveBeenLastCalledWith(
      expect.stringContaining("redis.call('DEL', KEYS[1])"),
      1,
      'call-service:test-runtime-lease',
      expect.any(String),
    );
    expect(redis.disconnect).toHaveBeenCalledWith(false);
  });

  it('allows an explicit local-only bypass without touching Redis', async () => {
    process.env.CALL_SINGLE_INSTANCE_GUARD = 'false';
    const redis = createRedis();
    const lease = new CallServiceRuntimeLease(redis as never);

    await lease.acquire();
    expect(() => lease.assertHeld()).not.toThrow();
    expect(redis.set).not.toHaveBeenCalled();
    await lease.onModuleDestroy();
  });
});
