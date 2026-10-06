import { ServiceUnavailableException } from '@nestjs/common';

/** Bound queries before they enter Prisma's pool, without holding a connection. */
export class DatabaseWorkQueue {
  private active = 0;
  private readonly waiting: Array<() => void> = [];

  constructor(
    private readonly concurrency: number,
    private readonly maxWaiting = 256,
  ) {}

  async run<T>(operation: () => Promise<T>): Promise<T> {
    if (this.active < this.concurrency) {
      this.active += 1;
    } else {
      if (this.waiting.length >= this.maxWaiting) {
        throw new ServiceUnavailableException(
          'Notification database queue full',
        );
      }
      await new Promise<void>((resolve) => this.waiting.push(resolve));
    }

    try {
      return await operation();
    } finally {
      const next = this.waiting.shift();
      if (next) next();
      else this.active -= 1;
    }
  }
}
