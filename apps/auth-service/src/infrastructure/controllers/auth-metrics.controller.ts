import { Controller, Get, Res } from '@nestjs/common';
import type { Response } from 'express';
import { AuthPrometheusMetricsService } from '../metrics/auth-prometheus-metrics.service';

@Controller()
export class AuthMetricsController {
  constructor(private readonly metrics: AuthPrometheusMetricsService) {}

  @Get('metrics')
  async getMetrics(@Res({ passthrough: true }) response: Response) {
    response.setHeader(
      'Content-Type',
      AuthPrometheusMetricsService.CONTENT_TYPE,
    );
    response.setHeader('Cache-Control', 'no-store');
    return this.metrics.metrics();
  }
}
