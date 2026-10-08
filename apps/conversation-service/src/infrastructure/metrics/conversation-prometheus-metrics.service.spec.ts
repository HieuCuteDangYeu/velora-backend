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
