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
const RETRY_BATCH_SIZE = 100;
// One poll keeps draining while batches come back full, for at most this long.
// It must stay well under the 60 s of VeloraNotificationRetrySchedulerStalled,
// which watches the time since a poll last completed.
const MAX_DRAIN_MS = 20_000;
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
      // Message notifications are only queued at intake; this poll is what
      // delivers them. A fixed five batches of 20 per three-second poll capped
      // delivery at 33 jobs a second whatever the database could do, so drain
      // for as long as batches come back full, within a time budget. A failed
      // batch still ends the poll, so a DB or provider outage does not spin,
      // and isRunning still prevents overlapping polls.
      const drainStartedAt = Date.now();
      do {
        const next = await this.retryNotificationJobs.execute(RETRY_BATCH_SIZE);
        result.attemptedCount += next.attemptedCount;
        result.failures.push(...next.failures);
        if (next.attemptedCount < RETRY_BATCH_SIZE || next.failures.length > 0)
          break;
      } while (Date.now() - drainStartedAt < MAX_DRAIN_MS);

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
