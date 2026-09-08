import { Injectable, OnModuleDestroy } from '@nestjs/common';
import { monitorEventLoopDelay } from 'node:perf_hooks';

@Injectable()
export class CallPrometheusMetricsService implements OnModuleDestroy {
  static readonly CONTENT_TYPE = 'text/plain; version=0.0.4; charset=utf-8';

  private readonly serviceName = 'call-service';
  private readonly eventLoopDelay = monitorEventLoopDelay({ resolution: 20 });

  constructor() {
    this.eventLoopDelay.enable();
  }

  onModuleDestroy() {
    this.eventLoopDelay.disable();
  }

  metrics(activeSocketConnections: number): string {
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
      'velora_call_socket_connections',
      'Current Socket.IO client connections handled by this call-service instance.',
      'gauge',
    );
    lines.push(
      `velora_call_socket_connections${labels} ${Math.max(
        0,
        Math.trunc(activeSocketConnections),
      )}`,
    );

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
    return value.replace(/\\/g, '\\\\').replace(/\n/g, '\\n').replace(/"/g, '\\"');
  }

  private nanosecondsToSeconds(value: number) {
    return Number.isFinite(value) ? value / 1_000_000_000 : 0;
  }
}
