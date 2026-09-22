import { Injectable, OnModuleDestroy } from '@nestjs/common';
import { monitorEventLoopDelay } from 'node:perf_hooks';
import { PrismaService } from '../prisma/prisma.service';

export type UserOperation =
  | 'create'
  | 'find_all'
  | 'update'
  | 'delete'
  | 'validate'
  | 'verify'
  | 'find_by_email'
  | 'create_social'
  | 'avatar_update'
  | 'find_by_id'
  | 'find_by_ids'
  | 'public_profile'
  | 'search'
  | 'recommendations'
  | 'username_availability'
  | 'validate_list';

export type UserOutcome = 'success' | 'rejected' | 'error';
type HistogramState = { bucketCounts: number[]; count: number; sum: number };

@Injectable()
export class UserPrometheusMetricsService implements OnModuleDestroy {
  static readonly CONTENT_TYPE = 'text/plain; version=0.0.4; charset=utf-8';

  private readonly serviceName = 'user-service';
  private readonly durationBuckets = [
    0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2, 5,
  ];
  private readonly requestCounts = new Map<string, number>();
  private readonly requestDurations = new Map<string, HistogramState>();
  private readonly storageCounts = new Map<'success' | 'error', number>();
  private recommendationCandidates = 0;
  private readonly eventLoopDelay = monitorEventLoopDelay({ resolution: 20 });

  constructor(private readonly prisma: PrismaService) {
    this.eventLoopDelay.enable();
  }

  onModuleDestroy(): void {
    this.eventLoopDelay.disable();
  }

  recordRequest(
    operation: UserOperation,
    outcome: UserOutcome,
    durationSeconds: number,
  ): void {
    const key = `${operation}|${outcome}`;
    this.requestCounts.set(key, (this.requestCounts.get(key) ?? 0) + 1);
    this.observe(key, durationSeconds);
  }

  recordStorage(outcome: 'success' | 'error'): void {
    this.storageCounts.set(outcome, (this.storageCounts.get(outcome) ?? 0) + 1);
  }

  recordRecommendationCandidates(count: number): void {
    this.recommendationCandidates += Math.max(0, Math.trunc(count));
  }

  async metrics(): Promise<string> {
    const database = await Promise.allSettled([this.prisma.$queryRaw`SELECT 1`]);
    const lines: string[] = [];
    const labels = this.labels({ service: this.serviceName });
    const cpu = process.cpuUsage();
    const memory = process.memoryUsage();

    this.metric(
      lines,
      'velora_process_cpu_user_seconds_total',
      'Total user CPU time consumed by the process in seconds.',
      cpu.user / 1_000_000,
      labels,
      'counter',
    );
    this.metric(
      lines,
      'velora_process_cpu_system_seconds_total',
      'Total system CPU time consumed by the process in seconds.',
      cpu.system / 1_000_000,
      labels,
      'counter',
    );
    this.metric(
      lines,
      'velora_process_resident_memory_bytes',
      'Resident set size of the process in bytes.',
      memory.rss,
      labels,
    );
    this.metric(
      lines,
      'velora_process_heap_used_bytes',
      'Used V8 heap size of the process in bytes.',
      memory.heapUsed,
      labels,
    );
    this.metric(
      lines,
      'velora_process_uptime_seconds',
      'Process uptime in seconds.',
      process.uptime(),
      labels,
    );
    this.metric(
      lines,
      'velora_nodejs_event_loop_lag_p99_seconds',
      'p99 Node.js event-loop delay observed since the previous metrics scrape in seconds.',
      this.nanosecondsToSeconds(this.eventLoopDelay.percentile(99)),
      labels,
    );
    this.metric(
      lines,
      'velora_user_database_up',
      'Whether User PostgreSQL is reachable.',
      database[0].status === 'fulfilled' ? 1 : 0,
      labels,
    );

    this.header(
      lines,
      'velora_user_requests_total',
      'User RPC requests by bounded operation and outcome.',
      'counter',
    );
    for (const [key, count] of this.requestCounts) {
      const [operation, outcome] = key.split('|');
      lines.push(
        `velora_user_requests_total${this.labels({ service: this.serviceName, operation, outcome })} ${count}`,
      );
    }

    this.header(
      lines,
      'velora_user_request_duration_seconds',
      'User RPC handling duration by bounded operation and outcome.',
      'histogram',
    );
    for (const [key, state] of this.requestDurations) {
      const [operation, outcome] = key.split('|');
      const baseLabels = { service: this.serviceName, operation, outcome };
      this.durationBuckets.forEach((bucket, index) => {
        lines.push(
          `velora_user_request_duration_seconds_bucket${this.labels({ ...baseLabels, le: String(bucket) })} ${state.bucketCounts[index]}`,
        );
      });
      lines.push(
        `velora_user_request_duration_seconds_bucket${this.labels({ ...baseLabels, le: '+Inf' })} ${state.count}`,
      );
      lines.push(
        `velora_user_request_duration_seconds_sum${this.labels(baseLabels)} ${state.sum}`,
      );
      lines.push(
        `velora_user_request_duration_seconds_count${this.labels(baseLabels)} ${state.count}`,
      );
    }

    this.header(
      lines,
      'velora_user_storage_operations_total',
      'Avatar storage existence checks by outcome.',
      'counter',
    );
    for (const outcome of ['success', 'error'] as const) {
      lines.push(
        `velora_user_storage_operations_total${this.labels({ service: this.serviceName, operation: 'avatar_check', outcome })} ${this.storageCounts.get(outcome) ?? 0}`,
      );
    }
    this.metric(
      lines,
      'velora_user_recommendation_candidates_total',
      'Total user recommendation candidates returned to callers.',
      this.recommendationCandidates,
      labels,
      'counter',
    );

    this.eventLoopDelay.reset();
    return `${lines.join('\n')}\n`;
  }

  private observe(key: string, durationSeconds: number): void {
    const duration =
      Number.isFinite(durationSeconds) && durationSeconds >= 0
        ? durationSeconds
        : 0;
    const state = this.requestDurations.get(key) ?? {
      bucketCounts: this.durationBuckets.map(() => 0),
      count: 0,
      sum: 0,
    };
    state.count += 1;
    state.sum += duration;
    this.durationBuckets.forEach((bucket, index) => {
      if (duration <= bucket) state.bucketCounts[index] += 1;
    });
    this.requestDurations.set(key, state);
  }

  private metric(
    lines: string[],
    name: string,
    help: string,
    value: number,
    labels: string,
    type: 'gauge' | 'counter' = 'gauge',
  ): void {
    this.header(lines, name, help, type);
    lines.push(`${name}${labels} ${value}`);
  }

  private header(
    lines: string[],
    name: string,
    help: string,
    type: 'counter' | 'gauge' | 'histogram',
  ): void {
    lines.push(`# HELP ${name} ${help}`);
    lines.push(`# TYPE ${name} ${type}`);
  }

  private labels(values: Record<string, string>): string {
    return `{${Object.entries(values)
      .map(([name, value]) => `${name}="${this.escapeLabel(value)}"`)
      .join(',')}}`;
  }

  private escapeLabel(value: string): string {
    return value
      .replace(/\\/g, '\\\\')
      .replace(/\n/g, '\\n')
      .replace(/"/g, '\\"');
  }

  private nanosecondsToSeconds(value: number): number {
    return Number.isFinite(value) ? value / 1_000_000_000 : 0;
  }
}
