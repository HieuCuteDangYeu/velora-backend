import { RuntimePrometheusMetrics } from '@common/monitoring/runtime-prometheus-metrics';
import { Injectable } from '@nestjs/common';

@Injectable()
export class CallRuntimeMetricsService extends RuntimePrometheusMetrics {
  constructor() {
    super('call-service');
  }
}
