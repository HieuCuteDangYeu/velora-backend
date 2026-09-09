import type { OnModuleDestroy } from '@nestjs/common';
import { monitorEventLoopDelay } from 'node:perf_hooks';

export class RuntimePrometheusMetrics implements OnModuleDestroy {
  static readonly CONTENT_TYPE = 'text/plain; version=0.0.4; charset=utf-8';

  private readonly eventLoopDelay = monitorEventLoopDelay({ resolution: 20 });

  constructor(protected readonly serviceName: string) {
    this.eventLoopDelay.enable();
  }

  onModuleDestroy() {
    this.eventLoopDelay.disable();
  }

  metrics(socketConnections: number | null = null): string {
    const lines = this.baseMetrics(socketConnections);
    this.appendServiceMetrics(lines);
    this.eventLoopDelay.reset();
    return `${lines.join('\n')}\n`;
  }

  protected appendServiceMetrics(lines: string[]) {
    void lines;
  }

  protected metricHeader(
    lines: string[],
    name: string,
    help: string,
    type: 'counter' | 'gauge' | 'histogram',
  ) {
    lines.push(`# HELP ${name} ${help}`);
    lines.push(`# TYPE ${name} ${type}`);
  }

  protected labels(values: Record<string, string>) {
    const body = Object.entries(values)
      .map(([name, value]) => `${name}="${this.escapeLabel(value)}"`)
      .join(',');
    return `{${body}}`;
  }

  private baseMetrics(socketConnections: number | null) {
    const lines: string[] = [];
    const serviceLabels = this.labels({ service: this.serviceName });
    const cpu = process.cpuUsage();
    const memory = process.memoryUsage();
    const eventLoopP99Seconds = this.nanosecondsToSeconds(
      this.eventLoopDelay.percentile(99),
    );

    this.metricHeader(
      lines,
      'velora_process_cpu_user_seconds_total',
      'Total user CPU time consumed by a Velora Node.js service in seconds.',
      'counter',
    );
    lines.push(
      `velora_process_cpu_user_seconds_total${serviceLabels} ${cpu.user / 1_000_000}`,
    );

    this.metricHeader(
      lines,
      'velora_process_cpu_system_seconds_total',
      'Total system CPU time consumed by a Velora Node.js service in seconds.',
      'counter',
    );
    lines.push(
      `velora_process_cpu_system_seconds_total${serviceLabels} ${cpu.system / 1_000_000}`,
    );

    this.metricHeader(
      lines,
      'velora_process_resident_memory_bytes',
      'Resident set size of a Velora Node.js service in bytes.',
      'gauge',
    );
    lines.push(`velora_process_resident_memory_bytes${serviceLabels} ${memory.rss}`);

    this.metricHeader(
      lines,
      'velora_process_heap_used_bytes',
      'Used V8 heap size of a Velora Node.js service in bytes.',
      'gauge',
    );
    lines.push(`velora_process_heap_used_bytes${serviceLabels} ${memory.heapUsed}`);

    this.metricHeader(
      lines,
      'velora_process_uptime_seconds',
      'Process uptime of a Velora Node.js service in seconds.',
      'gauge',
    );
    lines.push(`velora_process_uptime_seconds${serviceLabels} ${process.uptime()}`);

    this.metricHeader(
      lines,
      'velora_nodejs_event_loop_lag_p99_seconds',
      'p99 Node.js event-loop delay observed since the previous scrape in seconds.',
      'gauge',
    );
    lines.push(
      `velora_nodejs_event_loop_lag_p99_seconds${serviceLabels} ${eventLoopP99Seconds}`,
    );

    if (socketConnections !== null && Number.isFinite(socketConnections)) {
      this.metricHeader(
        lines,
        'velora_realtime_socket_connections',
        'Current Socket.IO connections for a Velora realtime service.',
        'gauge',
      );
      lines.push(
        `velora_realtime_socket_connections${serviceLabels} ${Math.max(0, socketConnections)}`,
      );
    }

    return lines;
  }

  private escapeLabel(value: string) {
    return value.replace(/\\/g, '\\\\').replace(/\n/g, '\\n').replace(/"/g, '\\"');
  }

  private nanosecondsToSeconds(value: number) {
    return Number.isFinite(value) ? value / 1_000_000_000 : 0;
  }
}
