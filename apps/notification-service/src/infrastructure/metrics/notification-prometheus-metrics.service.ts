import { Injectable, OnModuleDestroy } from '@nestjs/common';
import { NotificationBacklogSnapshot } from '../../domain/interfaces/notification-job.repository.interface';
import { monitorEventLoopDelay } from 'node:perf_hooks';

export type ApnsRequestOutcome =
  | 'success'
  | 'http_error'
  | 'timeout'
  | 'transport_error';
export type RetrySchedulerOutcome =
  | 'success'
  | 'database_unavailable'
  | 'error'
  | 'overlap';

@Injectable()
export class NotificationPrometheusMetricsService implements OnModuleDestroy {
  static readonly CONTENT_TYPE = 'text/plain; version=0.0.4; charset=utf-8';

  private readonly serviceName = 'notification-service';
  private readonly apnsOutcomes: ApnsRequestOutcome[] = [
    'success',
    'http_error',
    'timeout',
    'transport_error',
  ];
  private readonly schedulerOutcomes: RetrySchedulerOutcome[] = [
    'success',
    'database_unavailable',
    'error',
    'overlap',
  ];
  private readonly eventLoopDelay = monitorEventLoopDelay({ resolution: 20 });
  private readonly apnsRequestCounts = new Map<ApnsRequestOutcome, number>();
  private readonly schedulerRunCounts = new Map<
    RetrySchedulerOutcome,
    number
  >();
  private readonly startedAtSeconds = Date.now() / 1_000;
  private retryJobsAttempted = 0;
  private retryJobsFailed = 0;
  private databaseUp = 1;
  private backlog?: NotificationBacklogSnapshot;
  private backlogSampleUp = 0;
  private lastBacklogSampleSeconds = 0;
  private databaseActive = 0;
  private databaseWaiting = 0;
  private databaseWaitCount = 0;
  private databaseWaitSum = 0;
  private readonly databaseWaitBounds = [
    0.001, 0.01, 0.05, 0.1, 0.25, 0.5, 1, 2, 5, 10,
  ];
  private readonly databaseWaitBuckets = this.databaseWaitBounds.map(() => 0);
  private lastSchedulerCompletionTimestampSeconds = Date.now() / 1_000;

  constructor() {
    this.eventLoopDelay.enable();
  }

  onModuleDestroy() {
    this.eventLoopDelay.disable();
  }

  recordApnsRequest(outcome: ApnsRequestOutcome) {
    this.apnsRequestCounts.set(
      outcome,
      (this.apnsRequestCounts.get(outcome) ?? 0) + 1,
    );
  }

  recordRetrySchedulerRun(outcome: RetrySchedulerOutcome) {
    this.schedulerRunCounts.set(
      outcome,
      (this.schedulerRunCounts.get(outcome) ?? 0) + 1,
    );
  }

  recordRetryJobs(attempted: number, failed: number) {
    if (
      !Number.isSafeInteger(attempted) ||
      attempted < 0 ||
      !Number.isSafeInteger(failed) ||
      failed < 0 ||
      failed > attempted
    )
      return;
    this.retryJobsAttempted += attempted;
    this.retryJobsFailed += failed;
  }

  recordRetrySchedulerCompletion() {
    this.lastSchedulerCompletionTimestampSeconds = Date.now() / 1_000;
  }

  setDatabaseAvailability(available: boolean) {
    this.databaseUp = available ? 1 : 0;
  }

  recordBacklog(snapshot: NotificationBacklogSnapshot) {
    this.backlog = snapshot;
    this.backlogSampleUp = 1;
    this.lastBacklogSampleSeconds = Date.now() / 1_000;
  }

  setBacklogSampleAvailability(available: boolean) {
    this.backlogSampleUp = available ? 1 : 0;
  }

  recordDatabaseQueue(active: number, waiting: number) {
    this.databaseActive = active;
    this.databaseWaiting = waiting;
  }

  recordDatabaseWait(seconds: number) {
    if (!Number.isFinite(seconds) || seconds < 0) return;
    this.databaseWaitCount++;
    this.databaseWaitSum += seconds;
    this.databaseWaitBounds.forEach((bound, index) => {
      if (seconds <= bound) this.databaseWaitBuckets[index]++;
    });
  }

  metrics(): string {
    const lines: string[] = [];
    const labels = this.labels({ service: this.serviceName });
    const cpu = process.cpuUsage();
    const memory = process.memoryUsage();

    this.metricHeader(
      lines,
      'velora_process_cpu_user_seconds_total',
      'Total user CPU time consumed by the process in seconds.',
      'counter',
    );
    lines.push(
      `velora_process_cpu_user_seconds_total${labels} ${cpu.user / 1_000_000}`,
    );

    this.metricHeader(
      lines,
      'velora_process_cpu_system_seconds_total',
      'Total system CPU time consumed by the process in seconds.',
      'counter',
    );
    lines.push(
      `velora_process_cpu_system_seconds_total${labels} ${cpu.system / 1_000_000}`,
    );

    this.metricHeader(
      lines,
      'velora_process_resident_memory_bytes',
      'Resident set size of the process in bytes.',
      'gauge',
    );
    lines.push(`velora_process_resident_memory_bytes${labels} ${memory.rss}`);

    this.metricHeader(
      lines,
      'velora_process_heap_used_bytes',
      'Used V8 heap size of the process in bytes.',
      'gauge',
    );
    lines.push(`velora_process_heap_used_bytes${labels} ${memory.heapUsed}`);

    this.metricHeader(
      lines,
      'velora_process_uptime_seconds',
      'Process uptime in seconds.',
      'gauge',
    );
    lines.push(`velora_process_uptime_seconds${labels} ${process.uptime()}`);

    this.metricHeader(
      lines,
      'velora_process_start_time_seconds',
      'Unix timestamp when the process started.',
      'gauge',
    );
    lines.push(
      `velora_process_start_time_seconds${labels} ${this.startedAtSeconds}`,
    );

    this.metricHeader(
      lines,
      'velora_nodejs_event_loop_lag_p99_seconds',
      'p99 Node.js event-loop delay observed since the previous metrics scrape in seconds.',
      'gauge',
    );
    lines.push(
      `velora_nodejs_event_loop_lag_p99_seconds${labels} ${this.nanosecondsToSeconds(
        this.eventLoopDelay.percentile(99),
      )}`,
    );

    this.metricHeader(
      lines,
      'velora_notification_apns_requests_total',
      'Total APNs VoIP delivery attempts by normalized outcome.',
      'counter',
    );
    for (const outcome of this.apnsOutcomes) {
      lines.push(
        `velora_notification_apns_requests_total${this.labels({ service: this.serviceName, outcome })} ${this.apnsRequestCounts.get(outcome) ?? 0}`,
      );
    }

    this.metricHeader(
      lines,
      'velora_notification_retry_scheduler_runs_total',
      'Total notification retry scheduler runs by normalized outcome.',
      'counter',
    );
    for (const outcome of this.schedulerOutcomes) {
      lines.push(
        `velora_notification_retry_scheduler_runs_total${this.labels({ service: this.serviceName, outcome })} ${this.schedulerRunCounts.get(outcome) ?? 0}`,
      );
    }

    this.metricHeader(
      lines,
      'velora_notification_retry_jobs_total',
      'Notification jobs retried by bounded outcome.',
      'counter',
    );
    lines.push(
      `velora_notification_retry_jobs_total${this.labels({ service: this.serviceName, outcome: 'attempted' })} ${this.retryJobsAttempted}`,
    );
    lines.push(
      `velora_notification_retry_jobs_total${this.labels({ service: this.serviceName, outcome: 'failed' })} ${this.retryJobsFailed}`,
    );

    this.metricHeader(
      lines,
      'velora_notification_retry_scheduler_last_completion_timestamp_seconds',
      'Unix timestamp of the last retry scheduler run that completed a database query.',
      'gauge',
    );
    lines.push(
      `velora_notification_retry_scheduler_last_completion_timestamp_seconds${labels} ${this.lastSchedulerCompletionTimestampSeconds}`,
    );

    this.metricHeader(
      lines,
      'velora_notification_database_up',
      'Whether the notification retry scheduler can reach its database.',
      'gauge',
    );
    lines.push(`velora_notification_database_up${labels} ${this.databaseUp}`);

    this.metricHeader(
      lines,
      'velora_notification_backlog_sample_up',
      'Whether the last unfinished-job snapshot succeeded; retained gauges may be stale on failure.',
      'gauge',
    );
    lines.push(
      `velora_notification_backlog_sample_up${labels} ${this.backlogSampleUp}`,
    );
    this.metricHeader(
      lines,
      'velora_notification_backlog_last_sample_timestamp_seconds',
      'Unix timestamp of the last successful unfinished-job snapshot.',
      'gauge',
    );
    lines.push(
      `velora_notification_backlog_last_sample_timestamp_seconds${labels} ${this.lastBacklogSampleSeconds}`,
    );
    // No artificial empty backlog before the first successful query.
    if (this.backlog) {
      this.metricHeader(
        lines,
        'velora_notification_jobs_outstanding',
        'Unexpired unfinished jobs by status, including active leases and future backoff, not just due jobs.',
        'gauge',
      );
      for (const status of ['pending', 'processing', 'failed'] as const) {
        lines.push(
          `velora_notification_jobs_outstanding${this.labels({ service: this.serviceName, status })} ${this.backlog.counts[status]}`,
        );
      }
      this.metricHeader(
        lines,
        'velora_notification_oldest_outstanding_age_seconds',
        'Age since creation of the oldest job in the last successful unfinished-job snapshot; zero for an empty snapshot.',
        'gauge',
      );
      const age = this.backlog.oldestCreatedAt
        ? Math.max(
            0,
            (Date.now() - this.backlog.oldestCreatedAt.getTime()) / 1_000,
          )
        : 0;
      lines.push(
        `velora_notification_oldest_outstanding_age_seconds${labels} ${age}`,
      );
    }
    this.metricHeader(
      lines,
      'velora_notification_database_gate_active',
      'Prisma operations admitted by the existing gate, not the number of PostgreSQL connections.',
      'gauge',
    );
    lines.push(
      `velora_notification_database_gate_active${labels} ${this.databaseActive}`,
    );
    this.metricHeader(
      lines,
      'velora_notification_database_gate_waiting',
      'Prisma operations waiting outside the connection pool in the existing gate.',
      'gauge',
    );
    lines.push(
      `velora_notification_database_gate_waiting${labels} ${this.databaseWaiting}`,
    );
    const wait = 'velora_notification_database_gate_wait_seconds';
    this.metricHeader(
      lines,
      wait,
      'Time before admission by the application database gate, including zero-wait admissions; not SQL execution or internal pool wait.',
      'histogram',
    );
    this.databaseWaitBounds.forEach((bound, index) => {
      lines.push(
        `${wait}_bucket${this.labels({ service: this.serviceName, le: String(bound) })} ${this.databaseWaitBuckets[index]}`,
      );
    });
    lines.push(
      `${wait}_bucket${this.labels({ service: this.serviceName, le: '+Inf' })} ${this.databaseWaitCount}`,
    );
    lines.push(`${wait}_count${labels} ${this.databaseWaitCount}`);
    lines.push(`${wait}_sum${labels} ${this.databaseWaitSum}`);

    this.eventLoopDelay.reset();
    return `${lines.join('\n')}\n`;
  }

  private metricHeader(
    lines: string[],
    name: string,
    help: string,
    type: 'counter' | 'gauge' | 'histogram',
  ) {
    lines.push(`# HELP ${name} ${help}`);
    lines.push(`# TYPE ${name} ${type}`);
  }

  private labels(values: Record<string, string>) {
    const body = Object.entries(values)
      .map(([name, value]) => `${name}="${this.escapeLabel(value)}"`)
      .join(',');
    return `{${body}}`;
  }

  private escapeLabel(value: string) {
    return value
      .replace(/\\/g, '\\\\')
      .replace(/\n/g, '\\n')
      .replace(/"/g, '\\"');
  }

  private nanosecondsToSeconds(value: number) {
    return Number.isFinite(value) ? value / 1_000_000_000 : 0;
  }
}
