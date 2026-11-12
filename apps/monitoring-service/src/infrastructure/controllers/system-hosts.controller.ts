import { Controller } from '@nestjs/common';
import { MessagePattern, Payload, RpcException } from '@nestjs/microservices';
import { PrometheusMetricsService } from '../metrics/prometheus-metrics.service';
import {
  HOST_TIMESERIES_METRICS,
  HOST_TIMESERIES_METRIC_SET,
  hostTimeseriesQuery,
  NODE_EXPORTER_JOB,
  type HostTimeseriesMetric,
} from '../services/host-queries';
import { HostMetricsService } from '../services/host-metrics.service';
import { HostRegistryService } from '../services/host-registry.service';
import { PrometheusQueryService } from '../services/prometheus-query.service';
import { parseTimeRange, type TimeRangePayload } from '../services/time-range';

type HostHistoryPayload = TimeRangePayload & { metric?: unknown };

@Controller()
export class SystemHostsController {
  constructor(
    private readonly hostMetrics: HostMetricsService,
    private readonly registry: HostRegistryService,
    private readonly prometheus: PrometheusQueryService,
    private readonly metrics: PrometheusMetricsService,
  ) {}

  /** Every monitored VPS with its current CPU, memory, disk, load and traffic. */
  @MessagePattern('system.hosts.list')
  async list() {
    return this.measure('system.hosts.list', async () => {
      try {
        return await this.hostMetrics.fleet();
      } catch (error) {
        throw this.prometheusError(error);
      }
    });
  }

  /** One series per host for a host metric, e.g. CPU sparklines for the fleet. */
  @MessagePattern('system.hosts.history')
  async history(@Payload() payload: HostHistoryPayload) {
    return this.measure('system.hosts.history', async () => {
      const metric = payload?.metric;
      if (
        typeof metric !== 'string' ||
        !HOST_TIMESERIES_METRIC_SET.has(metric)
      ) {
        throw new RpcException({
          statusCode: 400,
          message: `metric must be one of: ${HOST_TIMESERIES_METRICS.join(', ')}`,
        });
      }

      const range = parseTimeRange(payload);

      try {
        const [hosts, series] = await Promise.all([
          this.registry.list(),
          this.prometheus.rangeSeries(
            hostTimeseriesQuery(
              metric as HostTimeseriesMetric,
              NODE_EXPORTER_JOB,
              true,
            ),
            range.from,
            range.to,
            range.stepSeconds,
          ),
        ]);
        const idByLabel = new Map(hosts.map((host) => [host.label, host.id]));

        return {
          metric,
          ...range,
          series: series.flatMap((item) => {
            const id = idByLabel.get(item.metric.host ?? '');
            return id === undefined ? [] : [{ host: id, points: item.points }];
          }),
        };
      } catch (error) {
        throw this.prometheusError(error);
      }
    });
  }

  private prometheusError(error: unknown) {
    const message =
      error instanceof Error ? error.message : 'Prometheus query failed';
    return new RpcException({ statusCode: 503, message });
  }

  private async measure<T>(
    pattern: string,
    operation: () => Promise<T>,
  ): Promise<T> {
    const startedAt = process.hrtime.bigint();
    let status: 'success' | 'error' = 'success';

    try {
      return await operation();
    } catch (error) {
      status = 'error';
      throw error;
    } finally {
      this.metrics.recordRpc(
        pattern,
        status,
        Number(process.hrtime.bigint() - startedAt) / 1_000_000_000,
      );
    }
  }
}
