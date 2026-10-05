import { ConversationPrometheusMetricsService } from './conversation-prometheus-metrics.service';

describe('Chat phase measurements', () => {
  it('records successes and failures while preserving result and original error', async () => {
    const metrics = new ConversationPrometheusMetricsService();
    try {
      await expect(metrics.measurePhase('mongo_write', () => 42)).resolves.toBe(
        42,
      );
      const error = new Error('private query');
      await expect(
        metrics.measurePhase('mongo_write', () => {
          throw error;
        }),
      ).rejects.toBe(error);
      metrics.recordPhase('queue_wait', 9);
      const output = metrics.metrics(1);
      expect(output).toContain('phase="mongo_write",status="success"} 1');
      expect(output).toContain('phase="mongo_write",status="error"} 1');
      expect(output).toContain('phase="queue_wait",status="success",le="8"} 0');
      expect(output).toContain(
        'phase="queue_wait",status="success",le="10"} 1',
      );
      expect(output).not.toContain('private query');
      expect(output).not.toMatch(/conversationId|userId|messageId/);
    } finally {
      metrics.onModuleDestroy();
    }
  });
});
