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
  let controller = new SystemMetricsController(
    prometheus as never,
    metrics as never,
    docker as never,
  );

  beforeEach(() => {
    jest.resetAllMocks();
    controller = new SystemMetricsController(
      prometheus as never,
      metrics as never,
      docker as never,
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
          query.includes(
            'count(node_cpu_seconds_total{job="node-exporter",mode="idle"})',
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
      range: jest.fn().mockResolvedValue([]),
    };
    const metrics = { recordRpc: jest.fn() };
    const controller = new SystemMetricsController(
      prometheus as never,
      metrics as never,
      { snapshotMetadata: jest.fn().mockResolvedValue(null) } as never,
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
    expect(queries).toHaveLength(130);
    expect(rates.length).toBeGreaterThan(50);
    expect(
      rates.every((query) => query.includes('[1m]') && !query.includes('[5m]')),
    ).toBe(true);
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
    expect(prometheus.scalar).toHaveBeenCalledTimes(130);
    resolveSample(1);
    const [a, b] = await Promise.all([first, second]);
    expect(a).toEqual(b);
    now += 4999;
    expect(await controller.overview()).toEqual(a);
    expect(prometheus.scalar).toHaveBeenCalledTimes(130);
    now += 1;
    await controller.overview();
    expect(prometheus.scalar).toHaveBeenCalledTimes(260);
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
    expect(prometheus.scalar).toHaveBeenCalledTimes(260);
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
    expect(prometheus.scalar).toHaveBeenCalledTimes(390);
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
        '1 - avg(rate(node_cpu_seconds_total{job="node-exporter",mode="idle"}[1m]))',
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
