import { UserPrometheusMetricsService } from './user-prometheus-metrics.service';

describe('UserPrometheusMetricsService', () => {
  const createMetrics = () =>
    new UserPrometheusMetricsService({
      $queryRaw: jest.fn().mockResolvedValue([{ '?column?': 1 }]),
    } as never);

  it('exports every operation and outcome at zero before any request', async () => {
    const metrics = createMetrics();

    const output = await metrics.metrics();

    // rate() over a series that does not exist yet is empty, so an error rate with no
    // errors would show no data instead of 0 after each restart.
    for (const operation of [
      'create',
      'search',
      'recommendations',
      'find_by_id',
      'validate_list',
    ]) {
      for (const outcome of ['success', 'rejected', 'error']) {
        expect(output).toContain(
          `velora_user_requests_total{service="user-service",operation="${operation}",outcome="${outcome}"} 0`,
        );
      }
    }
    expect(output.match(/^velora_user_requests_total\{/gm)?.length).toBe(
      19 * 3,
    );

    metrics.onModuleDestroy();
  });

  it('counts a request on top of its seeded zero and keeps the other series', async () => {
    const metrics = createMetrics();
    metrics.recordRequest('search', 'success', 0.02);
    metrics.recordRequest('search', 'success', 0.03);
    metrics.recordRequest('create', 'error', 0.01);

    const output = await metrics.metrics();

    expect(output).toContain(
      'velora_user_requests_total{service="user-service",operation="search",outcome="success"} 2',
    );
    expect(output).toContain(
      'velora_user_requests_total{service="user-service",operation="create",outcome="error"} 1',
    );
    expect(output).toContain(
      'velora_user_requests_total{service="user-service",operation="search",outcome="error"} 0',
    );
    expect(output.match(/^velora_user_requests_total\{/gm)?.length).toBe(
      19 * 3,
    );
    // Latency histograms still appear only for observed requests.
    expect(output).toContain(
      'velora_user_request_duration_seconds_count{service="user-service",operation="search",outcome="success"} 2',
    );
    expect(output).not.toContain(
      'velora_user_request_duration_seconds_count{service="user-service",operation="delete"',
    );

    metrics.onModuleDestroy();
  });
});
