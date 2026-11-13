import { HostMetricsService } from './host-metrics.service';

const sample = (metric: Record<string, string>, value: number) => ({
  metric,
  timestamp: 1,
  value,
});

const GiB = 1024 ** 3;

// Answers each fleet query with samples for two hosts.
const answer = (query: string) => {
  if (query === 'up{job="node-exporter"}') {
    return [
      sample(
        { host: 'home', host_name: 'Homelab', instance: 'node-exporter:9100' },
        1,
      ),
      sample(
        {
          host: 'node-2',
          host_name: 'Node 2',
          host_role: 'worker',
          host_region: 'France',
          instance: '100.86.68.16:9100',
          docker_port: '2375',
        },
        1,
      ),
    ];
  }

  const values: Record<string, [number, number]> = {
    node_memory_MemTotal_bytes: [16 * GiB, 8 * GiB],
    node_memory_MemAvailable_bytes: [4 * GiB, 6 * GiB],
    node_filesystem_size_bytes: [500 * GiB, 200 * GiB],
    node_filesystem_avail_bytes: [100 * GiB, 150 * GiB],
    'node_cpu_seconds_total{job="node-exporter",mode="idle"})': [8, 4],
    node_load1: [1.5, 0.2],
  };
  const hit = Object.entries(values).find(([needle]) => query.includes(needle));
  if (!hit) return [];

  return [
    sample({ host: 'home' }, hit[1][0]),
    sample({ host: 'node-2' }, hit[1][1]),
  ];
};

describe('HostMetricsService', () => {
  it('reads every host with a fixed number of grouped queries', async () => {
    const prometheus = {
      vector: jest.fn((query: string) => Promise.resolve(answer(query))),
    };
    const fleet = await new HostMetricsService(prometheus as never).fleet();

    // 1 target query + 12 metrics, whatever the number of hosts.
    expect(prometheus.vector).toHaveBeenCalledTimes(13);
    expect(
      prometheus.vector.mock.calls
        .map(([query]) => query)
        .filter((query) => !query.startsWith('up{'))
        .every((query) => query.includes('by (host)')),
    ).toBe(true);

    expect(fleet.defaultHostId).toBe('home');
    expect(fleet.hosts.map((host) => host.id)).toEqual(['home', 'node-2']);
    expect(fleet.hosts[1]).toMatchObject({
      id: 'node-2',
      name: 'Node 2',
      role: 'worker',
      region: 'France',
      containers: 'remote',
      up: true,
      memoryTotalBytes: 8 * GiB,
      memoryUsedBytes: 2 * GiB,
      memoryUsageRatio: 0.25,
      diskUsedBytes: 50 * GiB,
      diskUsageRatio: 0.25,
      cpuCount: 4,
      load1: 0.2,
    });
    expect(fleet.hosts[0]).toMatchObject({
      memoryUsageRatio: 0.75,
      diskUsageRatio: 0.8,
    });
  });

  it('never exposes the Docker endpoint to clients', async () => {
    const prometheus = {
      vector: jest.fn((query: string) => Promise.resolve(answer(query))),
    };
    const fleet = await new HostMetricsService(prometheus as never).fleet();

    expect(JSON.stringify(fleet)).not.toContain('2375');
    expect(JSON.stringify(fleet)).not.toContain('dockerEndpoint');
  });

  it('reports missing metrics as null instead of zero', async () => {
    const prometheus = {
      vector: jest.fn((query: string) =>
        Promise.resolve(
          query === 'up{job="node-exporter"}'
            ? [sample({ host: 'down-host' }, 0)]
            : [],
        ),
      ),
    };
    const fleet = await new HostMetricsService(prometheus as never).fleet();

    expect(fleet.hosts[0]).toMatchObject({
      up: false,
      cpuUsageRatio: null,
      memoryUsageRatio: null,
      diskUsageRatio: null,
      uptimeSeconds: null,
    });
  });

  it('shares one batch per scrape interval', async () => {
    const prometheus = {
      vector: jest.fn((query: string) => Promise.resolve(answer(query))),
    };
    const service = new HostMetricsService(prometheus as never);

    await Promise.all([service.fleet(), service.fleet()]);
    await service.fleet();

    expect(prometheus.vector).toHaveBeenCalledTimes(13);
  });

  it('reports no network figures for an exporter that cannot see the machine NICs', async () => {
    const prometheus = {
      vector: jest.fn((query: string) =>
        Promise.resolve(
          query === 'up{job="node-exporter"}'
            ? [
                sample(
                  {
                    host: 'home',
                    host_network: 'unavailable',
                    instance: 'a:1',
                  },
                  1,
                ),
                sample(
                  { host: 'node-2', host_role: 'worker', instance: 'b:1' },
                  1,
                ),
              ]
            : query.includes('node_network_')
              ? [
                  sample({ host: 'home' }, 153),
                  sample({ host: 'node-2' }, 2048),
                ]
              : [],
        ),
      ),
    };
    const fleet = await new HostMetricsService(prometheus as never).fleet();
    const byId = Object.fromEntries(fleet.hosts.map((host) => [host.id, host]));

    // The container's own NIC (153 B/s) must not pass for the machine's traffic.
    expect(byId.home).toMatchObject({
      network: 'unavailable',
      networkReceiveBytesPerSecond: null,
      networkTransmitBytesPerSecond: null,
    });
    expect(byId['node-2']).toMatchObject({
      network: 'host',
      networkReceiveBytesPerSecond: 2048,
      networkTransmitBytesPerSecond: 2048,
    });
  });
});
