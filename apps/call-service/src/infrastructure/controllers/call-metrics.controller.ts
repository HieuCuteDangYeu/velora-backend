import { Controller, Get, Res } from '@nestjs/common';
import type { Response } from 'express';
import { CallGateway } from '../gateways/call.gateway';
import { CallPrometheusMetricsService } from '../metrics/call-prometheus-metrics.service';

@Controller()
export class CallMetricsController {
  constructor(
    private readonly metrics: CallPrometheusMetricsService,
    private readonly callGateway: CallGateway,
  ) {}

  @Get('metrics')
  getMetrics(@Res({ passthrough: true }) response: Response): string {
    response.setHeader(
      'Content-Type',
      CallPrometheusMetricsService.CONTENT_TYPE,
    );
    response.setHeader('Cache-Control', 'no-store');

    const activeSocketConnections =
      this.callGateway.server?.engine?.clientsCount ?? 0;

    return this.metrics.metrics(activeSocketConnections);
  }
}
