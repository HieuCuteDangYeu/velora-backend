import { BadRequestException } from '@nestjs/common';
import { of } from 'rxjs';

import { MonitoringController } from './monitoring.controller';

describe('MonitoringController', () => {
  const createController = () => {
    const monitoringClient = {
      send: jest.fn(() => of({ points: [] })),
    };

    return {
      controller: new MonitoringController(monitoringClient as never),
      monitoringClient,
    };
  };

  it.each([
    'rag_request_rate',
    'rag_total_token_rate',
    'reel_queued',
    'reel_media_queue_wait_p95',
    'reel_index_chunk_rate',
  ])('forwards the monitoring metric %s', async (metric) => {
    const { controller, monitoringClient } = createController();

    await expect(
      controller.timeseries({
        query: {
          metric,
          from: '2026-09-22T12:00:00.000Z',
          to: '2026-09-22T13:00:00.000Z',
          stepSeconds: '60',
        },
      } as never),
    ).resolves.toEqual({ points: [] });

    expect(monitoringClient.send).toHaveBeenCalledWith(
      'system.metrics.timeseries',
      expect.objectContaining({ metric }),
    );
  });

  it('rejects an unknown metric', () => {
    const { controller } = createController();

    expect(() =>
      controller.timeseries({
        query: {
          metric: 'not_a_metric',
          from: '2026-09-22T12:00:00.000Z',
          to: '2026-09-22T13:00:00.000Z',
        },
      } as never),
    ).toThrow(BadRequestException);
  });
  it('forwards the ten-second default for fifteen-minute history', async () => {
    const { controller, monitoringClient } = createController();
    await controller.timeseries({
      query: {
        metric: 'host_cpu',
        from: '2026-10-04T12:00:00Z',
        to: '2026-10-04T12:15:00Z',
      },
    } as never);
    expect(monitoringClient.send).toHaveBeenCalledWith(
      'system.metrics.timeseries',
      {
        metric: 'host_cpu',
        from: '2026-10-04T12:00:00Z',
        to: '2026-10-04T12:15:00Z',
        stepSeconds: 10,
      },
    );
  });

  describe('hosts', () => {
    const range = {
      from: '2026-10-04T12:00:00Z',
      to: '2026-10-04T12:15:00Z',
    };

    it('lists the monitored hosts', async () => {
      const { controller, monitoringClient } = createController();

      await controller.hosts();

      expect(monitoringClient.send).toHaveBeenCalledWith(
        'system.hosts.list',
        {},
      );
    });

    it('forwards a host to the timeseries, containers and logs queries', async () => {
      const { controller, monitoringClient } = createController();

      await controller.timeseries({
        query: { metric: 'host_cpu', host: 'velora-node-2', ...range },
      } as never);
      await controller.containers('velora-node-2');
      await controller.logs({
        query: { service: 'mongo-replica', host: 'velora-node-2', ...range },
      } as never);

      expect(monitoringClient.send).toHaveBeenCalledWith(
        'system.metrics.timeseries',
        expect.objectContaining({ host: 'velora-node-2' }),
      );
      expect(monitoringClient.send).toHaveBeenCalledWith(
        'system.metrics.containers',
        { host: 'velora-node-2' },
      );
      expect(monitoringClient.send).toHaveBeenCalledWith(
        'system.logs.query',
        expect.objectContaining({ host: 'velora-node-2' }),
      );
    });

    it('keeps the old payloads when no host is selected', async () => {
      const { controller, monitoringClient } = createController();

      await controller.containers();

      expect(monitoringClient.send).toHaveBeenCalledWith(
        'system.metrics.containers',
        {},
      );
    });

    it.each(['bad host', 'a"b', '../x', 'x'.repeat(65)])(
      'rejects the malformed host %s',
      (host) => {
        const { controller } = createController();

        expect(() => controller.containers(host)).toThrow(BadRequestException);
        expect(() =>
          controller.timeseries({
            query: { metric: 'host_cpu', host, ...range },
          } as never),
        ).toThrow(BadRequestException);
      },
    );

    it('accepts the host metrics, including ones the shared list does not know', async () => {
      const { controller, monitoringClient } = createController();

      await controller.timeseries({
        query: { metric: 'host_network_receive', ...range },
      } as never);
      await controller.hostsHistory({
        query: { metric: 'host_cpu', ...range, stepSeconds: '30' },
      } as never);

      expect(monitoringClient.send).toHaveBeenCalledWith(
        'system.hosts.history',
        { metric: 'host_cpu', ...range, stepSeconds: 30 },
      );
    });

    it('rejects a non-host metric for the host history', () => {
      const { controller } = createController();

      expect(() =>
        controller.hostsHistory({
          query: { metric: 'conversation_cpu', ...range },
        } as never),
      ).toThrow(BadRequestException);
      expect(() =>
        controller.hostsHistory({ query: { metric: 'host_cpu' } } as never),
      ).toThrow(BadRequestException);
    });
  });
});
