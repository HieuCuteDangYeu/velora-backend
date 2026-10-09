import {
  Injectable,
  Inject,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';

import { INotificationJobRepository } from '../../domain/interfaces/notification-job.repository.interface';
import { RetryNotificationJobsUseCase } from '../../application/use-cases/retry-notification-jobs.use-case';
import { NotificationPrometheusMetricsService } from '../metrics/notification-prometheus-metrics.service';

const DEFAULT_RETRY_POLL_INTERVAL_MS = 3_000;
const MIN_RETRY_POLL_INTERVAL_MS = 1_000;
const MAX_RETRY_POLL_INTERVAL_MS = 60_000;
const DATABASE_OUTAGE_CODES = new Set(['P1001', 'P1002', 'P1008', 'P1017']);

@Injectable()
export class NotificationRetryScheduler
  implements OnModuleInit, OnModuleDestroy
{
  private readonly logger = new Logger(NotificationRetryScheduler.name);
  private interval?: NodeJS.Timeout;
  private isRunning = false;
  private databaseUnavailable = false;
  private lastBacklogSampleAt = -Infinity;

  constructor(
    private readonly retryNotificationJobs: RetryNotificationJobsUseCase,
    private readonly metrics: NotificationPrometheusMetricsService,
    @Inject('INotificationJobRepository')
    private readonly jobs: INotificationJobRepository,
  ) {}

  onModuleInit() {
    this.interval = setInterval(() => {
      void this.handleRetries();
    }, this.getPollIntervalMs());
  }

  onModuleDestroy() {
    if (this.interval) {
      clearInterval(this.interval);
    }
  }

  async handleRetries() {
    if (this.isRunning) {
      this.metrics.recordRetrySchedulerRun('overlap');
      return;
    }

    this.isRunning = true;
    try {
      const result = {
        attemptedCount: 0,
        failures: [] as Awaited<
          ReturnType<RetryNotificationJobsUseCase['execute']>
        >['failures'],
      };
      // Drain a bounded backlog without adding a three-second pause after
      // every full batch. isRunning still prevents overlapping polls.
      for (let batch = 0; batch < 5; batch++) {
        const next = await this.retryNotificationJobs.execute(20);
        result.attemptedCount += next.attemptedCount;
        result.failures.push(...next.failures);
        if (next.attemptedCount < 20 || next.failures.length > 0) break;
      }

      if (this.databaseUnavailable) {
        this.databaseUnavailable = false;
        this.logger.log(
          'Notification retry scheduler database connection recovered',
        );
      }
      this.metrics.setDatabaseAvailability(true);
      this.metrics.recordRetrySchedulerRun('success');
      this.metrics.recordRetrySchedulerCompletion();
      this.metrics.recordRetryJobs(
        result.attemptedCount,
        result.failures.length,
      );

      await this.sampleBacklog();

      if (result.attemptedCount === 0) {
        return;
      }

      this.logger.log(`Retried ${result.attemptedCount} notification job(s)`);

      for (const failure of result.failures) {
        this.logger.error(
          `Failed to retry notification job ${failure.jobId}: ${this.errorCode(failure.error)}`,
        );
      }
    } catch (error) {
      if (this.isDatabaseOutage(error)) {
        this.metrics.setDatabaseAvailability(false);
        this.metrics.recordRetrySchedulerRun('database_unavailable');
        if (!this.databaseUnavailable) {
          this.databaseUnavailable = true;
          this.logger.error(
            `Notification retry scheduler database unavailable: ${this.errorCode(error)}`,
          );
        }
        return;
      }

      this.metrics.recordRetrySchedulerRun('error');
      this.logger.error(
        `Notification retry scheduler failed: ${this.errorCode(error)}`,
      );
    } finally {
      this.isRunning = false;
    }
  }

  private async sampleBacklog() {
    const now = Date.now();
    if (now - this.lastBacklogSampleAt < 10_000) return;
    // Attempt timestamp also bounds retries after a failed sample. Sampling is
    // inside the non-overlapping poll, after delivery has yielded its DB slots.
    this.lastBacklogSampleAt = now;
    try {
      this.metrics.recordBacklog(await this.jobs.readBacklog());
    } catch {
      // Retain the last good gauges. Observability failure must not turn a
      // completed delivery poll into a failed one or emit private DB errors.
      this.metrics.setBacklogSampleAvailability(false);
    }
  }

  private getPollIntervalMs() {
    const configured = process.env.NOTIFICATION_RETRY_POLL_INTERVAL_MS;
    if (configured === undefined || configured === '') {
      return DEFAULT_RETRY_POLL_INTERVAL_MS;
    }

    const intervalMs = Number(configured);
    if (
      !Number.isInteger(intervalMs) ||
      intervalMs < MIN_RETRY_POLL_INTERVAL_MS ||
      intervalMs > MAX_RETRY_POLL_INTERVAL_MS
    ) {
      this.logger.warn(
        `Invalid NOTIFICATION_RETRY_POLL_INTERVAL_MS; using ${DEFAULT_RETRY_POLL_INTERVAL_MS}ms`,
      );
      return DEFAULT_RETRY_POLL_INTERVAL_MS;
    }

    return intervalMs;
  }

  private isDatabaseOutage(error: unknown) {
    return DATABASE_OUTAGE_CODES.has(this.errorCode(error));
  }

  private errorCode(error: unknown) {
    if (
      error &&
      typeof error === 'object' &&
      'code' in error &&
      typeof error.code === 'string'
    ) {
      return DATABASE_OUTAGE_CODES.has(error.code)
        ? error.code
        : 'provider_error';
    }

    return 'unknown';
  }
}
