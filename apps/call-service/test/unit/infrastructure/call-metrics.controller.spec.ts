import { CallMetricsController } from '../../../src/infrastructure/controllers/call-metrics.controller';
import { CallPrometheusMetricsService } from '../../../src/infrastructure/metrics/call-prometheus-metrics.service';

describe('CallMetricsController', () => {
  const response = { setHeader: jest.fn() };
  const gateway = { server: { engine: { clientsCount: 4 } } };

  afterEach(() => response.setHeader.mockClear());

  it('adds mediasoup worker load to the scrape', async () => {
    const metrics = new CallPrometheusMetricsService();
    const controller = new CallMetricsController(
      metrics,
      gateway as never,
      {
        getWorkerLoad: jest
          .fn()
          .mockResolvedValue([{ worker: '0', cpuSeconds: 9, rooms: 3 }]),
      } as never,
    );

    const output = await controller.getMetrics(response as never);

    expect(output).toContain(
      'velora_call_socket_connections{service="call-service"} 4',
    );
    expect(output).toContain(
      'velora_call_mediasoup_worker_cpu_seconds_total{service="call-service",worker="0"} 9',
    );
    expect(output).toContain(
      'velora_call_mediasoup_worker_rooms{service="call-service",worker="0"} 3',
    );
    metrics.onModuleDestroy();
  });

  it('keeps serving process metrics when worker load cannot be read', async () => {
    const metrics = new CallPrometheusMetricsService();
    const controller = new CallMetricsController(
      metrics,
      gateway as never,
      {
        getWorkerLoad: jest.fn().mockRejectedValue(new Error('worker died')),
      } as never,
    );

    const output = await controller.getMetrics(response as never);

    expect(output).toContain(
      'velora_call_socket_connections{service="call-service"} 4',
    );
    expect(output).toContain(
      'velora_call_mediasoup_workers{service="call-service"} 0',
    );
    metrics.onModuleDestroy();
  });
});
