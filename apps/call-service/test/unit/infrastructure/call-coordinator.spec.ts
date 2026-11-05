import type Redis from 'ioredis';
import {
  CallCoordinator,
  CallLockTimeoutError,
  InProcessCallCoordinator,
  RedisCallCoordinator,
} from '../../../src/infrastructure/runtime/call-coordinator';
import {
  redisServerAvailable,
  startTemporaryRedis,
  type TemporaryRedis,
} from '../../support/temporary-redis';

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Records how many tasks for one key overlap at any moment. */
async function maxOverlap(
  coordinators: CallCoordinator[],
  tasksPerCoordinator: number,
): Promise<number> {
  let running = 0;
  let max = 0;
  await Promise.all(
    coordinators.flatMap((coordinator) =>
      Array.from({ length: tasksPerCoordinator }, () =>
        coordinator.runExclusive('participant:call-1:user-1', async () => {
          running++;
          max = Math.max(max, running);
          await sleep(5);
          running--;
        }),
      ),
    ),
  );
  return max;
}

describe('InProcessCallCoordinator', () => {
  it('serializes tasks per key and keeps going after a failure', async () => {
    const coordinator = new InProcessCallCoordinator();
    const failing = coordinator.runExclusive('k', () =>
      Promise.reject(new Error('boom')),
    );
    const next = coordinator.runExclusive('k', () => Promise.resolve('ok'));
    await expect(failing).rejects.toThrow('boom');
    await expect(next).resolves.toBe('ok');
    expect(await maxOverlap([coordinator], 5)).toBe(1);
  });

  it('expires hashes and always grants ticks', async () => {
    const coordinator = new InProcessCallCoordinator();
    await coordinator.hashSet('h', 'a', '1', 20);
    expect(await coordinator.hashGetAll('h')).toEqual({ a: '1' });
    await sleep(30);
    expect(await coordinator.hashGet('h', 'a')).toBeNull();
    expect(await coordinator.claimTick()).toBe(true);
  });
});

(redisServerAvailable ? describe : describe.skip)(
  'RedisCallCoordinator (real Redis)',
  () => {
    let temporary: TemporaryRedis;
    let redis: Redis;

    beforeAll(async () => {
      temporary = await startTemporaryRedis();
      redis = await temporary.client();
    });

    beforeEach(() => redis.flushall());
    afterAll(() => temporary?.stop());

    it('never overlaps the same key across two replicas', async () => {
      const replicas = [
        new RedisCallCoordinator(await temporary.client()),
        new RedisCallCoordinator(await temporary.client()),
      ];
      expect(await maxOverlap(replicas, 6)).toBe(1);
      expect(await redis.keys('call:lock:*')).toEqual([]);
    });

    it('releases the lock when the task throws', async () => {
      const coordinator = new RedisCallCoordinator(redis);
      await expect(
        coordinator.runExclusive('k', () => Promise.reject(new Error('x'))),
      ).rejects.toThrow('x');
      await expect(
        coordinator.runExclusive('k', () => Promise.resolve(1)),
      ).resolves.toBe(1);
    });

    it('keeps a long task locked by renewing it', async () => {
      const a = new RedisCallCoordinator(await temporary.client(), {
        lockTtlMs: 600,
        lockWaitMs: 100,
      });
      const b = new RedisCallCoordinator(await temporary.client(), {
        lockTtlMs: 600,
        lockWaitMs: 100,
      });
      const long = a.runExclusive('k', () => sleep(1_000));
      await sleep(700);
      await expect(
        b.runExclusive('k', () => Promise.resolve()),
      ).rejects.toBeInstanceOf(CallLockTimeoutError);
      await long;
    });

    it('gives one tick to one replica per window', async () => {
      const a = new RedisCallCoordinator(await temporary.client());
      const b = new RedisCallCoordinator(await temporary.client());
      const claims = await Promise.all([
        a.claimTick('sweep', 200),
        b.claimTick('sweep', 200),
      ]);
      expect(claims.filter(Boolean)).toHaveLength(1);
      await sleep(250);
      expect(await b.claimTick('sweep', 200)).toBe(true);
    });

    it('stores hash fields with a time to live', async () => {
      const coordinator = new RedisCallCoordinator(redis);
      await coordinator.hashSet('call:c:media-ui', 'mic:u', '{"x":1}', 10_000);
      expect(await coordinator.hashGet('call:c:media-ui', 'mic:u')).toBe(
        '{"x":1}',
      );
      expect(await redis.pttl('call:c:media-ui')).toBeGreaterThan(0);
      await coordinator.hashDelete('call:c:media-ui', ['mic:u']);
      expect(await coordinator.hashGetAll('call:c:media-ui')).toEqual({});
    });
  },
);
