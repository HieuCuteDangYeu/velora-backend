import { Controller, Get, Res } from '@nestjs/common';
import type { Response } from 'express';
import { ChatGateway } from '../gateways/chat.gateway';
import { ConversationRuntimeMetricsService } from '../metrics/conversation-runtime-metrics.service';

@Controller()
export class ConversationMetricsController {
  constructor(
    private readonly metrics: ConversationRuntimeMetricsService,
    private readonly gateway: ChatGateway,
  ) {}

  @Get('metrics')
  getMetrics(@Res({ passthrough: true }) response: Response): string {
    response.setHeader('Content-Type', ConversationRuntimeMetricsService.CONTENT_TYPE);
    response.setHeader('Cache-Control', 'no-store');
    const sockets = this.gateway.server?.sockets?.sockets;
    return this.metrics.metrics(sockets instanceof Map ? sockets.size : null);
  }
}
