import { BadRequestException } from '@nestjs/common';
import { of } from 'rxjs';

import { MonitoringController } from './monitoring.controller';

describe('MonitoringController', () => {
  const createController = () => {
    const monitoringClient = {
      send: jest.fn(() => of({ points: [] })),
    };

    return {
      controller: new MonitoringController(monitoringClient as never),
      monitoringClient,
    };
  };

  it.each([
    'rag_request_rate',
    'rag_total_token_rate',
    'reel_queued',
    'reel_media_queue_wait_p95',
    'reel_index_chunk_rate',
  ])('forwards the monitoring metric %s', async (metric) => {
    const { controller, monitoringClient } = createController();

    await expect(
      controller.timeseries({
        query: {
          metric,
          from: '2026-09-22T12:00:00.000Z',
          to: '2026-09-22T13:00:00.000Z',
          stepSeconds: '60',
        },
      } as never),
    ).resolves.toEqual({ points: [] });

    expect(monitoringClient.send).toHaveBeenCalledWith(
      'system.metrics.timeseries',
      expect.objectContaining({ metric }),
    );
  });

  it('rejects an unknown metric', () => {
    const { controller } = createController();

    expect(() =>
      controller.timeseries({
        query: {
          metric: 'not_a_metric',
          from: '2026-09-22T12:00:00.000Z',
          to: '2026-09-22T13:00:00.000Z',
        },
      } as never),
    ).toThrow(BadRequestException);
  });
});
