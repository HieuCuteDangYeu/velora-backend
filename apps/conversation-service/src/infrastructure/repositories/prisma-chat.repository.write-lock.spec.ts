import { PrismaChatRepository } from './prisma-chat.repository';

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
