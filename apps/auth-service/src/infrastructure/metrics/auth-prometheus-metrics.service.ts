import { Inject, Injectable, OnModuleDestroy } from '@nestjs/common';
import Redis from 'ioredis';
import { monitorEventLoopDelay } from 'node:perf_hooks';
import { PrismaService } from '../prisma/prisma.service';

export type AuthOperation =
  | 'register'
  | 'login'
  | 'verify_token'
  | 'confirm_account'
  | 'resend_verification'
  | 'refresh'
  | 'logout'
  | 'login_google'
  | 'forgot_password'
  | 'reset_password'
  | 'verify_google_token';

export type AuthOutcome = 'success' | 'rejected' | 'error';
export type RefreshOutcome =
  | 'success'
  | 'recovered'
  | 'replay_detected'
  | 'invalid';

type HistogramState = { bucketCounts: number[]; count: number; sum: number };

@Injectable()
export class AuthPrometheusMetricsService implements OnModuleDestroy {
  static readonly CONTENT_TYPE = 'text/plain; version=0.0.4; charset=utf-8';

  private readonly serviceName = 'auth-service';
  private readonly durationBuckets = [
    0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2, 5,
  ];
  private readonly requestCounts = new Map<string, number>();
  private readonly requestDurations = new Map<string, HistogramState>();
  private readonly refreshCounts = new Map<RefreshOutcome, number>();
  private readonly refreshDurations = new Map<string, HistogramState>();
  private readonly cleanupCounts = new Map<'success' | 'error', number>();
  private readonly cleanupDurations = new Map<string, HistogramState>();
  private cleanupDeleted = 0;
  private cleanupLastSuccessTimestampSeconds = 0;
  private readonly eventLoopDelay = monitorEventLoopDelay({ resolution: 20 });

  constructor(
    private readonly prisma: PrismaService,
    @Inject('REDIS_CLIENT') private readonly redis: Redis,
  ) {
    this.eventLoopDelay.enable();
  }

  onModuleDestroy(): void {
    this.eventLoopDelay.disable();
  }

  recordRequest(
    operation: AuthOperation,
    outcome: AuthOutcome,
    durationSeconds: number,
  ): void {
    const key = `${operation}|${outcome}`;
    this.requestCounts.set(key, (this.requestCounts.get(key) ?? 0) + 1);
    this.observe(this.requestDurations, key, durationSeconds);
  }

  recordRefresh(outcome: RefreshOutcome, durationSeconds: number): void {
    this.refreshCounts.set(outcome, (this.refreshCounts.get(outcome) ?? 0) + 1);
    this.observe(this.refreshDurations, 'all', durationSeconds);
  }

  recordCleanup(
    outcome: 'success' | 'error',
    durationSeconds: number,
    deleted = 0,
  ): void {
    this.cleanupCounts.set(outcome, (this.cleanupCounts.get(outcome) ?? 0) + 1);
    this.observe(this.cleanupDurations, outcome, durationSeconds);
    if (outcome === 'success') {
      this.cleanupDeleted += Math.max(0, Math.trunc(deleted));
      this.cleanupLastSuccessTimestampSeconds = Date.now() / 1000;
    }
  }

  async metrics(): Promise<string> {
    const [database, redis] = await Promise.allSettled([
      this.prisma.$queryRaw`SELECT 1`,
      this.redis.ping(),
    ]);
    const lines: string[] = [];
    const labels = this.labels({ service: this.serviceName });
    const cpu = process.cpuUsage();
    const memory = process.memoryUsage();

    this.gauge(
      lines,
      'velora_process_cpu_user_seconds_total',
      'Total user CPU time consumed by the process in seconds.',
      cpu.user / 1_000_000,
      labels,
      'counter',
    );
    this.gauge(
      lines,
      'velora_process_cpu_system_seconds_total',
      'Total system CPU time consumed by the process in seconds.',
      cpu.system / 1_000_000,
      labels,
      'counter',
    );
    this.gauge(
      lines,
      'velora_process_resident_memory_bytes',
      'Resident set size of the process in bytes.',
      memory.rss,
      labels,
    );
    this.gauge(
      lines,
      'velora_process_heap_used_bytes',
      'Used V8 heap size of the process in bytes.',
      memory.heapUsed,
      labels,
    );
    this.gauge(
      lines,
      'velora_process_uptime_seconds',
      'Process uptime in seconds.',
      process.uptime(),
      labels,
    );
    this.gauge(
      lines,
      'velora_nodejs_event_loop_lag_p99_seconds',
      'p99 Node.js event-loop delay observed since the previous metrics scrape in seconds.',
      this.nanosecondsToSeconds(this.eventLoopDelay.percentile(99)),
      labels,
    );
    this.gauge(
      lines,
      'velora_auth_database_up',
      'Whether Auth PostgreSQL is reachable.',
      database.status === 'fulfilled' ? 1 : 0,
      labels,
    );
    this.gauge(
      lines,
      'velora_auth_redis_up',
      'Whether Auth Redis is reachable.',
      redis.status === 'fulfilled' ? 1 : 0,
      labels,
    );

    this.header(
      lines,
      'velora_auth_requests_total',
      'Auth RPC requests by bounded operation and outcome.',
      'counter',
    );
    for (const [key, count] of this.requestCounts) {
      const [operation, outcome] = key.split('|');
      lines.push(
        `velora_auth_requests_total${this.labels({ service: this.serviceName, operation, outcome })} ${count}`,
      );
    }
    this.appendHistograms(
      lines,
      'velora_auth_request_duration_seconds',
      'Auth RPC handling duration by bounded operation and outcome.',
      this.requestDurations,
      (key) => {
        const [operation, outcome] = key.split('|');
        return { service: this.serviceName, operation, outcome };
      },
    );

    this.header(
      lines,
      'velora_auth_refresh_rotations_total',
      'Refresh-token rotation outcomes.',
      'counter',
    );
    for (const outcome of [
      'success',
      'recovered',
      'replay_detected',
      'invalid',
    ] as const) {
      lines.push(
        `velora_auth_refresh_rotations_total${this.labels({ service: this.serviceName, outcome })} ${this.refreshCounts.get(outcome) ?? 0}`,
      );
    }
    this.appendHistograms(
      lines,
      'velora_auth_refresh_duration_seconds',
      'Refresh-token rotation duration.',
      this.refreshDurations,
      () => ({ service: this.serviceName }),
    );

    this.header(
      lines,
      'velora_auth_token_cleanup_runs_total',
      'Scheduled refresh-token cleanup runs by outcome.',
      'counter',
    );
    for (const outcome of ['success', 'error'] as const) {
      lines.push(
        `velora_auth_token_cleanup_runs_total${this.labels({ service: this.serviceName, outcome })} ${this.cleanupCounts.get(outcome) ?? 0}`,
      );
    }
    this.appendHistograms(
      lines,
      'velora_auth_token_cleanup_duration_seconds',
      'Scheduled refresh-token cleanup duration by outcome.',
      this.cleanupDurations,
      (outcome) => ({ service: this.serviceName, outcome }),
    );
    this.gauge(
      lines,
      'velora_auth_token_cleanup_deleted_total',
      'Total expired or revoked refresh tokens deleted by scheduled cleanup.',
      this.cleanupDeleted,
      labels,
      'counter',
    );
    this.gauge(
      lines,
      'velora_auth_token_cleanup_last_success_timestamp_seconds',
      'Unix timestamp of the last successful scheduled refresh-token cleanup.',
      this.cleanupLastSuccessTimestampSeconds,
      labels,
    );

    this.eventLoopDelay.reset();
    return `${lines.join('\n')}\n`;
  }

  private observe(
    store: Map<string, HistogramState>,
    key: string,
    durationSeconds: number,
  ): void {
    const duration =
      Number.isFinite(durationSeconds) && durationSeconds >= 0
        ? durationSeconds
        : 0;
    const state = store.get(key) ?? {
      bucketCounts: this.durationBuckets.map(() => 0),
      count: 0,
      sum: 0,
    };
    state.count += 1;
    state.sum += duration;
    this.durationBuckets.forEach((bucket, index) => {
      if (duration <= bucket) state.bucketCounts[index] += 1;
    });
    store.set(key, state);
  }

  private appendHistograms(
    lines: string[],
    name: string,
    help: string,
    store: Map<string, HistogramState>,
    labelsFor: (key: string) => Record<string, string>,
  ): void {
    this.header(lines, name, help, 'histogram');
    for (const [key, state] of store) {
      const baseLabels = labelsFor(key);
      this.durationBuckets.forEach((bucket, index) => {
        lines.push(
          `${name}_bucket${this.labels({ ...baseLabels, le: String(bucket) })} ${state.bucketCounts[index]}`,
        );
      });
      lines.push(
        `${name}_bucket${this.labels({ ...baseLabels, le: '+Inf' })} ${state.count}`,
      );
      lines.push(`${name}_sum${this.labels(baseLabels)} ${state.sum}`);
      lines.push(`${name}_count${this.labels(baseLabels)} ${state.count}`);
    }
  }

  private gauge(
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
