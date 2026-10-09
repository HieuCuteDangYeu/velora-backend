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
  it('retains a last-good backlog on query failure and exposes sample freshness', () => {
    const now = jest.spyOn(Date, 'now').mockReturnValue(10_000);
    const metrics = new NotificationPrometheusMetricsService();
    expect(metrics.metrics()).not.toContain(
      '# TYPE velora_notification_jobs_outstanding',
    );
    metrics.recordBacklog({
      counts: { pending: 3, processing: 1, failed: 2 },
      oldestCreatedAt: new Date(5_000),
    });
    now.mockReturnValue(20_000);
    metrics.setBacklogSampleAvailability(false);
    const output = metrics.metrics();
    expect(output).toContain(
      'velora_notification_backlog_sample_up{service="notification-service"} 0',
    );
    expect(output).toContain(
      'velora_notification_backlog_last_sample_timestamp_seconds{service="notification-service"} 10',
    );
    expect(output).toContain(
      'velora_notification_jobs_outstanding{service="notification-service",status="pending"} 3',
    );
    expect(output).toContain(
      'velora_notification_oldest_outstanding_age_seconds{service="notification-service"} 15',
    );
    metrics.recordBacklog({
      counts: { pending: 0, processing: 0, failed: 0 },
      oldestCreatedAt: null,
    });
    expect(metrics.metrics()).toContain(
      'velora_notification_oldest_outstanding_age_seconds{service="notification-service"} 0',
    );
    metrics.onModuleDestroy();
    now.mockRestore();
  });

  it('exports cumulative database gate wait buckets and bounded queue gauges', () => {
    const metrics = new NotificationPrometheusMetricsService();
    metrics.recordDatabaseQueue(4, 2);
    metrics.recordDatabaseWait(0);
    metrics.recordDatabaseWait(0.12);
    metrics.recordDatabaseWait(NaN);
    const output = metrics.metrics();
    expect(output).toContain(
      'velora_notification_database_gate_active{service="notification-service"} 4',
    );
    expect(output).toContain(
      'velora_notification_database_gate_waiting{service="notification-service"} 2',
    );
    expect(output).toContain(
      'velora_notification_database_gate_wait_seconds_bucket{service="notification-service",le="0.1"} 1',
    );
    expect(output).toContain(
      'velora_notification_database_gate_wait_seconds_bucket{service="notification-service",le="0.25"} 2',
    );
    expect(output).toContain(
      'velora_notification_database_gate_wait_seconds_bucket{service="notification-service",le="+Inf"} 2',
    );
    expect(output).toContain(
      'velora_notification_database_gate_wait_seconds_sum{service="notification-service"} 0.12',
    );
    metrics.onModuleDestroy();
  });
});
