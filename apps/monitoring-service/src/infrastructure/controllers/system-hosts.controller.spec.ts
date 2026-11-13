import { SystemHostsController } from './system-hosts.controller';

const FROM = '2026-01-01T00:00:00.000Z';
const TO = '2026-01-01T00:15:00.000Z';

describe('SystemHostsController', () => {
  const hostMetrics = { fleet: jest.fn() };
  const registry = { list: jest.fn() };
  const prometheus = { rangeSeries: jest.fn() };
  const metrics = { recordRpc: jest.fn() };
  const controller = new SystemHostsController(
    hostMetrics as never,
    registry as never,
    prometheus as never,
    metrics as never,
  );

  beforeEach(() => {
    jest.resetAllMocks();
  });

  it('lists the fleet', async () => {
    const fleet = { generatedAt: FROM, source: 'prometheus', hosts: [] };
    hostMetrics.fleet.mockResolvedValue(fleet);

    await expect(controller.list()).resolves.toBe(fleet);
    expect(metrics.recordRpc).toHaveBeenCalledWith(
      'system.hosts.list',
      'success',
      expect.any(Number),
    );
  });

  it('reports a Prometheus outage as 503', async () => {
    hostMetrics.fleet.mockRejectedValue(new Error('Prometheus unavailable'));

    await expect(controller.list()).rejects.toMatchObject({
      error: { statusCode: 503, message: 'Prometheus unavailable' },
    });
    expect(metrics.recordRpc).toHaveBeenCalledWith(
      'system.hosts.list',
      'error',
      expect.any(Number),
    );
  });

  it('returns one series per registered host from a single grouped query', async () => {
    registry.list.mockResolvedValue([
      { id: 'home', label: 'home' },
      { id: 'local', label: '' },
    ]);
    prometheus.rangeSeries.mockResolvedValue([
      { metric: { host: 'home' }, points: [{ timestamp: 1, value: 0.2 }] },
      { metric: {}, points: [{ timestamp: 1, value: 0.4 }] },
      // A host removed from prometheus.yml but still inside the window.
      { metric: { host: 'gone' }, points: [{ timestamp: 1, value: 0.9 }] },
    ]);

    const result = await controller.history({
      metric: 'host_cpu',
      from: FROM,
      to: TO,
      stepSeconds: 30,
    });

    expect(prometheus.rangeSeries).toHaveBeenCalledTimes(1);
    expect(prometheus.rangeSeries).toHaveBeenCalledWith(
      '(1 - sum by (host) (rate(node_cpu_seconds_total{job="node-exporter",mode="idle"}[1m])) / sum by (host) (rate(node_cpu_seconds_total{job="node-exporter"}[1m]))) and on(host) (count by (host) (node_cpu_seconds_total{job="node-exporter",mode="idle"} offset 1m))',
      FROM,
      TO,
      30,
    );
    expect(result).toEqual({
      metric: 'host_cpu',
      from: FROM,
      to: TO,
      stepSeconds: 30,
      series: [
        { host: 'home', points: [{ timestamp: 1, value: 0.2 }] },
        { host: 'local', points: [{ timestamp: 1, value: 0.4 }] },
      ],
    });
  });

  it.each([undefined, 'cpu', 'host_unknown', 'arbitrary_query'])(
    'rejects the metric %s',
    async (metric) => {
      await expect(
        controller.history({ metric, from: FROM, to: TO }),
      ).rejects.toMatchObject({
        error: { statusCode: 400 },
      });
      expect(prometheus.rangeSeries).not.toHaveBeenCalled();
    },
  );

  it('applies the shared range bounds', async () => {
    await expect(
      controller.history({
        metric: 'host_cpu',
        from: FROM,
        to: TO,
        stepSeconds: 5,
      }),
    ).rejects.toMatchObject({
      error: { message: expect.stringContaining('stepSeconds') },
    });
    await expect(
      controller.history({
        metric: 'host_cpu',
        from: '2026-01-01T00:00:00Z',
        to: '2026-01-03T00:00:00Z',
      }),
    ).rejects.toMatchObject({
      error: { message: expect.stringContaining('24 hours') },
    });
  });

  it('leaves hosts without network visibility out of the network history', async () => {
    registry.list.mockResolvedValue([
      { id: 'home', label: 'home', network: 'unavailable' },
      { id: 'node-2', label: 'node-2', network: 'host' },
    ]);
    prometheus.rangeSeries.mockResolvedValue([
      { metric: { host: 'home' }, points: [{ timestamp: 1, value: 153 }] },
      { metric: { host: 'node-2' }, points: [{ timestamp: 1, value: 2048 }] },
    ]);

    const result = await controller.history({
      metric: 'host_network_receive',
      from: FROM,
      to: TO,
    });

    expect(result.series.map((item) => item.host)).toEqual(['node-2']);
  });
});
