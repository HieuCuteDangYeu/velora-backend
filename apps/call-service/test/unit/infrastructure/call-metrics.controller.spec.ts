import { CallMetricsController } from '../../../src/infrastructure/controllers/call-metrics.controller';
import { CallPrometheusMetricsService } from '../../../src/infrastructure/metrics/call-prometheus-metrics.service';
import { createServer } from 'node:http';
import { Server } from 'socket.io';
import { io, type Socket as ClientSocket } from 'socket.io-client';

describe('CallMetricsController', () => {
  const response = { setHeader: jest.fn() };
  const gateway = {
    server: { sockets: new Map(['a', 'b', 'c', 'd'].map((id) => [id, {}])) },
  };

  const getPublicAddressStatus = jest.fn().mockReturnValue({
    detectionEnabled: true,
    lastCheckSucceeded: false,
    lastSuccessTimestampSeconds: 0,
    changes: 0,
    mismatch: false,
  });

  afterEach(() => response.setHeader.mockClear());

  it('reports zero before the namespace is initialized', async () => {
    const metrics = new CallPrometheusMetricsService();
    try {
      const controller = new CallMetricsController(
        metrics,
        {} as never,
        {
          getWorkerLoad: jest.fn().mockResolvedValue([]),
          getPublicAddressStatus,
        } as never,
      );
      expect(await controller.getMetrics(response as never)).toContain(
        'velora_call_socket_connections{service="call-service"} 0',
      );
    } finally {
      metrics.onModuleDestroy();
    }
  });

  it('counts only live /call namespace sockets and tracks disconnects', async () => {
    const http = createServer();
    const server = new Server(http);
    const namespace = server.of('/call');
    server.of('/other');
    const clients: ClientSocket[] = [];
    const metrics = new CallPrometheusMetricsService();
    const controller = new CallMetricsController(
      metrics,
      { server: namespace } as never,
      {
        getWorkerLoad: jest.fn().mockResolvedValue([]),
        getPublicAddressStatus,
      } as never,
    );
    try {
      await new Promise<void>((resolve) =>
        http.listen(0, '127.0.0.1', resolve),
      );
      const address = http.address();
      if (!address || typeof address === 'string')
        throw new Error('No test port');
      for (const path of ['/call', '/call', '/other']) {
        const client = io(`http://127.0.0.1:${address.port}${path}`, {
          transports: ['websocket'],
          forceNew: true,
          reconnection: false,
          autoConnect: false,
        });
        clients.push(client);
        await new Promise<void>((resolve, reject) => {
          client.once('connect', resolve);
          client.once('connect_error', reject);
          client.connect();
        });
      }
      expect(server.engine.clientsCount).toBe(3);
      expect(await controller.getMetrics(response as never)).toContain(
        'velora_call_socket_connections{service="call-service"} 2',
      );
      const first = namespace.sockets.get(clients[0].id!);
      if (!first) throw new Error('Missing test socket');
      await new Promise<void>((resolve) => {
        first.once('disconnect', resolve);
        clients[0].disconnect();
      });
      expect(await controller.getMetrics(response as never)).toContain(
        'velora_call_socket_connections{service="call-service"} 1',
      );
    } finally {
      clients.forEach((client) => client.disconnect());
      metrics.onModuleDestroy();
      await server.close();
    }
  });

  it('adds mediasoup worker load to the scrape', async () => {
    const metrics = new CallPrometheusMetricsService();
    const controller = new CallMetricsController(
      metrics,
      gateway as never,
      {
        getWorkerLoad: jest
          .fn()
          .mockResolvedValue([{ worker: '0', cpuSeconds: 9, rooms: 3 }]),
        getPublicAddressStatus,
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
        getPublicAddressStatus,
      } as never,
    );

    const output = await controller.getMetrics(response as never);

    expect(output).toContain(
      'velora_call_socket_connections{service="call-service"} 4',
    );
    expect(output).toContain(
      'velora_call_mediasoup_workers{service="call-service"} 0',
    );
    expect(output).toContain(
      'velora_call_media_public_ip_check_success{service="call-service"} 0',
    );
    metrics.onModuleDestroy();
  });
});
