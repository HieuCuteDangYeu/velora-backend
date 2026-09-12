import { SystemMetricsController } from './system-metrics.controller';

describe('SystemMetricsController container resources', () => {
  const prometheus = {
    scalar: jest.fn(),
    vector: jest.fn(),
  };
  const metrics = { recordRpc: jest.fn() };
  const docker = { snapshot: jest.fn() };
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

  it('returns lightweight target status for the global live indicator', async () => {
    prometheus.scalar.mockResolvedValueOnce(1).mockResolvedValueOnce(0);

    await expect(controller.status()).resolves.toMatchObject({
      source: 'prometheus',
      monitoringUp: true,
      hostUp: false,
      generatedAt: expect.any(String),
    });
  });
});
