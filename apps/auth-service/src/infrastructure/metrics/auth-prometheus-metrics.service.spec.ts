import { AuthPrometheusMetricsService } from './auth-prometheus-metrics.service';

describe('AuthPrometheusMetricsService', () => {
  const createMetrics = () =>
    new AuthPrometheusMetricsService(
      { $queryRaw: jest.fn().mockResolvedValue([{ '?column?': 1 }]) } as never,
      { ping: jest.fn().mockResolvedValue('PONG') } as never,
    );

  it('exports every operation and outcome at zero before any request', async () => {
    const metrics = createMetrics();

    const output = await metrics.metrics();

    // rate() over a series that does not exist yet is empty, so an error rate with no
    // errors would show no data instead of 0 after each restart.
    for (const operation of ['login', 'refresh', 'logout', 'verify_token']) {
      for (const outcome of ['success', 'rejected', 'error']) {
        expect(output).toContain(
          `velora_auth_requests_total{service="auth-service",operation="${operation}",outcome="${outcome}"} 0`,
        );
      }
    }
    expect(output.match(/^velora_auth_requests_total\{/gm)?.length).toBe(
      13 * 3,
    );

    metrics.onModuleDestroy();
  });

  it('counts a request on top of its seeded zero and keeps the other series', async () => {
    const metrics = createMetrics();
    metrics.recordRequest('login', 'success', 0.05);
    metrics.recordRequest('login', 'success', 0.06);
    metrics.recordRequest('refresh', 'rejected', 0.01);

    const output = await metrics.metrics();

    expect(output).toContain(
      'velora_auth_requests_total{service="auth-service",operation="login",outcome="success"} 2',
    );
    expect(output).toContain(
      'velora_auth_requests_total{service="auth-service",operation="refresh",outcome="rejected"} 1',
    );
    expect(output).toContain(
      'velora_auth_requests_total{service="auth-service",operation="login",outcome="error"} 0',
    );
    expect(output.match(/^velora_auth_requests_total\{/gm)?.length).toBe(
      13 * 3,
    );

    metrics.onModuleDestroy();
  });
});
