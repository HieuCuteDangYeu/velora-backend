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

describe('CallPrometheusMetricsService mediasoup worker metrics', () => {
  it('exports per-worker CPU seconds, rooms and the live worker count', () => {
    const metrics = new CallPrometheusMetricsService();

    const output = metrics.metrics(0, [
      { worker: '0', cpuSeconds: 12.5, rooms: 7 },
      { worker: '1', cpuSeconds: 3, rooms: 0 },
    ]);

    expect(output).toContain(
      'velora_call_mediasoup_workers{service="call-service"} 2',
    );
    expect(output).toContain(
      'velora_call_mediasoup_worker_cpu_seconds_total{service="call-service",worker="0"} 12.5',
    );
    expect(output).toContain(
      'velora_call_mediasoup_worker_cpu_seconds_total{service="call-service",worker="1"} 3',
    );
    expect(output).toContain(
      'velora_call_mediasoup_worker_rooms{service="call-service",worker="0"} 7',
    );
    expect(output).toContain(
      '# TYPE velora_call_mediasoup_worker_cpu_seconds_total counter',
    );

    metrics.onModuleDestroy();
  });

  it('still exposes a zero worker count when there is no worker sample', () => {
    const metrics = new CallPrometheusMetricsService();

    const output = metrics.metrics(0);

    expect(output).toContain(
      'velora_call_mediasoup_workers{service="call-service"} 0',
    );
    expect(output).not.toContain(
      'velora_call_mediasoup_worker_cpu_seconds_total{',
    );

    metrics.onModuleDestroy();
  });
});
