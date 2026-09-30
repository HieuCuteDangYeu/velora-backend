import { NotificationPrometheusMetricsService } from './notification-prometheus-metrics.service';

describe('NotificationPrometheusMetricsService', () => {
  it('exports bounded labels and no request identity or private payload fields', () => {
    const metrics = new NotificationPrometheusMetricsService();
    metrics.recordApnsRequest('timeout');
    metrics.recordRetrySchedulerRun('database_unavailable');
    metrics.recordRetryJobs(3, 1);
    metrics.setDatabaseAvailability(false);
    metrics.recordRetrySchedulerCompletion();

    const output = metrics.metrics();

    expect(output).toContain(
      'velora_process_start_time_seconds{service="notification-service"}',
    );
    expect(output).toContain(
      'velora_notification_apns_requests_total{service="notification-service",outcome="timeout"} 1',
    );
    expect(output).toContain(
      'velora_notification_database_up{service="notification-service"} 0',
    );
    expect(output).toContain(
      'velora_notification_retry_jobs_total{service="notification-service",outcome="attempted"} 3',
    );
    expect(output).toContain(
      'velora_notification_retry_jobs_total{service="notification-service",outcome="failed"} 1',
    );
    expect(output).not.toMatch(/userId|callId|token|payload/i);

    metrics.onModuleDestroy();
  });
});
