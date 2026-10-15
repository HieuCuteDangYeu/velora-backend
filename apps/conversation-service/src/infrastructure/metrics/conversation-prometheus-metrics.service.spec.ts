import { ConversationPrometheusMetricsService } from './conversation-prometheus-metrics.service';

describe('Chat phase measurements', () => {
  it('records Mongo command samples without inventing outcomes or pool waits', () => {
    const metrics = new ConversationPrometheusMetricsService();
    try {
      metrics.recordMongoCommand('message_insert', 0.05);
      metrics.recordMongoCommand('message_insert', 0.1);
      const output = metrics.metrics(0);
      expect(output).toContain(
        'velora_conversation_mongo_command_duration_seconds_count{service="conversation-service",command="message_insert"} 2',
      );
      expect(output).toContain(
        'velora_conversation_mongo_command_duration_seconds_sum{service="conversation-service",command="message_insert"} 0.15000000000000002',
      );
      expect(output).toContain(
        'not connection-pool wait or server-only execution time',
      );
      expect(output).not.toContain('command="message_insert",status=');
    } finally {
      metrics.onModuleDestroy();
    }
  });

  it.each(['mongo_write', 'outbox_intake'] as const)(
    'records %s successes and failures while preserving result and original error',
    async (phase) => {
      const metrics = new ConversationPrometheusMetricsService();
      try {
        await expect(metrics.measurePhase(phase, () => 42)).resolves.toBe(42);
        const error = new Error('private query');
        await expect(
          metrics.measurePhase(phase, () => {
            throw error;
          }),
        ).rejects.toBe(error);
        metrics.recordPhase('queue_wait', 9);
        const output = metrics.metrics(1);
        expect(output).toContain(`phase="${phase}",status="success"} 1`);
        expect(output).toContain(`phase="${phase}",status="error"} 1`);
        expect(output).toContain(
          'phase="queue_wait",status="success",le="8"} 0',
        );
        expect(output).toContain(
          'phase="queue_wait",status="success",le="10"} 1',
        );
        expect(output).not.toContain('private query');
        expect(output).not.toMatch(/conversationId|userId|messageId/);
      } finally {
        metrics.onModuleDestroy();
      }
    },
  );
});

describe('Recent message rate', () => {
  const withMetrics = (
    test: (metrics: ConversationPrometheusMetricsService) => void,
  ) => {
    const metrics = new ConversationPrometheusMetricsService();
    try {
      test(metrics);
    } finally {
      metrics.onModuleDestroy();
    }
  };

  it('counts messages created in the last second at 100 ms resolution', () =>
    withMetrics((metrics) => {
      const t = 1_700_000_000_000;
      for (let i = 0; i < 30; i++) metrics.recordMessageCreated(t + i * 10);
      expect(metrics.messagesCreatedPerSecond(t + 300)).toBe(30);
      expect(metrics.messagesCreatedPerSecond(t + 900)).toBe(30);
      // The first buckets age out one by one after a second.
      expect(metrics.messagesCreatedPerSecond(t + 1_050)).toBeLessThan(30);
      expect(metrics.messagesCreatedPerSecond(t + 1_400)).toBe(0);
    }));

  it('is zero before any message and keeps counting across more than a second', () =>
    withMetrics((metrics) => {
      expect(metrics.messagesCreatedPerSecond()).toBe(0);
      const t = 1_700_000_100_000;
      for (let second = 0; second < 5; second++) {
        for (let i = 0; i < 100; i++) {
          metrics.recordMessageCreated(t + second * 1_000 + i * 10);
        }
      }
      expect(metrics.messagesCreatedPerSecond(t + 4_999)).toBe(100);
    }));

  it('keeps the lifetime counter independent of the sliding window', () =>
    withMetrics((metrics) => {
      const t = 1_700_000_200_000;
      metrics.recordMessageCreated(t);
      metrics.recordMessageCreated(t + 5_000);
      expect(metrics.messagesCreatedPerSecond(t + 5_000)).toBe(1);
      expect(metrics.metrics(0)).toContain(
        'velora_conversation_messages_created_total{service="conversation-service"} 2',
      );
    }));
});
