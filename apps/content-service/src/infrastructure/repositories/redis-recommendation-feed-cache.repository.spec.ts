import type { Reel } from '@content/domain/entities/reel.entity';
import type Redis from 'ioredis';
import { RedisRecommendationFeedCacheRepository } from './redis-recommendation-feed-cache.repository';

function reel(): Reel {
  return {
    id: 'reel-1',
    userId: 'creator-1',
    mediaKey: 'reels/reel-1.mp4',
    tags: ['cache'],
    status: 'COMPLETED',
    mediaStatus: 'COMPLETED',
    indexStatus: 'COMPLETED',
    visibility: 'public',
    viewCount: 42n,
    processingCompletedAt: new Date('2026-09-19T09:30:00.000Z'),
    createdAt: new Date('2026-09-19T09:00:00.000Z'),
    updatedAt: new Date('2026-09-19T10:00:00.000Z'),
  };
}

function fencedRedis() {
  let value: string | null = null;
  const invalidationVersion = new Date('2026-09-19T10:30:00.000Z').getTime();
  const pendingExecutions: Array<{
    commands: unknown[][];
    resolve: (result: unknown) => void;
  }> = [];

  const run = (command: unknown[]): number => {
    const script = command[0] as string;
    const raw = value ? (JSON.parse(value) as Record<string, unknown>) : null;
    const currentVersion = typeof raw?.version === 'number' ? raw.version : 0;
    const hasVersion = typeof raw?.version === 'number';
    const invalidated = raw?.invalidated === true;

    if (script.includes('local version = 0')) {
      const version = hasVersion ? currentVersion : invalidationVersion;
      value = JSON.stringify({ invalidated: true, version });
      return version;
    }

    const incomingVersion = Number(command[5]);
    if (
      (invalidated && !hasVersion) ||
      currentVersion > incomingVersion ||
      (invalidated && incomingVersion <= currentVersion)
    ) {
      return 0;
    }

    value = JSON.stringify({
      version: incomingVersion,
      reel: JSON.parse(command[3] as string),
    });
    return 1;
  };

  const pipeline = jest.fn((): { eval: jest.Mock; exec: jest.Mock } => {
    const commands: unknown[][] = [];
    const api: { eval: jest.Mock; exec: jest.Mock } = {
      eval: jest.fn((...args: unknown[]) => {
        commands.push(args);
        return api;
      }),
      exec: jest.fn(
        () =>
          new Promise((resolve) => {
            pendingExecutions.push({ commands, resolve });
          }),
      ),
    };
    return api;
  });

  const redis = {
    mget: jest.fn((...keys: string[]) =>
      Promise.resolve(keys.map(() => value)),
    ),
    pipeline,
  } as unknown as Redis;

  return {
    redis,
    pendingExecutions,
    resolveExecution(index: number) {
      pendingExecutions[index].resolve(
        pendingExecutions[index].commands.map((command) => [
          null,
          run(command),
        ]),
      );
    },
  };
}

describe('RedisRecommendationFeedCacheRepository', () => {
  it('uses the exact global recommendation slate key', async () => {
    const slate = {
      generatedAt: '2026-09-19T10:00:00.000Z',
      items: [],
    };
    const get = jest.fn().mockResolvedValue(JSON.stringify(slate));
    const set = jest.fn().mockResolvedValue('OK');
    const repository = new RedisRecommendationFeedCacheRepository({
      get,
      set,
    } as unknown as Redis);

    await expect(repository.getGlobalSlate()).resolves.toEqual(slate);
    await repository.saveGlobalSlate(slate, 600);

    expect(get).toHaveBeenCalledWith('reels:recommended:global');
    expect(set).toHaveBeenCalledWith(
      'reels:recommended:global',
      JSON.stringify(slate),
      'EX',
      600,
    );
  });

  it('uses MGET and restores BigInt and Date reel fields', async () => {
    const raw = JSON.stringify({
      ...reel(),
      viewCount: { __recommendationBigInt: '42' },
    });
    const mget = jest.fn().mockResolvedValue([raw, null]);
    const repository = new RedisRecommendationFeedCacheRepository({
      mget,
    } as unknown as Redis);

    const result = await repository.getReels(['reel-1', 'reel-2']);

    expect(mget).toHaveBeenCalledWith(
      'reel:entity:reel-1',
      'reel:entity:reel-2',
    );
    expect(result).toHaveLength(1);
    expect(result[0].viewCount).toBe(42n);
    expect(result[0].createdAt).toBeInstanceOf(Date);
    expect(result[0].updatedAt).toBeInstanceOf(Date);
    expect(result[0].processingCompletedAt).toBeInstanceOf(Date);
  });

  it('pipelines eligible reel entities with an expiry and invalidates by key', async () => {
    const evalCommand = jest.fn();
    const exec = jest.fn().mockResolvedValue([[null, 1]]);
    const repository = new RedisRecommendationFeedCacheRepository({
      pipeline: jest.fn().mockReturnValue({ eval: evalCommand, exec }),
    } as unknown as Redis);

    await repository.saveReels([reel()], 3 * 60 * 60);
    await repository.invalidateReels(['reel-1']);

    expect(evalCommand).toHaveBeenCalledTimes(2);
    expect(evalCommand.mock.calls[0][0]).toContain('currentVersion');
    expect(evalCommand.mock.calls[0]).toEqual([
      expect.any(String),
      1,
      'reel:entity:reel-1',
      expect.stringContaining('__recommendationBigInt'),
      3 * 60 * 60,
      reel().updatedAt.getTime(),
    ]);
    expect(evalCommand.mock.calls[1]).toEqual([
      expect.any(String),
      1,
      'reel:entity:reel-1',
      3 * 60 * 60,
    ]);
    expect(exec).toHaveBeenCalledTimes(2);
  });

  it('does not serve a stale reel after Redis invalidation fails', async () => {
    const evalCommand = jest.fn();
    const exec = jest.fn().mockRejectedValue(new Error('redis eval failed'));
    const mget = jest.fn().mockResolvedValue([
      JSON.stringify({
        ...reel(),
        viewCount: { __recommendationBigInt: '42' },
      }),
    ]);
    const repository = new RedisRecommendationFeedCacheRepository({
      pipeline: jest.fn().mockReturnValue({ eval: evalCommand, exec }),
      mget,
    } as unknown as Redis);

    await repository.invalidateReels(['reel-1']);

    await expect(repository.getReels(['reel-1'])).resolves.toEqual([]);
    expect(mget).toHaveBeenCalledWith('reel:entity:reel-1');
  });

  it('fences a stale fill racing invalidation while allowing a later post-mutation fill', async () => {
    const store = fencedRedis();
    const reader = new RedisRecommendationFeedCacheRepository(store.redis);
    const mutator = new RedisRecommendationFeedCacheRepository(store.redis);

    const staleSave = reader.saveReels([reel()], 3 * 60 * 60);
    await new Promise<void>((resolve) => setImmediate(resolve));

    const invalidation = mutator.invalidateReels(['reel-1']);
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(store.pendingExecutions).toHaveLength(2);

    store.resolveExecution(1);
    await invalidation;
    store.resolveExecution(0);
    await staleSave;

    await expect(reader.getReels(['reel-1'])).resolves.toEqual([]);

    const postMutation = {
      ...reel(),
      updatedAt: new Date('2026-09-19T11:00:00.000Z'),
    };
    const postMutationSave = mutator.saveReels([postMutation], 3 * 60 * 60);
    await new Promise<void>((resolve) => setImmediate(resolve));
    store.resolveExecution(2);
    await postMutationSave;

    await expect(mutator.getReels(['reel-1'])).resolves.toEqual([postMutation]);
  });
});
