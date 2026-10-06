import { Inject, Injectable } from '@nestjs/common';

import { INotificationJobRepository } from '../../domain/interfaces/notification-job.repository.interface';
import { ProcessNotificationJobUseCase } from './process-notification-job.use-case';

export type NotificationRetryFailure = {
  jobId: string;
  error: unknown;
};

@Injectable()
export class RetryNotificationJobsUseCase {
  constructor(
    @Inject('INotificationJobRepository')
    private readonly notificationJobRepository: INotificationJobRepository,
    private readonly processNotificationJob: ProcessNotificationJobUseCase,
  ) {}

  async execute(limit: number): Promise<{
    attemptedCount: number;
    failures: NotificationRetryFailure[];
  }> {
    const jobs = await this.notificationJobRepository.findRetryable(limit);
    const failures: NotificationRetryFailure[] = [];

    let index = 0;
    // Four workers for this non-overlapping poll, not one task per queued job.
    // Call event delivery remains immediate; DB operations share the pool gate.
    await Promise.all(
      Array.from({ length: Math.min(4, jobs.length) }, async () => {
        while (index < jobs.length) {
          const job = jobs[index++];
          try {
            await this.processNotificationJob.execute(job);
          } catch (error) {
            failures.push({ jobId: job.id, error });
          }
        }
      }),
    );

    return {
      attemptedCount: jobs.length,
      failures,
    };
  }
}
