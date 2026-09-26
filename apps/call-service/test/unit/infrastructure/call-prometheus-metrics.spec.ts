import { CallPrometheusMetricsService } from '../../../src/infrastructure/metrics/call-prometheus-metrics.service';

describe('CallPrometheusMetricsService call recovery metrics', () => {
  it('exports bounded disconnect reasons and reconnect duration summary', () => {
    const metrics = new CallPrometheusMetricsService();

    metrics.recordSocketDisconnect(
      'ping timeout from native transport details',
    );
    metrics.recordSocketDisconnect('untrusted sdk error with user data');
    metrics.recordSocketReconnect(1250);

    const output = metrics.metrics(3);

    expect(output).toContain(
      'velora_call_socket_disconnects_total{service="call-service",reason="ping_timeout"} 1',
    );
    expect(output).toContain(
      'velora_call_socket_disconnects_total{service="call-service",reason="other"} 1',
    );
    expect(output).toContain(
      'velora_call_socket_reconnects_total{service="call-service"} 1',
    );
    expect(output).toContain(
      'velora_call_socket_reconnect_duration_seconds_sum{service="call-service"} 1.25',
    );
    expect(output).toContain(
      'velora_call_socket_reconnect_duration_seconds_count{service="call-service"} 1',
    );
    expect(output).toContain(
      'velora_call_socket_reconnect_duration_seconds_max{service="call-service"} 1.25',
    );
    expect(output).not.toContain('untrusted sdk error with user data');

    metrics.onModuleDestroy();
  });

  it('ignores invalid reconnect durations', () => {
    const metrics = new CallPrometheusMetricsService();

    metrics.recordSocketReconnect(Number.NaN);
    metrics.recordSocketReconnect(-1);

    expect(metrics.metrics(0)).toContain(
      'velora_call_socket_reconnects_total{service="call-service"} 0',
    );

    metrics.onModuleDestroy();
  });

  it('exports only fixed lifecycle event labels', () => {
    const metrics = new CallPrometheusMetricsService();
    metrics.recordCallEvent('invite_accepted');
    metrics.recordCallEvent('invite_accepted');
    metrics.recordCallEvent('media_failed');
    metrics.recordCallEvent('user-1' as never);

    const output = metrics.metrics(0);
    expect(output).toContain(
      'velora_call_lifecycle_events_total{service="call-service",event="invite_accepted"} 2',
    );
    expect(output).toContain(
      'velora_call_lifecycle_events_total{service="call-service",event="media_failed"} 1',
    );
    expect(output).not.toContain('user-1');
    metrics.onModuleDestroy();
  });
});
