import {
  PrismaChatRepository,
  persistTimeoutMs,
  writeForwardTimeoutMs,
} from './prisma-chat.repository';

type Writes = { data: { conversationId: string } }[];

// Shared by every repository below, like the one Redis all replicas talk to.
const makeSharedRedis = () => {
  const held = new Set<string>();
  return {
    held,
    set: jest.fn((key: string) => {
      if (held.has(key)) return Promise.resolve(null);
      held.add(key);
      return Promise.resolve('OK');
    }),
    eval: jest.fn((_script: string, _n: number, key: string) => {
      held.delete(key);
      return Promise.resolve(1);
    }),
  };
};

// A repository whose Mongo transaction just records how many run at once.
const makeReplica = (redis: unknown, tracker: { now: number; max: number }) => {
  const repository = new PrismaChatRepository(
    {} as never,
    redis as never,
    {} as never,
    {} as never,
    {} as never,
  );
  jest
    .spyOn(
      repository as unknown as {
        persistLockedMessageBatch: () => Promise<unknown>;
      },
      'persistLockedMessageBatch',
    )
    .mockImplementation(async () => {
      tracker.now += 1;
      tracker.max = Math.max(tracker.max, tracker.now);
      await new Promise((resolve) => setTimeout(resolve, 15));
      tracker.now -= 1;
      return [];
    });
  return (conversationId: string) =>
    (
      repository as unknown as {
        persistMessageBatch: (writes: Writes) => Promise<unknown>;
      }
    ).persistMessageBatch([{ data: { conversationId } }]);
};

describe('PrismaChatRepository cross-replica write lock', () => {
  it('keeps two replicas from writing the same conversation at once', async () => {
    const redis = makeSharedRedis();
    const tracker = { now: 0, max: 0 };
    const replicaA = makeReplica(redis, tracker);
    const replicaB = makeReplica(redis, tracker);

    await Promise.all([
      replicaA('c1'),
      replicaB('c1'),
      replicaA('c1'),
      replicaB('c1'),
    ]);

    expect(tracker.max).toBe(1);
    expect(redis.held.size).toBe(0);
  });

  it('still lets different conversations write in parallel', async () => {
    const redis = makeSharedRedis();
    const tracker = { now: 0, max: 0 };
    const replicaA = makeReplica(redis, tracker);
    const replicaB = makeReplica(redis, tracker);

    await Promise.all([replicaA('c1'), replicaB('c2')]);

    expect(tracker.max).toBe(2);
  });

  it('releases the lock when the write fails', async () => {
    const redis = makeSharedRedis();
    const repository = new PrismaChatRepository(
      {} as never,
      redis as never,
      {} as never,
      {} as never,
      {} as never,
    );
    jest
      .spyOn(
        repository as unknown as {
          persistLockedMessageBatch: () => Promise<unknown>;
        },
        'persistLockedMessageBatch',
      )
      .mockRejectedValue(new Error('mongo down'));

    await expect(
      (
        repository as unknown as {
          persistMessageBatch: (writes: Writes) => Promise<unknown>;
        }
      ).persistMessageBatch([{ data: { conversationId: 'c1' } }]),
    ).rejects.toThrow('mongo down');
    expect(redis.held.size).toBe(0);
  });

  it('writes anyway when Redis is unreachable', async () => {
    const down = {
      set: jest.fn().mockRejectedValue(new Error('redis down')),
      eval: jest.fn(),
    };
    const tracker = { now: 0, max: 0 };
    const replica = makeReplica(down, tracker);
    await expect(replica('c1')).resolves.toEqual([]);
  });
});

describe('writeForwardTimeoutMs', () => {
  it('uses the 2 s default when unset or not a number', () => {
    expect(writeForwardTimeoutMs(undefined)).toBe(2_000);
    expect(writeForwardTimeoutMs('')).toBe(2_000);
    expect(writeForwardTimeoutMs('soon')).toBe(2_000);
  });

  it('clamps the configured value to 250 ms..10 s', () => {
    expect(writeForwardTimeoutMs('1500')).toBe(1_500);
    expect(writeForwardTimeoutMs('10')).toBe(250);
    expect(writeForwardTimeoutMs('60000')).toBe(10_000);
  });
});

describe('persist timeout', () => {
  it('uses 8 s unless configured, clamped to 1..60 s', () => {
    expect(persistTimeoutMs(undefined)).toBe(8_000);
    expect(persistTimeoutMs('x')).toBe(8_000);
    expect(persistTimeoutMs('3000')).toBe(3_000);
    expect(persistTimeoutMs('10')).toBe(1_000);
    expect(persistTimeoutMs('999999')).toBe(60_000);
  });

  it('fails a hung batch and its queue fast, but never starts a second writer', async () => {
    const recordPersistTimeout = jest.fn();
    let finishFirst!: (value: unknown[]) => void;
    const persistMessageBatch = jest
      .fn()
      .mockImplementationOnce(
        () =>
          new Promise<unknown[]>((resolve) => {
            finishFirst = resolve;
          }),
      )
      .mockImplementation((writes: unknown[]) =>
        Promise.resolve(writes.map(() => ({ ok: true }))),
      );
    const repo = Object.assign(Object.create(PrismaChatRepository.prototype), {
      persistTimeoutMs: 20,
      metrics: { recordPersistTimeout, recordPhase: jest.fn() },
      messageTransactions: new Map(),
      timedOutBatches: new WeakSet(),
      persistMessageBatch,
      isClientMessageIdConflict: () => false,
    }) as unknown as {
      enqueueMessageTransaction(id: string, write: unknown): Promise<unknown>;
    };
    const write = (n: number) => ({
      data: { conversationId: 'c', id: `0${n}` },
    });

    const first = repo.enqueueMessageTransaction('c', write(1));
    const queued = repo.enqueueMessageTransaction('c', write(2));
    await expect(first).rejects.toMatchObject({ status: 503 });
    await expect(queued).rejects.toMatchObject({ status: 503 });
    expect(recordPersistTimeout).toHaveBeenCalledTimes(1);
    // While the first write still hangs, a new message fails at once and no
    // second writer is started for the conversation.
    await expect(
      repo.enqueueMessageTransaction('c', write(3)),
    ).rejects.toMatchObject({
      status: 503,
    });
    expect(persistMessageBatch).toHaveBeenCalledTimes(1);

    // Once the hung write settles, the conversation accepts writes again.
    finishFirst([{ ok: true }]);
    await new Promise((resolve) => setImmediate(resolve));
    await expect(
      repo.enqueueMessageTransaction('c', write(4)),
    ).resolves.toEqual({
      ok: true,
    });
    expect(persistMessageBatch).toHaveBeenCalledTimes(2);
  });
});
