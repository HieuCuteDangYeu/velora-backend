import { ConversationWriteLock } from './conversation-write-lock';

// Minimal in-memory stand-in for the two Redis commands the lock uses.
class FakeRedis {
  readonly values = new Map<string, { token: string; expiresAt: number }>();
  failSet = false;

  constructor(private readonly clock: { now: number }) {}

  set(
    key: string,
    token: string,
    _px: 'PX',
    ttl: number,
  ): Promise<'OK' | null> {
    if (this.failSet) return Promise.reject(new Error('redis down'));
    const current = this.values.get(key);
    if (current && current.expiresAt > this.clock.now)
      return Promise.resolve(null);
    this.values.set(key, { token, expiresAt: this.clock.now + ttl });
    return Promise.resolve('OK');
  }

  eval(_script: string, _keys: number, key: string, token: string) {
    const current = this.values.get(key);
    if (current?.token !== token) return Promise.resolve(0);
    this.values.delete(key);
    return Promise.resolve(1);
  }
}

const harness = (
  options: ConstructorParameters<typeof ConversationWriteLock>[1] = {},
) => {
  const clock = { now: 1_000 };
  const redis = new FakeRedis(clock);
  const sleeps: number[] = [];
  const lock = new ConversationWriteLock(redis as never, {
    sleep: (ms) => {
      sleeps.push(ms);
      clock.now += ms;
      return Promise.resolve();
    },
    now: () => clock.now,
    random: () => 0,
    ...options,
  });
  return { clock, redis, sleeps, lock };
};

describe('ConversationWriteLock', () => {
  it('holds the lock for one conversation and releases it', async () => {
    const { redis, lock } = harness();

    const handle = await lock.acquire('conversation-1');

    expect(handle.held).toBe(true);
    expect(redis.values.has('chat:write-lock:conversation-1')).toBe(true);
    await handle.release();
    expect(redis.values.size).toBe(0);
  });

  it('lets different conversations write at the same time', async () => {
    const { lock } = harness();

    const first = await lock.acquire('conversation-1');
    const second = await lock.acquire('conversation-2');

    expect(first.held).toBe(true);
    expect(second.held).toBe(true);
  });

  it('waits for the holder of the same conversation and then takes the lock', async () => {
    const { clock, redis, lock } = harness();
    const first = await lock.acquire('conversation-1');
    let waited = 0;
    const waiting = new ConversationWriteLock(redis as never, {
      // The first holder finishes while the second one is retrying.
      sleep: async (ms) => {
        waited += ms;
        clock.now += ms;
        if (waited >= 4) await first.release();
      },
      now: () => clock.now,
      random: () => 0,
    });

    const second = await waiting.acquire('conversation-1');

    expect(second.held).toBe(true);
    expect(waited).toBe(4);
  });

  it('proceeds without the lock after the maximum wait', async () => {
    const { redis, lock } = harness({ maxWaitMs: 10 });
    const holder = await lock.acquire('conversation-1');

    const waiter = await lock.acquire('conversation-1');

    expect(waiter.held).toBe(false);
    await waiter.release();
    // The unheld handle must not touch the real holder's lock.
    expect(redis.values.has('chat:write-lock:conversation-1')).toBe(true);
    await holder.release();
    expect(redis.values.size).toBe(0);
  });

  it('proceeds without the lock when Redis fails', async () => {
    const { redis, lock } = harness();
    redis.failSet = true;

    const handle = await lock.acquire('conversation-1');

    expect(handle.held).toBe(false);
    await expect(handle.release()).resolves.toBeUndefined();
  });

  it('proceeds without the lock when the client has no lock commands', async () => {
    const lock = new ConversationWriteLock({} as never);

    await expect(lock.acquire('conversation-1')).resolves.toMatchObject({
      held: false,
    });
  });

  it('does not release a lock that expired and was taken by another writer', async () => {
    const { clock, redis, lock } = harness({ ttlMs: 50 });
    const expired = await lock.acquire('conversation-1');
    clock.now += 100;
    const next = await lock.acquire('conversation-1');
    expect(next.held).toBe(true);

    await expired.release();

    expect(redis.values.has('chat:write-lock:conversation-1')).toBe(true);
    await next.release();
    expect(redis.values.size).toBe(0);
  });
});
