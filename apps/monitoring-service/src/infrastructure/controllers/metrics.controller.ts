import { Controller, Get, Res } from '@nestjs/common';
import type { Response } from 'express';
import { PrometheusMetricsService } from '../metrics/prometheus-metrics.service';

@Controller()
export class MetricsController {
  constructor(private readonly metrics: PrometheusMetricsService) {}

  @Get('metrics')
  getMetrics(@Res({ passthrough: true }) response: Response): string {
    response.setHeader('Content-Type', PrometheusMetricsService.CONTENT_TYPE);
    response.setHeader('Cache-Control', 'no-store');
    return this.metrics.metrics();
  }
}
