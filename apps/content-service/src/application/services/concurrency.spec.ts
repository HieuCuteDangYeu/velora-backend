import {
  ConcurrencyGate,
  readBoundedIntEnv,
  settleWithConcurrency,
} from './concurrency';

const tick = () => new Promise<void>((resolve) => setImmediate(resolve));

describe('settleWithConcurrency', () => {
  it('never runs more than the limit at once and keeps result order', async () => {
    let active = 0;
    let peak = 0;
    const results = await settleWithConcurrency(
      [1, 2, 3, 4, 5],
      2,
      async (n) => {
        active += 1;
        peak = Math.max(peak, active);
        await tick();
        active -= 1;
        if (n === 3) throw new Error('boom');
        return n * 10;
      },
    );

    expect(peak).toBe(2);
    expect(results.map((r) => r.status)).toEqual([
      'fulfilled',
      'fulfilled',
      'rejected',
      'fulfilled',
      'fulfilled',
    ]);
    expect((results[4] as PromiseFulfilledResult<number>).value).toBe(50);
  });

  it('handles an empty list', async () => {
    await expect(
      settleWithConcurrency([], 3, () => Promise.resolve(1)),
    ).resolves.toEqual([]);
  });
});

describe('ConcurrencyGate', () => {
  it('queues past the active limit and hands slots over in order', async () => {
    const gate = new ConcurrencyGate(1, 2);
    const first = await gate.acquire();
    const order: string[] = [];
    const second = gate.acquire().then((release) => {
      order.push('second');
      return release;
    });
    const third = gate.acquire().then((release) => {
      order.push('third');
      return release;
    });
    await tick();
    expect(order).toEqual([]);
    expect(gate.queued).toBe(2);

    first!();
    (await second)!();
    (await third)!();
    expect(order).toEqual(['second', 'third']);
    expect(gate.queued).toBe(0);
  });

  it('returns null when the queue is full and tolerates double release', async () => {
    const gate = new ConcurrencyGate(1, 0);
    const release = await gate.acquire();
    await expect(gate.acquire()).resolves.toBeNull();
    release!();
    release!();
    const again = await gate.acquire();
    expect(again).not.toBeNull();
    await expect(gate.acquire()).resolves.toBeNull();
  });
});

describe('readBoundedIntEnv', () => {
  it('falls back for missing or invalid values and clamps to max', () => {
    expect(readBoundedIntEnv('X', 2, 4, {})).toBe(2);
    expect(readBoundedIntEnv('X', 2, 4, { X: 'abc' })).toBe(2);
    expect(readBoundedIntEnv('X', 2, 4, { X: '0' })).toBe(2);
    expect(readBoundedIntEnv('X', 2, 4, { X: '3' })).toBe(3);
    expect(readBoundedIntEnv('X', 2, 4, { X: '99' })).toBe(4);
  });
});
