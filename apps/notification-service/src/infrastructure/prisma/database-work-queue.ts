import { performance } from 'node:perf_hooks';
import { ServiceUnavailableException } from '@nestjs/common';

/** Bound queries before they enter Prisma's pool, without holding a connection. */
export interface DatabaseQueueObserver {
  state(active: number, waiting: number): void;
  admitted(waitSeconds: number): void;
}

export class DatabaseWorkQueue {
  private active = 0;
  private readonly waiting: Array<() => void> = [];

  constructor(
    private readonly concurrency: number,
    private readonly maxWaiting = 256,
    private readonly observer?: DatabaseQueueObserver,
  ) {}

  async run<T>(operation: () => Promise<T>): Promise<T> {
    const startedAt = performance.now();
    if (this.active < this.concurrency) {
      this.active += 1;
    } else {
      if (this.waiting.length >= this.maxWaiting) {
        throw new ServiceUnavailableException(
          'Notification database queue full',
        );
      }
      await new Promise<void>((resolve) => {
        this.waiting.push(resolve);
        this.observeState();
      });
    }

    this.observeState();
    try {
      // Metrics must never affect FIFO admission or leak a database slot.
      this.observer?.admitted((performance.now() - startedAt) / 1_000);
    } catch {
      /* ignore observer failure */
    }
    try {
      return await operation();
    } finally {
      const next = this.waiting.shift();
      if (next) next();
      else this.active -= 1;
      this.observeState();
    }
  }
  private observeState() {
    try {
      this.observer?.state(this.active, this.waiting.length);
    } catch {
      /* ignore observer failure */
    }
  }
}
