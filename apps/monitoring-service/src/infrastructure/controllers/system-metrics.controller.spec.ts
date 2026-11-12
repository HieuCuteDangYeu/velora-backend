import { RpcException } from '@nestjs/microservices';
import { SystemMetricsController } from './system-metrics.controller';

describe('SystemMetricsController container resources', () => {
  const prometheus = {
    scalar: jest.fn(),
    vector: jest.fn(),
    range: jest.fn(),
  };
  const metrics = { recordRpc: jest.fn() };
  const docker = {
    snapshot: jest.fn(),
    snapshotMetadata: jest.fn().mockResolvedValue(null),
  };
  const hosts = { require: jest.fn() };
  let controller = new SystemMetricsController(
    prometheus as never,
    metrics as never,
    docker as never,
    hosts as never,
  );

  beforeEach(() => {
    jest.resetAllMocks();
    prometheus.vector.mockResolvedValue([]);
    controller = new SystemMetricsController(
      prometheus as never,
      metrics as never,
      docker as never,
      hosts as never,
    );
    jest.restoreAllMocks();
  });

  it('returns the current Docker Engine snapshot', async () => {
    docker.snapshot.mockResolvedValue([
      {
        service: 'monitoring-service',
        container: 'monitoring-1',
        cpuCores: 0.05,
        memoryWorkingSetBytes: 400,
        memoryLimitBytes: null,
        filesystemUsageBytes: 120,
      },
      {
        service: 'api-gateway',
        container: 'gateway-1',
        cpuCores: 0.25,
        memoryWorkingSetBytes: 200,
        memoryLimitBytes: 1000,
        filesystemUsageBytes: 80,
      },
    ]);

    await expect(controller.containers()).resolves.toEqual({
      generatedAt: expect.any(String),
      source: 'docker',
      dockerEngineUp: true,
      containers: [
        {
          service: 'monitoring-service',
          container: 'monitoring-1',
          cpuCores: 0.05,
          memoryWorkingSetBytes: 400,
          memoryLimitBytes: null,
          filesystemUsageBytes: 120,
        },
        {
          service: 'api-gateway',
          container: 'gateway-1',
          cpuCores: 0.25,
          memoryWorkingSetBytes: 200,
          memoryLimitBytes: 1000,
          filesystemUsageBytes: 80,
        },
      ],
    });

    expect(docker.snapshot).toHaveBeenCalledTimes(1);
    expect(prometheus.scalar).not.toHaveBeenCalled();
    expect(prometheus.vector).not.toHaveBeenCalled();
    expect(metrics.recordRpc).toHaveBeenCalledWith(
      'system.metrics.containers',
      'success',
      expect.any(Number),
    );
  });

  it('reports Docker Engine availability without failing the RPC', async () => {
    docker.snapshot.mockRejectedValue(new Error('Docker socket unavailable'));

    await expect(controller.containers()).resolves.toEqual({
      generatedAt: expect.any(String),
      source: 'docker',
      dockerEngineUp: false,
      containers: [],
    });
  });

  it('includes Docker metadata when the engine exposes it', async () => {
    docker.snapshot.mockResolvedValue([]);
    docker.snapshotMetadata = jest.fn().mockResolvedValue({
      hostCpuCount: 8,
      storage: {
        imagesBytes: 1024,
        volumesBytes: 2048,
        buildCacheBytes: 0,
      },
    });

    await expect(controller.containers()).resolves.toMatchObject({
      source: 'docker',
      dockerEngineUp: true,
      hostCpuCount: 8,
      storage: {
        imagesBytes: 1024,
        volumesBytes: 2048,
        buildCacheBytes: 0,
      },
      containers: [],
    });
  });

  it('returns lightweight target status for the global live indicator', async () => {
    prometheus.scalar.mockResolvedValueOnce(1).mockResolvedValueOnce(0);

    await expect(controller.status()).resolves.toMatchObject({
      source: 'prometheus',
      monitoringUp: true,
      hostUp: false,
      generatedAt: expect.any(String),
    });
  });

  it('normalizes every process CPU query to the whole host capacity', async () => {
    prometheus.scalar.mockResolvedValue(0);

    await expect(controller.overview()).resolves.toMatchObject({
      process: { cpuUsageRatio: 0 },
      conversation: { cpuUsageRatio: 0 },
      call: { cpuUsageRatio: 0 },
      notification: {
        cpuUsageRatio: 0,
        databaseUp: false,
        apnsRequestsPerSecond: 0,
        apnsTransportFailuresPerSecond: 0,
        retrySchedulerCompletionAgeSeconds: 0,
      },
    });

    const processCpuQueries = prometheus.scalar.mock.calls
      .map(([query]) => query as string)
      .filter((query) =>
        query.includes('velora_process_cpu_user_seconds_total'),
      );

    expect(processCpuQueries).toHaveLength(6);
    expect(
      processCpuQueries.every(
        (query) =>
          // Divided by the primary machine's cores, never the whole fleet's.
          query.includes(
            'count(node_cpu_seconds_total{job="node-exporter",host_role!="worker",mode="idle"})',
          ) && query.includes('/ clamp_min('),
      ),
    ).toBe(true);

    expect(
      prometheus.scalar.mock.calls.map(([query]) => query as string),
    ).toEqual(
      expect.arrayContaining([
        'max(up{job="notification-service"})',
        expect.stringContaining('velora_notification_database_up'),
        expect.stringContaining('velora_notification_apns_requests_total'),
        expect.stringContaining(
          'velora_notification_retry_scheduler_last_completion_timestamp_seconds',
        ),
      ]),
    );
  });
});

describe('SystemMetricsController live queries and overview sharing', () => {
  const createController = () => {
    const prometheus = {
      scalar: jest.fn().mockResolvedValue(0),
      vector: jest.fn().mockResolvedValue([]),
      range: jest.fn().mockResolvedValue([]),
    };
    const metrics = { recordRpc: jest.fn() };
    const controller = new SystemMetricsController(
      prometheus as never,
      metrics as never,
      { snapshotMetadata: jest.fn().mockResolvedValue(null) } as never,
      { require: jest.fn() } as never,
    );
    return { controller, prometheus, metrics };
  };
  afterEach(() => jest.restoreAllMocks());

  it('uses one-minute windows for every live rate/quantile query', async () => {
    const { controller, prometheus } = createController();
    await controller.overview();
    const queries = prometheus.scalar.mock.calls.map(
      ([query]) => query as string,
    );
    const rates = queries.filter((query) => query.includes('rate('));
    expect(queries).toHaveLength(132);
    expect(rates.length).toBeGreaterThan(50);
    expect(
      rates.every((query) => query.includes('[1m]') && !query.includes('[5m]')),
    ).toBe(true);
  });

  it('reports the busiest mediasoup worker core share and room count for the call service', async () => {
    const { controller, prometheus } = createController();
    prometheus.scalar.mockImplementation((query: string) =>
      Promise.resolve(
        query.includes('velora_call_mediasoup_worker_cpu_seconds_total')
          ? 0.62
          : query.includes('velora_call_mediasoup_worker_rooms')
            ? 41
            : 0,
      ),
    );

    const result = await controller.overview();

    expect(result.call).toMatchObject({
      mediaWorkerCpuRatio: 0.62,
      mediaRooms: 41,
    });
    const workerCpuQuery = prometheus.scalar.mock.calls
      .map(([query]) => query as string)
      .find((query) =>
        query.includes('velora_call_mediasoup_worker_cpu_seconds_total'),
      );
    expect(workerCpuQuery).toContain('max(rate(');
    expect(workerCpuQuery).toContain('[1m]');
  });

  it('aggregates phase samples by label while tolerating an empty p95 vector', async () => {
    const { controller, prometheus } = createController();
    prometheus.vector
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ metric: { phase: 'queue_wait' }, value: 12 }])
      .mockResolvedValueOnce([{ metric: { phase: 'queue_wait' }, value: 0.5 }]);
    const result = await controller.overview();
    expect(result.conversation.sendPhases).toEqual([
      {
        phase: 'queue_wait',
        callsPerSecond: 12,
        errorsPerSecond: 0.5,
        p95Seconds: null,
      },
    ]);
    expect(prometheus.vector).toHaveBeenCalledTimes(5);
    expect(
      prometheus.vector.mock.calls
        .slice(0, 3)
        .every(([query]) => (query as string).includes('[1m]')),
    ).toBe(true);
  });

  it('preserves queue identity and unknown per-lane fields in the overview', async () => {
    const { controller, prometheus } = createController();
    prometheus.vector
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([
        {
          metric: { queue: 'reel_media_short_jobs', vhost: '/' },
          timestamp: 1,
          value: 3,
        },
        {
          metric: { queue: 'reel_index_long_jobs', vhost: '/' },
          timestamp: 1,
          value: 4,
        },
      ])
      .mockResolvedValueOnce([
        {
          metric: { queue: 'reel_media_long_jobs', vhost: '/' },
          timestamp: 1,
          value: 2,
        },
        {
          metric: { queue: 'reel_index_long_jobs', vhost: '/' },
          timestamp: 1,
          value: 0,
        },
      ]);

    const result = await controller.overview();

    expect(result.reels.media.queues).toEqual([
      {
        queue: 'reel_media_long_jobs',
        vhost: '/',
        ready: null,
        consumers: 2,
      },
      {
        queue: 'reel_media_short_jobs',
        vhost: '/',
        ready: 3,
        consumers: null,
      },
    ]);
    expect(result.reels.index.queues).toEqual([
      {
        queue: 'reel_index_long_jobs',
        vhost: '/',
        ready: 4,
        consumers: 0,
      },
    ]);
    expect(
      prometheus.vector.mock.calls.slice(-2).map(([query]) => query as string),
    ).toEqual([
      expect.stringContaining('job="rabbitmq-reels"'),
      expect.stringContaining('job="rabbitmq-reels"'),
    ]);
  });

  it('uses explicit zero fallbacks only behind observed traffic guards', async () => {
    const { controller, prometheus } = createController();
    await controller.overview();

    for (const query of prometheus.scalar.mock.calls
      .map(([value]) => value as string)
      .filter(
        (query) =>
          query.includes('outcome="FAILED"') ||
          query.includes('velora_rag_retries_total') ||
          query.includes('velora_reel_worker_retries_total'),
      )) {
      expect(query).toContain('or on() vector(0)');
      expect(query).toContain('and on()');
    }
  });

  it('coalesces in-flight overviews and expires successful results after five seconds', async () => {
    const { controller, prometheus, metrics } = createController();
    let now = 1000;
    jest.spyOn(Date, 'now').mockImplementation(() => now);
    let resolveSample!: (value: number) => void;
    // One pending scalar is enough to hold the entire batch open.
    prometheus.scalar.mockResolvedValue(0).mockImplementationOnce(
      () =>
        new Promise<number>((resolve) => {
          resolveSample = resolve;
        }),
    );
    const first = controller.overview();
    now += 6000;
    const second = controller.overview();
    expect(prometheus.scalar).toHaveBeenCalledTimes(132);
    resolveSample(1);
    const [a, b] = await Promise.all([first, second]);
    expect(a).toEqual(b);
    now += 4999;
    expect(await controller.overview()).toEqual(a);
    expect(prometheus.scalar).toHaveBeenCalledTimes(132);
    now += 1;
    await controller.overview();
    expect(prometheus.scalar).toHaveBeenCalledTimes(264);
    expect(metrics.recordRpc).toHaveBeenCalledTimes(4);
  });

  it('does not cache failed overviews and permits an immediate retry', async () => {
    const { controller, prometheus } = createController();
    prometheus.scalar.mockRejectedValueOnce(
      new Error('Prometheus unavailable'),
    );
    await expect(controller.overview()).rejects.toThrow();
    await expect(controller.overview()).resolves.toMatchObject({
      source: 'prometheus',
    });
    expect(prometheus.scalar).toHaveBeenCalledTimes(264);
  });

  it('does not serve an expired success after a refresh failure', async () => {
    const { controller, prometheus } = createController();
    let now = 1000;
    jest.spyOn(Date, 'now').mockImplementation(() => now);
    await controller.overview();
    now += 5000;
    prometheus.scalar.mockRejectedValueOnce(
      new Error('Prometheus unavailable'),
    );
    await expect(controller.overview()).rejects.toThrow();
    await expect(controller.overview()).resolves.toMatchObject({
      source: 'prometheus',
    });
    expect(prometheus.scalar).toHaveBeenCalledTimes(396);
  });

  it.each([undefined, 10])(
    'accepts fifteen minutes of history at ten-second points (step %s)',
    async (stepSeconds) => {
      const { controller, prometheus } = createController();
      const from = '2026-10-04T12:00:00.000Z';
      const to = '2026-10-04T12:15:00.000Z';
      await expect(
        controller.timeseries({ metric: 'host_cpu', from, to, stepSeconds }),
      ).resolves.toMatchObject({ stepSeconds: 10, points: [] });
      expect(prometheus.range).toHaveBeenCalledWith(
        '(1 - sum(rate(node_cpu_seconds_total{job="node-exporter",host_role!="worker",mode="idle"}[1m])) / sum(rate(node_cpu_seconds_total{job="node-exporter",host_role!="worker"}[1m]))) and on() (count(node_cpu_seconds_total{job="node-exporter",host_role!="worker",mode="idle"} offset 1m))',
        from,
        to,
        10,
      );
    },
  );

  it.each([9, 10.5, 301, NaN])(
    'rejects invalid timeseries step %s',
    async (stepSeconds) => {
      const { controller, prometheus } = createController();
      await expect(
        controller.timeseries({
          metric: 'host_cpu',
          from: '2026-10-04T12:00:00Z',
          to: '2026-10-04T12:15:00Z',
          stepSeconds,
        }),
      ).rejects.toThrow('stepSeconds');
      expect(prometheus.range).not.toHaveBeenCalled();
    },
  );

  it('preserves the metric whitelist and 24-hour range cap', async () => {
    const { controller, prometheus } = createController();
    await expect(
      controller.timeseries({
        metric: 'arbitrary_query',
        from: '2026-10-04T12:00:00Z',
        to: '2026-10-04T12:15:00Z',
      }),
    ).rejects.toThrow('metric must be');
    await expect(
      controller.timeseries({
        metric: 'cpu',
        from: '2026-10-02T12:00:00Z',
        to: '2026-10-04T12:15:00Z',
      }),
    ).rejects.toThrow('24 hours');
    expect(prometheus.range).not.toHaveBeenCalled();
  });
});

describe('SystemMetricsController multi-host', () => {
  const NODE_2 = {
    id: 'velora-node-2',
    label: 'velora-node-2',
    role: 'worker',
    containers: 'remote',
    dockerEndpoint: { host: '100.86.68.16', port: 2375 },
  };

  const createController = (
    options: { docker?: Record<string, jest.Mock>; host?: unknown } = {},
  ) => {
    const prometheus = {
      scalar: jest.fn().mockResolvedValue(0),
      vector: jest.fn().mockResolvedValue([]),
      range: jest.fn().mockResolvedValue([]),
    };
    const metrics = { recordRpc: jest.fn() };
    const docker = options.docker ?? {
      snapshot: jest.fn().mockResolvedValue([]),
      snapshotMetadata: jest.fn().mockResolvedValue(null),
    };
    const hosts = {
      list: jest.fn().mockResolvedValue([
        { id: 'home', role: 'primary', network: 'unavailable' },
        { id: 'node-2', role: 'worker', network: 'host' },
      ]),
      require: jest.fn((id: string) =>
        id === NODE_2.id
          ? Promise.resolve(options.host ?? NODE_2)
          : Promise.reject(
              new RpcException({
                statusCode: 404,
                message: `Unknown host "${id}"`,
              }),
            ),
      ),
    };
    const controller = new SystemMetricsController(
      prometheus as never,
      metrics as never,
      docker as never,
      hosts as never,
    );
    return { controller, prometheus, docker, hosts, metrics };
  };

  const range = {
    from: '2026-10-04T12:00:00.000Z',
    to: '2026-10-04T12:15:00.000Z',
  };

  it('queries host history for the requested host only', async () => {
    const { controller, prometheus } = createController();

    await expect(
      controller.timeseries({
        metric: 'host_memory',
        host: NODE_2.id,
        ...range,
      }),
    ).resolves.toMatchObject({ metric: 'host_memory', host: NODE_2.id });

    const [query] = prometheus.range.mock.calls[0];
    expect(query).toContain('host="velora-node-2"');
    expect(query).not.toContain('host_role');
  });

  it('serves the new network metrics for a host', async () => {
    const { controller, prometheus } = createController();

    await controller.timeseries({
      metric: 'host_network_receive',
      host: NODE_2.id,
      ...range,
    });

    expect(prometheus.range.mock.calls[0][0]).toContain(
      'node_network_receive_bytes_total{job="node-exporter",host="velora-node-2"',
    );
  });

  it('refuses network history for a host whose exporter cannot see the machine NICs', async () => {
    const { controller, prometheus } = createController({
      host: { ...NODE_2, network: 'unavailable' },
    });

    await expect(
      controller.timeseries({
        metric: 'host_network_transmit',
        host: NODE_2.id,
        ...range,
      }),
    ).rejects.toMatchObject({
      error: {
        statusCode: 400,
        message: expect.stringContaining('network metrics are not available'),
      },
    });
    expect(prometheus.range).not.toHaveBeenCalled();
  });

  it('applies the same rule to the primary host when no host is given', async () => {
    const { controller, prometheus } = createController();

    // The registry above lists the primary ("home") without network visibility.
    await expect(
      controller.timeseries({ metric: 'host_network_receive', ...range }),
    ).rejects.toMatchObject({ error: { statusCode: 400 } });
    await expect(
      controller.timeseries({ metric: 'host_disk', ...range }),
    ).resolves.toMatchObject({ metric: 'host_disk' });
    expect(prometheus.range).toHaveBeenCalledTimes(1);
  });

  it('answers host metrics without a host from the primary machine', async () => {
    const { controller, prometheus, hosts } = createController();

    await controller.timeseries({ metric: 'host_disk', ...range });

    expect(hosts.require).not.toHaveBeenCalled();
    expect(prometheus.range.mock.calls[0][0]).toContain(
      'job="node-exporter",host_role!="worker"',
    );
  });

  it('rejects an unknown host as a client error', async () => {
    const { controller, prometheus } = createController();

    await expect(
      controller.timeseries({ metric: 'host_cpu', host: 'nope', ...range }),
    ).rejects.toMatchObject({ error: { statusCode: 404 } });
    expect(prometheus.range).not.toHaveBeenCalled();
  });

  it.each(['bad host', 'x"} or vector(1) #', 42])(
    'rejects the malformed host %p before any query',
    async (host) => {
      const { controller, prometheus, hosts } = createController();

      await expect(
        controller.timeseries({ metric: 'host_cpu', host, ...range }),
      ).rejects.toMatchObject({
        error: { statusCode: 400, message: 'host is invalid' },
      });
      expect(hosts.require).not.toHaveBeenCalled();
      expect(prometheus.range).not.toHaveBeenCalled();
    },
  );

  it('does not accept a host for a service metric', async () => {
    const { controller } = createController();

    await expect(
      controller.timeseries({ metric: 'cpu', host: NODE_2.id, ...range }),
    ).rejects.toMatchObject({
      error: { message: 'host is only supported for host_* metrics' },
    });
  });

  it('reads the containers of a remote host through its Docker endpoint', async () => {
    const docker = {
      snapshotWithCoverage: jest.fn().mockResolvedValue({
        containers: [{ service: 'mongo-replica' }],
        runningContainers: 1,
        sampledContainers: 1,
      }),
      snapshotMetadata: jest.fn().mockResolvedValue({
        hostCpuCount: 4,
        storage: { imagesBytes: 1, volumesBytes: 2, buildCacheBytes: 3 },
      }),
    };
    const { controller } = createController({ docker });

    await expect(
      controller.containers({ host: NODE_2.id }),
    ).resolves.toMatchObject({
      dockerEngineUp: true,
      hostCpuCount: 4,
      runningContainers: 1,
      containers: [{ service: 'mongo-replica' }],
    });
    expect(docker.snapshotWithCoverage).toHaveBeenCalledWith({
      host: '100.86.68.16',
      port: 2375,
    });
    expect(docker.snapshotMetadata).toHaveBeenCalledWith({
      host: '100.86.68.16',
      port: 2375,
    });
  });

  it('uses the local socket for the primary host', async () => {
    const docker = {
      snapshot: jest.fn().mockResolvedValue([]),
      snapshotMetadata: jest.fn().mockResolvedValue(null),
    };
    const { controller } = createController({
      docker,
      host: {
        ...NODE_2,
        role: 'primary',
        containers: 'local',
        dockerEndpoint: null,
      },
    });

    await controller.containers({ host: NODE_2.id });

    expect(docker.snapshot).toHaveBeenCalledWith(undefined);
  });

  it('says so when a host has no container access instead of reporting an outage', async () => {
    const { controller, docker } = createController({
      host: { ...NODE_2, containers: 'none', dockerEndpoint: null },
    });

    await expect(controller.containers({ host: NODE_2.id })).resolves.toEqual({
      generatedAt: expect.any(String),
      source: 'docker',
      dockerEngineUp: null,
      containers: [],
      reason: 'not-configured',
    });
    expect(docker.snapshot).not.toHaveBeenCalled();
  });

  it('reports an unreachable remote Docker API without failing the RPC', async () => {
    const docker = {
      snapshot: jest.fn().mockRejectedValue(new Error('connect ETIMEDOUT')),
      snapshotMetadata: jest.fn().mockResolvedValue(null),
    };
    const { controller } = createController({ docker });

    await expect(
      controller.containers({ host: NODE_2.id }),
    ).resolves.toMatchObject({
      dockerEngineUp: false,
      containers: [],
    });
  });

  it('shares one container sampling between concurrent viewers of the same host', async () => {
    const docker = {
      snapshot: jest.fn().mockResolvedValue([]),
      snapshotMetadata: jest.fn().mockResolvedValue(null),
    };
    const { controller } = createController({ docker });

    await Promise.all([
      controller.containers({ host: NODE_2.id }),
      controller.containers({ host: NODE_2.id }),
    ]);

    expect(docker.snapshot).toHaveBeenCalledTimes(1);
  });

  it('adds the fleet size to the lightweight status', async () => {
    const { controller, prometheus } = createController();
    prometheus.scalar.mockResolvedValueOnce(1).mockResolvedValueOnce(1);
    prometheus.vector.mockResolvedValue([
      { metric: { host: 'home' }, timestamp: 1, value: 1 },
      {
        metric: { host: 'node-2', host_role: 'worker' },
        timestamp: 1,
        value: 0,
      },
    ]);

    await expect(controller.status()).resolves.toMatchObject({
      monitoringUp: true,
      hostUp: true,
      hosts: { total: 2, up: 1 },
    });
    expect(prometheus.scalar.mock.calls[1][0]).toBe(
      'max(up{job="node-exporter",host_role!="worker"})',
    );
  });
});
