import { Controller, Get, Inject, Logger, Res } from '@nestjs/common';
import type { Response } from 'express';
import { ICallMediaEngine } from '../../domain/interfaces/call-media.engine.interface';
import { safeCallErrorCode } from '../gateways/call-debug';
import { CallGateway } from '../gateways/call.gateway';
import { CallPrometheusMetricsService } from '../metrics/call-prometheus-metrics.service';

@Controller()
export class CallMetricsController {
  private readonly logger = new Logger(CallMetricsController.name);

  constructor(
    private readonly metrics: CallPrometheusMetricsService,
    private readonly callGateway: CallGateway,
    @Inject('ICallMediaEngine') private readonly mediaEngine: ICallMediaEngine,
  ) {}

  @Get('metrics')
  async getMetrics(
    @Res({ passthrough: true }) response: Response,
  ): Promise<string> {
    response.setHeader(
      'Content-Type',
      CallPrometheusMetricsService.CONTENT_TYPE,
    );
    response.setHeader('Cache-Control', 'no-store');

    const activeSocketConnections =
      this.callGateway.server?.engine?.clientsCount ?? 0;

    // Worker load is best effort: a failing worker must not blind the scrape.
    const mediaWorkers = await this.mediaEngine
      .getWorkerLoad()
      .catch((error) => {
        this.logger.warn(
          `Media worker load unavailable errorCode=${safeCallErrorCode(error)}`,
        );
        return [];
      });

    return this.metrics.metrics(activeSocketConnections, mediaWorkers);
  }
}
