import { Injectable, OnModuleDestroy } from '@nestjs/common';
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

    this.eventLoopDelay.reset();
    return `${lines.join('\n')}\n`;
  }

  private metricHeader(
    lines: string[],
    name: string,
    help: string,
    type: 'counter' | 'gauge',
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
