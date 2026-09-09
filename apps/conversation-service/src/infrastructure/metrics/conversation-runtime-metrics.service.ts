import type {
  ConversationSendMetricStatus,
  IConversationMetrics,
} from '../../application/ports/conversation-metrics.port';
import { RuntimePrometheusMetrics } from '@common/monitoring/runtime-prometheus-metrics';
import { Injectable } from '@nestjs/common';

type HistogramState = {
  bucketCounts: number[];
  count: number;
  sum: number;
};

@Injectable()
export class ConversationRuntimeMetricsService
  extends RuntimePrometheusMetrics
  implements IConversationMetrics
{
  private readonly durationBuckets = [
    0.005,
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
  private readonly sendCounts: Record<ConversationSendMetricStatus, number> = {
    success: 0,
    error: 0,
  };
  private readonly sendDuration: HistogramState = {
    bucketCounts: this.durationBuckets.map(() => 0),
    count: 0,
    sum: 0,
  };
  private messagesCreated = 0;

  constructor() {
    super('conversation-service');
  }

  recordSend(
    status: ConversationSendMetricStatus,
    durationSeconds: number,
    created: boolean,
  ) {
    this.sendCounts[status] += 1;
    if (created) this.messagesCreated += 1;

    this.sendDuration.count += 1;
    this.sendDuration.sum += durationSeconds;
    this.durationBuckets.forEach((bucket, index) => {
      if (durationSeconds <= bucket) {
        this.sendDuration.bucketCounts[index] += 1;
      }
    });
  }

  protected appendServiceMetrics(lines: string[]) {
    const serviceLabels = this.labels({ service: this.serviceName });

    this.metricHeader(
      lines,
      'velora_conversation_messages_total',
      'Total newly persisted conversation messages.',
      'counter',
    );
    lines.push(
      `velora_conversation_messages_total${serviceLabels} ${this.messagesCreated}`,
    );

    this.metricHeader(
      lines,
      'velora_conversation_send_requests_total',
      'Total send-message persistence attempts by result.',
      'counter',
    );
    for (const status of ['success', 'error'] as const) {
      lines.push(
        `velora_conversation_send_requests_total${this.labels({ service: this.serviceName, status })} ${this.sendCounts[status]}`,
      );
    }

    this.metricHeader(
      lines,
      'velora_conversation_send_duration_seconds',
      'Time spent persisting a send-message request.',
      'histogram',
    );
    this.durationBuckets.forEach((bucket, index) => {
      lines.push(
        `velora_conversation_send_duration_seconds_bucket${this.labels({ service: this.serviceName, le: String(bucket) })} ${this.sendDuration.bucketCounts[index]}`,
      );
    });
    lines.push(
      `velora_conversation_send_duration_seconds_bucket${this.labels({ service: this.serviceName, le: '+Inf' })} ${this.sendDuration.count}`,
    );
    lines.push(
      `velora_conversation_send_duration_seconds_sum${serviceLabels} ${this.sendDuration.sum}`,
    );
    lines.push(
      `velora_conversation_send_duration_seconds_count${serviceLabels} ${this.sendDuration.count}`,
    );
  }
}
