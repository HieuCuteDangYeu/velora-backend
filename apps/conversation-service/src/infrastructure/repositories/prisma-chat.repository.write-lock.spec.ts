import { PrismaChatRepository } from './prisma-chat.repository';

type QueueHarness = {
  enqueueMessageTransaction: (
    conversationId: string,
    write: unknown,
  ) => Promise<unknown>;
  persistMessageBatch: (writes: unknown[]) => Promise<unknown[]>;
};

const createHarness = () => {
  const events: string[] = [];
  const redis = {
    set: jest.fn((key: string) => {
      events.push(`lock ${key}`);
      return Promise.resolve('OK');
    }),
    eval: jest.fn((_script: string, _keys: number, key: string) => {
      events.push(`unlock ${key}`);
      return Promise.resolve(1);
    }),
  };
  const repository = new PrismaChatRepository(
    {} as never,
    redis as never,
    {} as never,
    {} as never,
    {} as never,
  ) as unknown as QueueHarness;
  return { events, redis, repository };
};

const write = (id: string) => ({
  data: { id, conversationId: 'conversation-1' },
});

describe('PrismaChatRepository message write lock', () => {
  it('holds the conversation lock only while the batch is persisted', async () => {
    const { events, repository } = createHarness();
    repository.persistMessageBatch = jest.fn((writes) => {
      events.push('persist');
      return Promise.resolve(writes.map((entry) => [entry, {}]));
    });

    await repository.enqueueMessageTransaction('conversation-1', write('a'));

    expect(events).toEqual([
      'lock chat:write-lock:conversation-1',
      'persist',
      'unlock chat:write-lock:conversation-1',
    ]);
  });

  it('releases the lock when the persist fails', async () => {
    const { events, repository } = createHarness();
    repository.persistMessageBatch = jest.fn(() => {
      events.push('persist');
      return Promise.reject(new Error('mongo down'));
    });

    await expect(
      repository.enqueueMessageTransaction('conversation-1', write('a')),
    ).rejects.toThrow('mongo down');

    expect(events).toEqual([
      'lock chat:write-lock:conversation-1',
      'persist',
      'unlock chat:write-lock:conversation-1',
    ]);
  });

  it('takes the lock once per batch and batches writes queued meanwhile', async () => {
    const { events, repository } = createHarness();
    let release: (() => void) | undefined;
    repository.persistMessageBatch = jest.fn(
      (writes) =>
        new Promise((resolve) => {
          events.push(`persist ${writes.length}`);
          release = () => resolve(writes.map((entry) => [entry, {}]));
        }),
    );

    const first = repository.enqueueMessageTransaction(
      'conversation-1',
      write('a'),
    );
    const second = repository.enqueueMessageTransaction(
      'conversation-1',
      write('b'),
    );
    await new Promise((resolve) => setImmediate(resolve));
    release?.();
    await first;
    await new Promise((resolve) => setImmediate(resolve));
    release?.();
    await second;

    expect(events.filter((event) => event.startsWith('lock '))).toHaveLength(2);
    expect(events.filter((event) => event.startsWith('unlock '))).toHaveLength(
      2,
    );
    expect(events.indexOf('persist 1')).toBeGreaterThan(
      events.indexOf('lock chat:write-lock:conversation-1'),
    );
  });
});
