import { JobConcurrencyLimiterService } from './job-concurrency-limiter.service';

const settle = () => new Promise<void>((resolve) => setImmediate(resolve));

describe('JobConcurrencyLimiterService priority', () => {
  it('starts waiting normal jobs before waiting low-priority jobs', async () => {
    const limiter = new JobConcurrencyLimiterService();
    const order: string[] = [];
    let release!: () => void;
    const running = limiter.runExclusive(
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
        }),
      1,
    );
    await settle();

    // The low-priority job arrives first, the encode afterwards.
    const evidence = limiter.runExclusive(
      () => Promise.resolve(void order.push('evidence')),
      1,
      'LOW',
    );
    const encode = limiter.runExclusive(
      () => Promise.resolve(void order.push('encode')),
      1,
      'NORMAL',
    );
    release();
    await Promise.all([running, evidence, encode]);

    expect(order).toEqual(['encode', 'evidence']);
  });

  it('runs a low-priority job at once when nothing else is running', async () => {
    const limiter = new JobConcurrencyLimiterService();

    await expect(
      limiter.runExclusive(() => Promise.resolve('done'), 1, 'LOW'),
    ).resolves.toBe('done');
  });

  it('keeps first come first served within one priority', async () => {
    const limiter = new JobConcurrencyLimiterService();
    const order: number[] = [];
    let release!: () => void;
    const running = limiter.runExclusive(
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
        }),
      1,
    );
    await settle();
    const jobs = [1, 2, 3].map((n) =>
      limiter.runExclusive(() => Promise.resolve(void order.push(n)), 1),
    );
    release();
    await Promise.all([running, ...jobs]);

    expect(order).toEqual([1, 2, 3]);
  });
});
