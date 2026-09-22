import { Controller, Get, Res } from '@nestjs/common';
import type { Response } from 'express';
import { UserPrometheusMetricsService } from '../metrics/user-prometheus-metrics.service';

@Controller()
export class UserMetricsController {
  constructor(private readonly metrics: UserPrometheusMetricsService) {}

  @Get('metrics')
  async getMetrics(@Res({ passthrough: true }) response: Response) {
    response.setHeader(
      'Content-Type',
      UserPrometheusMetricsService.CONTENT_TYPE,
    );
    response.setHeader('Cache-Control', 'no-store');
    return this.metrics.metrics();
  }
}
