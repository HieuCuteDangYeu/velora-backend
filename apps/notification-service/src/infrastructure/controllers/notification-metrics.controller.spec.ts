import { NotificationMetricsController } from './notification-metrics.controller';

describe('NotificationMetricsController', () => {
  it('serves Prometheus metrics without caching', () => {
    const metrics = { metrics: jest.fn().mockReturnValue('metric 1\n') };
    const controller = new NotificationMetricsController(metrics as never);
    const response = { setHeader: jest.fn() };

    expect(controller.getMetrics(response as never)).toBe('metric 1\n');
    expect(response.setHeader).toHaveBeenCalledWith(
      'Content-Type',
      'text/plain; version=0.0.4; charset=utf-8',
    );
    expect(response.setHeader).toHaveBeenCalledWith(
      'Cache-Control',
      'no-store',
    );
  });
});
