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
  it('sends bounded history and ten-second steps to Prometheus and filters non-finite values', async () => {
    const fetchMock = jest.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          status: 'success',
          data: {
            result: [
              {
                metric: {},
                values: [
                  [1, '0.5'],
                  [2, 'NaN'],
                  [3, '+Inf'],
                ],
              },
            ],
          },
        }),
      ),
    );
    const service = new PrometheusQueryService(configService as never);
    const from = '2026-10-04T12:00:00Z';
    const to = '2026-10-04T12:15:00Z';
    await withFetchMock(fetchMock, async () => {
      await expect(
        service.range('rate(counter[1m])', from, to, 10),
      ).resolves.toEqual([{ timestamp: 1, value: 0.5 }]);
    });
    const url = new URL(fetchMock.mock.calls[0][0] as string);
    expect(url.pathname).toBe('/api/v1/query_range');
    expect(Object.fromEntries(url.searchParams)).toEqual({
      query: 'rate(counter[1m])',
      start: from,
      end: to,
      step: '10',
    });
  });

  it('uses the existing four-second query timeout and surfaces transport failures', async () => {
    const timeout = jest.spyOn(AbortSignal, 'timeout');
    const service = new PrometheusQueryService(configService as never);
    const fetchMock = jest.fn().mockRejectedValue(new Error('timeout'));
    try {
      await withFetchMock(fetchMock, async () => {
        await expect(service.scalar('up')).rejects.toThrow(
          'Prometheus request failed: timeout',
        );
      });
      expect(timeout).toHaveBeenCalledWith(4000);
    } finally {
      timeout.mockRestore();
    }
  });

  it.each([
    [
      503,
      { status: 'success', data: { result: [] } },
      'Prometheus returned HTTP 503',
    ],
    [
      200,
      { status: 'error', error: 'invalid query' },
      'Prometheus query failed: invalid query',
    ],
  ])(
    'surfaces upstream errors (HTTP %s)',
    async (status, envelope, message) => {
      const service = new PrometheusQueryService(configService as never);
      const fetchMock = jest
        .fn()
        .mockResolvedValue(new Response(JSON.stringify(envelope), { status }));
      await withFetchMock(fetchMock, async () => {
        await expect(service.scalar('up')).rejects.toThrow(message);
      });
    },
  );
});
