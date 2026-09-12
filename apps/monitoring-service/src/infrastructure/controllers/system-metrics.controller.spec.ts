import { SystemMetricsController } from './system-metrics.controller';

describe('SystemMetricsController container resources', () => {
  const prometheus = {
    scalar: jest.fn(),
    vector: jest.fn(),
  };
  const metrics = { recordRpc: jest.fn() };
  const controller = new SystemMetricsController(
    prometheus as never,
    metrics as never,
  );

  beforeEach(() => {
    jest.resetAllMocks();
  });

  it('joins cAdvisor vectors by service and container and sorts by memory', async () => {
    prometheus.vector.mockImplementation((query: string) => {
      if (query.includes('container_cpu_usage_seconds_total')) {
        return [
          {
            metric: { service: 'api-gateway', container: 'gateway-1' },
            timestamp: 1720000000,
            value: 0.25,
          },
          {
            metric: {
              service: 'monitoring-service',
              container: 'monitoring-1',
            },
            timestamp: 1720000000,
            value: 0.05,
          },
        ];
      }
      if (query.includes('container_memory_working_set_bytes')) {
        return [
          {
            metric: {
              service: 'monitoring-service',
              container: 'monitoring-1',
            },
            timestamp: 1720000000,
            value: 400,
          },
          {
            metric: { service: 'api-gateway', container: 'gateway-1' },
            timestamp: 1720000000,
            value: 200,
          },
        ];
      }
      if (query.includes('container_spec_memory_limit_bytes')) {
        return [
          {
            metric: {
              service: 'monitoring-service',
              container: 'monitoring-1',
            },
            timestamp: 1720000000,
            value: Number.MAX_SAFE_INTEGER + 1,
          },
          {
            metric: { service: 'api-gateway', container: 'gateway-1' },
            timestamp: 1720000000,
            value: 1000,
          },
        ];
      }
      return [
        {
          metric: { service: 'api-gateway', container: 'gateway-1' },
          timestamp: 1720000000,
          value: 80,
        },
      ];
    });

    await expect(controller.containers()).resolves.toEqual({
      generatedAt: expect.any(String),
      source: 'cadvisor',
      containers: [
        {
          service: 'monitoring-service',
          container: 'monitoring-1',
          cpuCores: 0.05,
          memoryWorkingSetBytes: 400,
          memoryLimitBytes: null,
          filesystemUsageBytes: null,
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

    expect(prometheus.vector).toHaveBeenCalledTimes(4);
    expect(metrics.recordRpc).toHaveBeenCalledWith(
      'system.metrics.containers',
      'success',
      expect.any(Number),
    );
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
