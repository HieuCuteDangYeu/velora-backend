import { SystemMetricsController } from './system-metrics.controller';

describe('SystemMetricsController container resources', () => {
  const prometheus = {
    scalar: jest.fn(),
    vector: jest.fn(),
  };
  const metrics = { recordRpc: jest.fn() };
  const docker = {
    snapshot: jest.fn(),
    snapshotMetadata: jest.fn().mockResolvedValue(null),
  };
  const controller = new SystemMetricsController(
    prometheus as never,
    metrics as never,
    docker as never,
  );

  beforeEach(() => {
    jest.resetAllMocks();
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

    expect(processCpuQueries).toHaveLength(4);
    expect(
      processCpuQueries.every(
        (query) =>
          query.includes(
            'count(node_cpu_seconds_total{job="node-exporter",mode="idle"})',
          ) && query.includes('/ clamp_min('),
      ),
    ).toBe(true);

    expect(prometheus.scalar.mock.calls.map(([query]) => query)).toEqual(
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
