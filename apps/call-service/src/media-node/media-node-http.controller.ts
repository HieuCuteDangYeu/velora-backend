import { Controller, Get, Logger, Res } from '@nestjs/common';
import type { Response } from 'express';
import { MediasoupCallMediaEngine } from '../infrastructure/engines/mediasoup-call.engine';
import { safeCallErrorCode } from '../infrastructure/gateways/call-debug';
import { CallPrometheusMetricsService } from '../infrastructure/metrics/call-prometheus-metrics.service';
import { MediaNodeIdentity } from './media-node-identity';

@Controller()
export class MediaNodeHttpController {
  private readonly logger = new Logger(MediaNodeHttpController.name);

  constructor(
    private readonly engine: MediasoupCallMediaEngine,
    private readonly metrics: CallPrometheusMetricsService,
    private readonly identity: MediaNodeIdentity,
  ) {}

  @Get('health')
  health() {
    return { status: 'ok', nodeId: this.identity.nodeId };
  }

  @Get('metrics')
  async getMetrics(
    @Res({ passthrough: true }) response: Response,
  ): Promise<string> {
    response.setHeader(
      'Content-Type',
      CallPrometheusMetricsService.CONTENT_TYPE,
    );
    response.setHeader('Cache-Control', 'no-store');
    const workers = await this.engine.getWorkerLoad().catch((error) => {
      this.logger.warn(
        `Media worker load unavailable errorCode=${safeCallErrorCode(error)}`,
      );
      return [];
    });
    return this.metrics.metrics(
      0,
      workers,
      this.engine.getPublicAddressStatus(),
    );
  }
}
