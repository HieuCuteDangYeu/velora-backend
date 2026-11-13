import { ConversationWriteLock } from './conversation-write-lock';

// Just enough Redis for SET key token PX ttl NX and the compare-and-delete script.
const makeFakeRedis = () => {
  const store = new Map<string, { token: string; expiresAt: number }>();
  const live = (key: string) => {
    const entry = store.get(key);
    if (entry && entry.expiresAt <= Date.now()) store.delete(key);
    return store.get(key);
  };
  return {
    store,
    set: jest.fn((key: string, token: string, _px: string, ttl: number) => {
      if (live(key)) return Promise.resolve(null);
      store.set(key, { token, expiresAt: Date.now() + ttl });
      return Promise.resolve('OK');
    }),
    eval: jest.fn((_script: string, _n: number, key: string, token: string) => {
      if (live(key)?.token === token) {
        store.delete(key);
        return Promise.resolve(1);
      }
      return Promise.resolve(0);
    }),
  };
};

describe('ConversationWriteLock', () => {
  it('lets one replica at a time write a conversation', async () => {
    const redis = makeFakeRedis();
    const replicaA = new ConversationWriteLock(redis as never);
    const replicaB = new ConversationWriteLock(redis as never);

    const first = await replicaA.acquire('c1');
    expect(first).not.toBeNull();

    let secondHasLock = false;
    const second = replicaB.acquire('c1').then((lease) => {
      secondHasLock = lease !== null;
      return lease;
    });
    await new Promise((resolve) => setTimeout(resolve, 40));
    expect(secondHasLock).toBe(false);

    await first?.release();
    const lease = await second;
    expect(lease).not.toBeNull();
    await lease?.release();
    expect(redis.store.size).toBe(0);
  });

  it('does not make different conversations wait for each other', async () => {
    const redis = makeFakeRedis();
    const lock = new ConversationWriteLock(redis as never);
    const a = await lock.acquire('c1');
    const startedAt = Date.now();
    const b = await lock.acquire('c2');
    expect(b).not.toBeNull();
    expect(Date.now() - startedAt).toBeLessThan(30);
    await a?.release();
    await b?.release();
  });

  it('writes without the lock after maxWaitMs and reports the timeout', async () => {
    const redis = makeFakeRedis();
    const onTimeout = jest.fn();
    const holder = new ConversationWriteLock(redis as never);
    const waiter = new ConversationWriteLock(redis as never, {
      maxWaitMs: 60,
      onTimeout,
    });
    await holder.acquire('c1');
    expect(await waiter.acquire('c1')).toBeNull();
    expect(onTimeout).toHaveBeenCalledWith('c1');
  });

  it('never blocks a write when Redis fails or answers oddly', async () => {
    const down = new ConversationWriteLock({
      set: jest.fn().mockRejectedValue(new Error('redis down')),
      eval: jest.fn(),
    });
    expect(await down.acquire('c1')).toBeNull();

    // A mocked client that resolves undefined must not turn into a 1.5 s wait.
    const odd = new ConversationWriteLock({
      set: jest.fn().mockResolvedValue(undefined),
      eval: jest.fn(),
    });
    const startedAt = Date.now();
    expect(await odd.acquire('c1')).toBeNull();
    expect(Date.now() - startedAt).toBeLessThan(30);
  });

  it('does not touch Redis when switched off', async () => {
    const redis = makeFakeRedis();
    const lock = new ConversationWriteLock(redis as never, { enabled: false });
    expect(await lock.acquire('c1')).toBeNull();
    expect(redis.set).not.toHaveBeenCalled();
  });

  it('never releases a lock that expired and now belongs to someone else', async () => {
    const redis = makeFakeRedis();
    const slow = new ConversationWriteLock(redis as never, { ttlMs: 20 });
    const other = new ConversationWriteLock(redis as never);

    const stale = await slow.acquire('c1');
    await new Promise((resolve) => setTimeout(resolve, 40));
    const current = await other.acquire('c1');
    expect(current).not.toBeNull();

    await stale!.release();
    expect(redis.store.has('chat:msgwrite:c1')).toBe(true);
    await current!.release();
    expect(redis.store.size).toBe(0);
  });

  it('survives a failing release (the ttl frees the lock)', async () => {
    const redis = makeFakeRedis();
    redis.eval.mockRejectedValueOnce(new Error('redis down'));
    const lock = new ConversationWriteLock(redis as never);
    const lease = await lock.acquire('c1');
    await expect(lease!.release()).resolves.toBeUndefined();
  });
});
