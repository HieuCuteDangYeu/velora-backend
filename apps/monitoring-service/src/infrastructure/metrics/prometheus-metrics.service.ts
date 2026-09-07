import { Injectable, OnModuleDestroy } from '@nestjs/common';
import { monitorEventLoopDelay } from 'node:perf_hooks';

type RpcStatus = 'success' | 'error';

type HistogramState = {
  bucketCounts: number[];
  count: number;
  sum: number;
};

@Injectable()
export class PrometheusMetricsService implements OnModuleDestroy {
  static readonly CONTENT_TYPE = 'text/plain; version=0.0.4; charset=utf-8';

  private readonly serviceName = 'monitoring-service';
  private readonly durationBuckets = [
    0.01,
    0.025,
    0.05,
    0.1,
    0.25,
    0.5,
    1,
    2,
    5,
  ];
  private readonly rpcRequestCounts = new Map<string, number>();
  private readonly rpcDurations = new Map<string, HistogramState>();
  private readonly telemetryEventCounts = new Map<string, number>();
  private readonly eventLoopDelay = monitorEventLoopDelay({ resolution: 20 });

  constructor() {
    this.eventLoopDelay.enable();
  }

  onModuleDestroy() {
    this.eventLoopDelay.disable();
  }

  recordRpc(pattern: string, status: RpcStatus, durationSeconds: number) {
    const key = this.rpcKey(pattern, status);
    this.rpcRequestCounts.set(key, (this.rpcRequestCounts.get(key) ?? 0) + 1);

    const state = this.rpcDurations.get(key) ?? {
      bucketCounts: this.durationBuckets.map(() => 0),
      count: 0,
      sum: 0,
    };

    state.count += 1;
    state.sum += durationSeconds;
    this.durationBuckets.forEach((bucket, index) => {
      if (durationSeconds <= bucket) {
        state.bucketCounts[index] += 1;
      }
    });
    this.rpcDurations.set(key, state);
  }

  addTelemetryEvents(type: 'call' | 'recommendation', count: number) {
    if (!Number.isFinite(count) || count <= 0) {
      return;
    }

    this.telemetryEventCounts.set(
      type,
      (this.telemetryEventCounts.get(type) ?? 0) + count,
    );
  }

  metrics(): string {
    const lines: string[] = [];
    const serviceLabels = this.labels({ service: this.serviceName });
    const cpu = process.cpuUsage();
    const memory = process.memoryUsage();
    const eventLoopMeanSeconds = this.nanosecondsToSeconds(this.eventLoopDelay.mean);
    const eventLoopP99Seconds = this.nanosecondsToSeconds(
      this.eventLoopDelay.percentile(99),
    );

    this.metricHeader(
      lines,
      'velora_process_cpu_user_seconds_total',
      'Total user CPU time consumed by the monitoring service in seconds.',
      'counter',
    );
    lines.push(
      `velora_process_cpu_user_seconds_total${serviceLabels} ${cpu.user / 1_000_000}`,
    );

    this.metricHeader(
      lines,
      'velora_process_cpu_system_seconds_total',
      'Total system CPU time consumed by the monitoring service in seconds.',
      'counter',
    );
    lines.push(
      `velora_process_cpu_system_seconds_total${serviceLabels} ${cpu.system / 1_000_000}`,
    );

    this.metricHeader(
      lines,
      'velora_process_resident_memory_bytes',
      'Resident set size of the monitoring service process in bytes.',
      'gauge',
    );
    lines.push(
      `velora_process_resident_memory_bytes${serviceLabels} ${memory.rss}`,
    );

    this.metricHeader(
      lines,
      'velora_process_heap_bytes',
      'Total V8 heap size of the monitoring service process in bytes.',
      'gauge',
    );
    lines.push(`velora_process_heap_bytes${serviceLabels} ${memory.heapTotal}`);

    this.metricHeader(
      lines,
      'velora_process_heap_used_bytes',
      'Used V8 heap size of the monitoring service process in bytes.',
      'gauge',
    );
    lines.push(
      `velora_process_heap_used_bytes${serviceLabels} ${memory.heapUsed}`,
    );

    this.metricHeader(
      lines,
      'velora_process_external_memory_bytes',
      'External memory used by the monitoring service process in bytes.',
      'gauge',
    );
    lines.push(
      `velora_process_external_memory_bytes${serviceLabels} ${memory.external}`,
    );

    this.metricHeader(
      lines,
      'velora_process_uptime_seconds',
      'Monitoring service process uptime in seconds.',
      'gauge',
    );
    lines.push(`velora_process_uptime_seconds${serviceLabels} ${process.uptime()}`);

    this.metricHeader(
      lines,
      'velora_process_start_time_seconds',
      'Unix timestamp when the monitoring service process started.',
      'gauge',
    );
    lines.push(
      `velora_process_start_time_seconds${serviceLabels} ${Date.now() / 1000 - process.uptime()}`,
    );

    this.metricHeader(
      lines,
      'velora_nodejs_event_loop_lag_seconds',
      'Mean Node.js event-loop delay observed since the previous metrics scrape in seconds.',
      'gauge',
    );
    lines.push(
      `velora_nodejs_event_loop_lag_seconds${serviceLabels} ${eventLoopMeanSeconds}`,
    );

    this.metricHeader(
      lines,
      'velora_nodejs_event_loop_lag_p99_seconds',
      'p99 Node.js event-loop delay observed since the previous metrics scrape in seconds.',
      'gauge',
    );
    lines.push(
      `velora_nodejs_event_loop_lag_p99_seconds${serviceLabels} ${eventLoopP99Seconds}`,
    );

    this.metricHeader(
      lines,
      'velora_monitoring_rpc_requests_total',
      'Total RabbitMQ RPC/event operations handled by monitoring-service.',
      'counter',
    );
    for (const [key, count] of this.rpcRequestCounts.entries()) {
      const [pattern, status] = this.parseRpcKey(key);
      lines.push(
        `velora_monitoring_rpc_requests_total${this.labels({ service: this.serviceName, pattern, status })} ${count}`,
      );
    }

    this.metricHeader(
      lines,
      'velora_monitoring_rpc_duration_seconds',
      'Duration of RabbitMQ RPC/event operations handled by monitoring-service.',
      'histogram',
    );
    for (const [key, state] of this.rpcDurations.entries()) {
      const [pattern, status] = this.parseRpcKey(key);
      const baseLabels = {
        service: this.serviceName,
        pattern,
        status,
      };

      this.durationBuckets.forEach((bucket, index) => {
        lines.push(
          `velora_monitoring_rpc_duration_seconds_bucket${this.labels({ ...baseLabels, le: String(bucket) })} ${state.bucketCounts[index]}`,
        );
      });
      lines.push(
        `velora_monitoring_rpc_duration_seconds_bucket${this.labels({ ...baseLabels, le: '+Inf' })} ${state.count}`,
      );
      lines.push(
        `velora_monitoring_rpc_duration_seconds_sum${this.labels(baseLabels)} ${state.sum}`,
      );
      lines.push(
        `velora_monitoring_rpc_duration_seconds_count${this.labels(baseLabels)} ${state.count}`,
      );
    }

    this.metricHeader(
      lines,
      'velora_monitoring_telemetry_events_total',
      'Total application telemetry events accepted for processing by monitoring-service.',
      'counter',
    );
    for (const [type, count] of this.telemetryEventCounts.entries()) {
      lines.push(
        `velora_monitoring_telemetry_events_total${this.labels({ service: this.serviceName, type })} ${count}`,
      );
    }

    // Event-loop delay should describe the current scrape window instead of the
    // full process lifetime; otherwise one old spike keeps p99 elevated forever.
    this.eventLoopDelay.reset();

    return `${lines.join('\n')}\n`;
  }

  private rpcKey(pattern: string, status: RpcStatus) {
    return JSON.stringify([pattern, status]);
  }

  private parseRpcKey(key: string): [string, RpcStatus] {
    return JSON.parse(key) as [string, RpcStatus];
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
    return value.replace(/\\/g, '\\\\').replace(/\n/g, '\\n').replace(/"/g, '\\"');
  }

  private nanosecondsToSeconds(value: number) {
    return Number.isFinite(value) ? value / 1_000_000_000 : 0;
  }
}
