import { PrometheusQueryService } from './prometheus-query.service';

describe('PrometheusQueryService vector queries', () => {
  const configService = {
    get: jest.fn((key: string) =>
      key === 'PROMETHEUS_URL' ? 'http://prometheus:9090' : undefined,
    ),
  };

  const withFetchMock = async (
    fetchMock: typeof fetch,
    run: () => Promise<void>,
  ) => {
    const descriptor = Object.getOwnPropertyDescriptor(global, 'fetch');
    Object.defineProperty(global, 'fetch', {
      configurable: true,
      value: fetchMock,
      writable: true,
    });

    try {
      await run();
    } finally {
      if (descriptor) {
        Object.defineProperty(global, 'fetch', descriptor);
      } else {
        delete (global as { fetch?: typeof fetch }).fetch;
      }
    }
  };

  it('returns finite samples and skips malformed instant-vector values', async () => {
    const fetchMock = jest.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          status: 'success',
          data: {
            result: [
              {
                metric: { service: 'api-gateway', container: 'gateway-1' },
                value: [1720000000, '0.25'],
              },
              {
                metric: { service: 'broken', container: 'broken-1' },
                value: [1720000000, 'NaN'],
              },
            ],
          },
        }),
        { headers: { 'Content-Type': 'application/json' } },
      ),
    );
    const service = new PrometheusQueryService(configService as never);

    await withFetchMock(fetchMock, async () => {
      await expect(
        service.vector('container_cpu_usage_seconds_total'),
      ).resolves.toEqual([
        {
          metric: { service: 'api-gateway', container: 'gateway-1' },
          timestamp: 1720000000,
          value: 0.25,
        },
      ]);
    });

    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringContaining(
        '/api/v1/query?query=container_cpu_usage_seconds_total',
      ),
      expect.objectContaining({ headers: { Accept: 'application/json' } }),
    );
  });
});
