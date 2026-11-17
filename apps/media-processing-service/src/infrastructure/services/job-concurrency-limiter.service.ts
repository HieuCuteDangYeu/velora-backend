import { Injectable } from '@nestjs/common';
import type {
  IJobConcurrencyLimiterService,
  JobPriority,
} from '@processing/domain/interfaces/job-concurrency-limiter.service.interface';

@Injectable()
export class JobConcurrencyLimiterService implements IJobConcurrencyLimiterService {
  private activeCount = 0;
  private readonly waiting: Record<JobPriority, Array<() => void>> = {
    NORMAL: [],
    LOW: [],
  };

  async runExclusive<T>(
    job: () => Promise<T>,
    limit: number,
    priority: JobPriority = 'NORMAL',
  ): Promise<T> {
    await this.acquire(limit, priority);

    try {
      return await job();
    } finally {
      this.release();
    }
  }

  private async acquire(limit: number, priority: JobPriority): Promise<void> {
    if (this.activeCount < limit) {
      this.activeCount += 1;
      return;
    }

    await new Promise<void>((resolve) => {
      this.waiting[priority].push(() => {
        this.activeCount += 1;
        resolve();
      });
    });
  }

  private release(): void {
    this.activeCount = Math.max(0, this.activeCount - 1);

    const next = this.waiting.NORMAL.shift() ?? this.waiting.LOW.shift();
    if (next) {
      next();
    }
  }
}
