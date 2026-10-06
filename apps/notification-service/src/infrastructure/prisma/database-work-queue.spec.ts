import { ServiceUnavailableException } from '@nestjs/common';
import { DatabaseWorkQueue } from './database-work-queue';

describe('DatabaseWorkQueue', () => {
  it('bounds concurrency, preserves FIFO and releases slots after failures', async () => {
    const queue = new DatabaseWorkQueue(2);
    const starts: number[] = [];
    const finish: Array<(value: number) => void> = [];
    const first = queue.run(
      () =>
        new Promise<number>((resolve) => {
          starts.push(1);
          finish.push(resolve);
        }),
    );
    const second = queue.run(
      () =>
        new Promise<number>((resolve) => {
          starts.push(2);
          finish.push(resolve);
        }),
    );
    const third = queue.run(() => {
      starts.push(3);
      throw new Error('DB unavailable');
    });
    const failed = expect(third).rejects.toThrow('DB unavailable');
    const fourth = queue.run(() => {
      starts.push(4);
      return Promise.resolve(4);
    });
    expect(starts).toEqual([1, 2]);
    finish[0](1);
    await failed;
    await expect(fourth).resolves.toBe(4);
    expect(starts).toEqual([1, 2, 3, 4]);
    finish[1](2);
    await expect(first).resolves.toBe(1);
    await expect(second).resolves.toBe(2);
  });

  it('rejects overflow before executing it, without leaking the active slot', async () => {
    const queue = new DatabaseWorkQueue(1, 1);
    let finish!: () => void;
    const first = queue.run(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        }),
    );
    const second = queue.run(() => Promise.resolve('queued'));
    const overflow = jest.fn().mockResolvedValue('never');
    await expect(queue.run(overflow)).rejects.toBeInstanceOf(
      ServiceUnavailableException,
    );
    expect(overflow).not.toHaveBeenCalled();
    finish();
    await first;
    await expect(second).resolves.toBe('queued');
    await expect(queue.run(() => Promise.resolve('after drain'))).resolves.toBe(
      'after drain',
    );
  });
});
