import { Controller, Get, Res } from '@nestjs/common';
import type { Response } from 'express';
import { CallGateway } from '../gateways/call.gateway';
import { CallRuntimeMetricsService } from '../metrics/call-runtime-metrics.service';

type SocketServerShape = {
  sockets?: Map<string, unknown> | { sockets?: Map<string, unknown> };
  of?: (namespace: string) => { sockets?: Map<string, unknown> };
};

@Controller()
export class CallMetricsController {
  constructor(
    private readonly metrics: CallRuntimeMetricsService,
    private readonly gateway: CallGateway,
  ) {}

  @Get('metrics')
  getMetrics(@Res({ passthrough: true }) response: Response): string {
    response.setHeader('Content-Type', CallRuntimeMetricsService.CONTENT_TYPE);
    response.setHeader('Cache-Control', 'no-store');
    return this.metrics.metrics(this.socketConnections());
  }

  private socketConnections(): number | null {
    const server = this.gateway.server as unknown as SocketServerShape | undefined;
    if (!server) return null;
    if (server.sockets instanceof Map) return server.sockets.size;
    if (server.sockets?.sockets instanceof Map) return server.sockets.sockets.size;
    const namespace = server.of?.('/call');
    return namespace?.sockets instanceof Map ? namespace.sockets.size : null;
  }
}
