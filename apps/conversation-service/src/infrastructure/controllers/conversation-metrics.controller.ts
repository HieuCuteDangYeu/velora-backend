import { Controller, Get, Res } from '@nestjs/common';
import type { Response } from 'express';
import { ChatGateway } from '../gateways/chat.gateway';
import { ConversationPrometheusMetricsService } from '../metrics/conversation-prometheus-metrics.service';

@Controller()
export class ConversationMetricsController {
  constructor(
    private readonly metrics: ConversationPrometheusMetricsService,
    private readonly chatGateway: ChatGateway,
  ) {}

  @Get('metrics')
  getMetrics(@Res({ passthrough: true }) response: Response): string {
    response.setHeader(
      'Content-Type',
      ConversationPrometheusMetricsService.CONTENT_TYPE,
    );
    response.setHeader('Cache-Control', 'no-store');

    const activeSocketConnections =
      this.chatGateway.server?.engine?.clientsCount ?? 0;

    return this.metrics.metrics(activeSocketConnections);
  }
}
