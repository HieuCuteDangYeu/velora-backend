import { Injectable, OnModuleDestroy } from '@nestjs/common';
import { monitorEventLoopDelay } from 'node:perf_hooks';

export type ChatPhase =
  | 'socket_auth'
  | 'membership'
  | 'queue_wait'
  | 'retry_backoff'
  | 'mongo_write'
  | 'conversation_read'
  | 'user_lookup'
  | 'cache_invalidation'
  | 'fanout'
  | 'notification'
  | 'persist_total';

export type MongoCommand =
  | 'message_insert'
  | 'message_read'
  | 'conversation_read'
  | 'conversation_update';

type SendMessageStatus = 'success' | 'rejected' | 'error';

type HistogramState = {
  bucketCounts: number[];
  count: number;
  sum: number;
};

@Injectable()
export class ConversationPrometheusMetricsService implements OnModuleDestroy {
  static readonly CONTENT_TYPE = 'text/plain; version=0.0.4; charset=utf-8';

  private readonly serviceName = 'conversation-service';
  private readonly sendMessageStatuses: SendMessageStatus[] = [
    'success',
    'rejected',
    'error',
  ];
  private readonly durationBuckets = [
    0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2, 5, 8, 10, 15, 30, 60,
  ];
  private readonly sendMessageCounts = new Map<SendMessageStatus, number>();
  private readonly sendMessageDurations = new Map<
    SendMessageStatus,
    HistogramState
  >();
  private readonly phaseDurations = new Map<string, HistogramState>();
  private readonly mongoDurations = new Map<MongoCommand, HistogramState>();
  private messagesCreated = 0;

  // Prisma query-event timings are command observations, not pool-wait measurements
  // or success/failure guarantees. Never attach raw queries, IDs, or content.
  recordMongoCommand(command: MongoCommand, seconds: number): void {
    const state = this.mongoDurations.get(command) ?? {
      bucketCounts: this.durationBuckets.map(() => 0),
      count: 0,
      sum: 0,
    };
    const duration = Number.isFinite(seconds) && seconds >= 0 ? seconds : 0;
    state.count++;
    state.sum += duration;
    this.durationBuckets.forEach((bucket, index) => {
      if (duration <= bucket) state.bucketCounts[index]++;
    });
    this.mongoDurations.set(command, state);
  }

  async measurePhase<T>(
    phase: ChatPhase,
    action: () => T | PromiseLike<T>,
  ): Promise<T> {
    const startedAt = process.hrtime.bigint();
    let status: 'success' | 'error' = 'success';
    try {
      return await action();
    } catch (error) {
      status = 'error';
      throw error;
    } finally {
      this.recordPhase(
        phase,
        Number(process.hrtime.bigint() - startedAt) / 1e9,
        status,
      );
    }
  }

  recordPhase(
    phase: ChatPhase,
    seconds: number,
    status: 'success' | 'error' = 'success',
  ): void {
    const key = `${phase}:${status}`;
    const state = this.phaseDurations.get(key) ?? {
      bucketCounts: this.durationBuckets.map(() => 0),
      count: 0,
      sum: 0,
    };
    const duration = Number.isFinite(seconds) && seconds >= 0 ? seconds : 0;
    state.count++;
    state.sum += duration;
    this.durationBuckets.forEach((bucket, index) => {
      if (duration <= bucket) state.bucketCounts[index]++;
    });
    this.phaseDurations.set(key, state);
  }
  private readonly eventLoopDelay = monitorEventLoopDelay({ resolution: 20 });

  constructor() {
    this.eventLoopDelay.enable();
  }

  onModuleDestroy() {
    this.eventLoopDelay.disable();
  }

  recordSendMessage(status: SendMessageStatus, durationSeconds: number): void {
    this.sendMessageCounts.set(
      status,
      (this.sendMessageCounts.get(status) ?? 0) + 1,
    );

    const duration =
      Number.isFinite(durationSeconds) && durationSeconds >= 0
        ? durationSeconds
        : 0;
    const state = this.sendMessageDurations.get(status) ?? {
      bucketCounts: this.durationBuckets.map(() => 0),
      count: 0,
      sum: 0,
    };

    state.count += 1;
    state.sum += duration;
    this.durationBuckets.forEach((bucket, index) => {
      if (duration <= bucket) {
        state.bucketCounts[index] += 1;
      }
    });
    this.sendMessageDurations.set(status, state);
  }

  recordMessageCreated(): void {
    this.messagesCreated += 1;
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
      'velora_conversation_socket_connections',
      'Current Socket.IO client connections handled by this conversation-service instance.',
      'gauge',
    );
    lines.push(
      `velora_conversation_socket_connections${labels} ${Math.max(
        0,
        Math.trunc(activeSocketConnections),
      )}`,
    );

    this.metricHeader(
      lines,
      'velora_conversation_send_message_requests_total',
      'Total send_message Socket.IO requests handled by conversation-service.',
      'counter',
    );
    for (const status of this.sendMessageStatuses) {
      lines.push(
        `velora_conversation_send_message_requests_total${this.labels({
          service: this.serviceName,
          status,
        })} ${this.sendMessageCounts.get(status) ?? 0}`,
      );
    }

    this.metricHeader(
      lines,
      'velora_conversation_send_message_duration_seconds',
      'End-to-end synchronous handling duration of send_message Socket.IO requests.',
      'histogram',
    );
    for (const status of this.sendMessageStatuses) {
      const state = this.sendMessageDurations.get(status) ?? {
        bucketCounts: this.durationBuckets.map(() => 0),
        count: 0,
        sum: 0,
      };
      const baseLabels = {
        service: this.serviceName,
        status,
      };

      this.durationBuckets.forEach((bucket, index) => {
        lines.push(
          `velora_conversation_send_message_duration_seconds_bucket${this.labels(
            {
              ...baseLabels,
              le: String(bucket),
            },
          )} ${state.bucketCounts[index]}`,
        );
      });
      lines.push(
        `velora_conversation_send_message_duration_seconds_bucket${this.labels({
          ...baseLabels,
          le: '+Inf',
        })} ${state.count}`,
      );
      lines.push(
        `velora_conversation_send_message_duration_seconds_sum${this.labels(
          baseLabels,
        )} ${state.sum}`,
      );
      lines.push(
        `velora_conversation_send_message_duration_seconds_count${this.labels(
          baseLabels,
        )} ${state.count}`,
      );
    }

    this.metricHeader(
      lines,
      'velora_conversation_messages_created_total',
      'Total new user messages persisted by conversation-service, excluding idempotent retries.',
      'counter',
    );
    lines.push(
      `velora_conversation_messages_created_total${labels} ${this.messagesCreated}`,
    );

    const phaseMetric = 'velora_conversation_send_phase_duration_seconds';
    this.metricHeader(
      lines,
      phaseMetric,
      'Duration per chat processing step; nested steps overlap, fanout is socket enqueue, notification is HTTP acceptance, not push delivery.',
      'histogram',
    );
    for (const [key, state] of this.phaseDurations) {
      const [phase, status] = key.split(':');
      const phaseLabels = { service: this.serviceName, phase, status };
      this.durationBuckets.forEach((bucket, index) =>
        lines.push(
          `${phaseMetric}_bucket${this.labels({ ...phaseLabels, le: String(bucket) })} ${state.bucketCounts[index]}`,
        ),
      );
      lines.push(
        `${phaseMetric}_bucket${this.labels({ ...phaseLabels, le: '+Inf' })} ${state.count}`,
      );
      lines.push(`${phaseMetric}_sum${this.labels(phaseLabels)} ${state.sum}`);
      lines.push(
        `${phaseMetric}_count${this.labels(phaseLabels)} ${state.count}`,
      );
    }

    const mongoMetric = 'velora_conversation_mongo_command_duration_seconds';
    this.metricHeader(
      lines,
      mongoMetric,
      'Prisma query-event Mongo command duration across Conversation service; not connection-pool wait or server-only execution time.',
      'histogram',
    );
    for (const [command, state] of this.mongoDurations) {
      const commandLabels = { service: this.serviceName, command };
      this.durationBuckets.forEach((bucket, index) =>
        lines.push(
          `${mongoMetric}_bucket${this.labels({ ...commandLabels, le: String(bucket) })} ${state.bucketCounts[index]}`,
        ),
      );
      lines.push(
        `${mongoMetric}_bucket${this.labels({ ...commandLabels, le: '+Inf' })} ${state.count}`,
      );
      lines.push(
        `${mongoMetric}_sum${this.labels(commandLabels)} ${state.sum}`,
      );
      lines.push(
        `${mongoMetric}_count${this.labels(commandLabels)} ${state.count}`,
      );
    }

    // Keep event-loop delay scoped to the current scrape window.
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
