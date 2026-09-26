import { Injectable, OnModuleDestroy } from '@nestjs/common';
import { monitorEventLoopDelay } from 'node:perf_hooks';

const CALL_EVENTS = [
  'invite_accepted',
  'invite_rejected',
  'invite_denied',
  'late_join_accepted',
  'late_join_denied',
  'media_ready',
  'media_failed',
  'terminal_emitted',
] as const;
type CallEvent = (typeof CALL_EVENTS)[number];

@Injectable()
export class CallPrometheusMetricsService implements OnModuleDestroy {
  static readonly CONTENT_TYPE = 'text/plain; version=0.0.4; charset=utf-8';

  private readonly serviceName = 'call-service';
  private readonly eventLoopDelay = monitorEventLoopDelay({ resolution: 20 });
  private readonly socketDisconnectsByReason = new Map<string, number>();
  private socketReconnectCount = 0;
  private socketReconnectDurationSecondsSum = 0;
  private socketReconnectDurationSecondsMax = 0;
  private readonly callEvents = new Map<CallEvent, number>();

  constructor() {
    this.eventLoopDelay.enable();
  }

  onModuleDestroy() {
    this.eventLoopDelay.disable();
  }

  /**
   * Record a bounded, low-cardinality Socket.IO disconnect reason. The raw
   * Socket.IO reason is deliberately normalized before it can reach a metric
   * label so transport/SDK text never becomes telemetry cardinality.
   */
  recordSocketDisconnect(reason: unknown): void {
    const normalizedReason = this.normalizeDisconnectReason(reason);
    this.socketDisconnectsByReason.set(
      normalizedReason,
      (this.socketDisconnectsByReason.get(normalizedReason) ?? 0) + 1,
    );
  }

  /** Record the time spent from an active participant disconnect to rejoin. */
  recordSocketReconnect(durationMs: number): void {
    if (!Number.isFinite(durationMs) || durationMs < 0) return;

    const durationSeconds = durationMs / 1000;
    this.socketReconnectCount += 1;
    this.socketReconnectDurationSecondsSum += durationSeconds;
    this.socketReconnectDurationSecondsMax = Math.max(
      this.socketReconnectDurationSecondsMax,
      durationSeconds,
    );
  }

  recordCallEvent(event: CallEvent): void {
    if (!CALL_EVENTS.includes(event)) return;
    this.callEvents.set(event, (this.callEvents.get(event) ?? 0) + 1);
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

    this.metricHeader(
      lines,
      'velora_call_socket_disconnects_total',
      'Socket.IO disconnects observed by normalized reason.',
      'counter',
    );
    for (const [reason, count] of this.socketDisconnectsByReason) {
      lines.push(
        `velora_call_socket_disconnects_total${this.labels({
          service: this.serviceName,
          reason,
        })} ${count}`,
      );
    }

    this.metricHeader(
      lines,
      'velora_call_socket_reconnects_total',
      'Successful active-call socket rejoin operations.',
      'counter',
    );
    lines.push(
      `velora_call_socket_reconnects_total${labels} ${this.socketReconnectCount}`,
    );

    this.metricHeader(
      lines,
      'velora_call_socket_reconnect_duration_seconds',
      'Time from an active participant socket disconnect to a successful rejoin.',
      'summary',
    );
    lines.push(
      `velora_call_socket_reconnect_duration_seconds_sum${labels} ${this.socketReconnectDurationSecondsSum}`,
    );
    lines.push(
      `velora_call_socket_reconnect_duration_seconds_count${labels} ${this.socketReconnectCount}`,
    );
    lines.push(
      `velora_call_socket_reconnect_duration_seconds_max${labels} ${this.socketReconnectDurationSecondsMax}`,
    );

    this.metricHeader(
      lines,
      'velora_call_lifecycle_events_total',
      'Bounded group invitation, media setup, and terminal emission outcomes.',
      'counter',
    );
    for (const [event, count] of this.callEvents) {
      lines.push(
        `velora_call_lifecycle_events_total${this.labels({ service: this.serviceName, event })} ${count}`,
      );
    }

    this.eventLoopDelay.reset();

    return `${lines.join('\n')}\n`;
  }

  private metricHeader(
    lines: string[],
    name: string,
    help: string,
    type: 'counter' | 'gauge' | 'summary',
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

  private normalizeDisconnectReason(reason: unknown): string {
    const value = typeof reason === 'string' ? reason.toLowerCase() : '';
    if (value.includes('ping timeout')) return 'ping_timeout';
    if (value.includes('transport error')) return 'transport_error';
    if (value.includes('transport close')) return 'transport_close';
    if (value === 'io server disconnect') return 'server_disconnect';
    if (value === 'io client disconnect') return 'client_disconnect';
    return 'other';
  }
}
