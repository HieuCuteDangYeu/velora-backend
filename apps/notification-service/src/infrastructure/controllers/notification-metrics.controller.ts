import { Controller, Get, Res } from '@nestjs/common';
import type { Response } from 'express';

import { NotificationPrometheusMetricsService } from '../metrics/notification-prometheus-metrics.service';

@Controller()
export class NotificationMetricsController {
  constructor(private readonly metrics: NotificationPrometheusMetricsService) {}

  @Get('metrics')
  getMetrics(@Res({ passthrough: true }) response: Response): string {
    response.setHeader(
      'Content-Type',
      NotificationPrometheusMetricsService.CONTENT_TYPE,
    );
    response.setHeader('Cache-Control', 'no-store');
    return this.metrics.metrics();
  }
}
