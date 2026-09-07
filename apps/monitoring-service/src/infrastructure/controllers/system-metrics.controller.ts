import { Controller } from '@nestjs/common';
import { MessagePattern, Payload, RpcException } from '@nestjs/microservices';
import { PrometheusMetricsService } from '../metrics/prometheus-metrics.service';
import { PrometheusQueryService } from '../services/prometheus-query.service';

const RANGE_QUERIES = {
  memory: 'max(velora_process_resident_memory_bytes{service="monitoring-service"})',
  heap: 'max(velora_process_heap_used_bytes{service="monitoring-service"})',
  cpu: 'sum(rate(velora_process_cpu_user_seconds_total{service="monitoring-service"}[5m])) + sum(rate(velora_process_cpu_system_seconds_total{service="monitoring-service"}[5m]))',
  rpc_rate: 'sum(rate(velora_monitoring_rpc_requests_total[5m]))',
  error_rate:
    'sum(rate(velora_monitoring_rpc_requests_total{status="error"}[5m])) / clamp_min(sum(rate(velora_monitoring_rpc_requests_total[5m])), 0.000001)',
  p95_rpc_latency:
    'histogram_quantile(0.95, sum by (le) (rate(velora_monitoring_rpc_duration_seconds_bucket[5m])))',
  event_loop_p99:
    'max(velora_nodejs_event_loop_lag_p99_seconds{service="monitoring-service"})',
  host_cpu:
    '1 - avg(rate(node_cpu_seconds_total{job="node-exporter",mode="idle"}[5m]))',
  host_memory:
    '1 - (max(node_memory_MemAvailable_bytes{job="node-exporter"}) / clamp_min(max(node_memory_MemTotal_bytes{job="node-exporter"}), 1))',
  host_swap:
    '(max(node_memory_SwapTotal_bytes{job="node-exporter"}) - max(node_memory_SwapFree_bytes{job="node-exporter"})) / clamp_min(max(node_memory_SwapTotal_bytes{job="node-exporter"}), 1)',
  host_disk:
    '1 - (max(node_filesystem_avail_bytes{job="node-exporter",mountpoint="/",fstype!~"tmpfs|overlay|squashfs"}) / clamp_min(max(node_filesystem_size_bytes{job="node-exporter",mountpoint="/",fstype!~"tmpfs|overlay|squashfs"}), 1))',
  host_load1: 'max(node_load1{job="node-exporter"})',
} as const;

type RangeMetric = keyof typeof RANGE_QUERIES;

type TimeseriesPayload = {
  metric?: unknown;
  from?: unknown;
  to?: unknown;
  stepSeconds?: unknown;
};

@Controller()
export class SystemMetricsController {
  constructor(
    private readonly prometheus: PrometheusQueryService,
    private readonly metrics: PrometheusMetricsService,
  ) {}

  @MessagePattern('system.metrics.overview')
  async overview() {
    return this.measure('system.metrics.overview', async () => {
      try {
        const [
          serviceUp,
          residentMemoryBytes,
          heapUsedBytes,
          cpuSecondsPerSecond,
          eventLoopP99Seconds,
          requestsPerSecond,
          errorRate,
          p95LatencySeconds,
          hostUp,
          hostCpuUsageRatio,
          hostMemoryTotalBytes,
          hostMemoryAvailableBytes,
          hostSwapTotalBytes,
          hostSwapFreeBytes,
          hostDiskTotalBytes,
          hostDiskAvailableBytes,
          hostLoad1,
          hostUptimeSeconds,
        ] = await Promise.all([
          this.prometheus.scalar('max(up{job="monitoring-service"})'),
          this.prometheus.scalar(RANGE_QUERIES.memory),
          this.prometheus.scalar(RANGE_QUERIES.heap),
          this.prometheus.scalar(RANGE_QUERIES.cpu),
          this.prometheus.scalar(RANGE_QUERIES.event_loop_p99),
          this.prometheus.scalar(RANGE_QUERIES.rpc_rate),
          this.prometheus.scalar(RANGE_QUERIES.error_rate),
          this.prometheus.scalar(RANGE_QUERIES.p95_rpc_latency),
          this.prometheus.scalar('max(up{job="node-exporter"})'),
          this.prometheus.scalar(RANGE_QUERIES.host_cpu),
          this.prometheus.scalar('max(node_memory_MemTotal_bytes{job="node-exporter"})'),
          this.prometheus.scalar('max(node_memory_MemAvailable_bytes{job="node-exporter"})'),
          this.prometheus.scalar('max(node_memory_SwapTotal_bytes{job="node-exporter"})'),
          this.prometheus.scalar('max(node_memory_SwapFree_bytes{job="node-exporter"})'),
          this.prometheus.scalar('max(node_filesystem_size_bytes{job="node-exporter",mountpoint="/",fstype!~"tmpfs|overlay|squashfs"})'),
          this.prometheus.scalar('max(node_filesystem_avail_bytes{job="node-exporter",mountpoint="/",fstype!~"tmpfs|overlay|squashfs"})'),
          this.prometheus.scalar(RANGE_QUERIES.host_load1),
          this.prometheus.scalar('max(time() - node_boot_time_seconds{job="node-exporter"})'),
        ]);

        const hostMemoryUsedBytes = Math.max(
          0,
          hostMemoryTotalBytes - hostMemoryAvailableBytes,
        );
        const hostSwapUsedBytes = Math.max(
          0,
          hostSwapTotalBytes - hostSwapFreeBytes,
        );
        const hostDiskUsedBytes = Math.max(
          0,
          hostDiskTotalBytes - hostDiskAvailableBytes,
        );

        return {
          generatedAt: new Date().toISOString(),
          source: 'prometheus' as const,
          host: {
            up: hostUp > 0,
            cpuUsageRatio: hostCpuUsageRatio,
            memoryTotalBytes: hostMemoryTotalBytes,
            memoryAvailableBytes: hostMemoryAvailableBytes,
            memoryUsedBytes: hostMemoryUsedBytes,
            memoryUsageRatio:
              hostMemoryTotalBytes > 0
                ? hostMemoryUsedBytes / hostMemoryTotalBytes
                : 0,
            swapTotalBytes: hostSwapTotalBytes,
            swapFreeBytes: hostSwapFreeBytes,
            swapUsedBytes: hostSwapUsedBytes,
            swapUsageRatio:
              hostSwapTotalBytes > 0 ? hostSwapUsedBytes / hostSwapTotalBytes : 0,
            diskTotalBytes: hostDiskTotalBytes,
            diskAvailableBytes: hostDiskAvailableBytes,
            diskUsedBytes: hostDiskUsedBytes,
            diskUsageRatio:
              hostDiskTotalBytes > 0 ? hostDiskUsedBytes / hostDiskTotalBytes : 0,
            load1: hostLoad1,
            uptimeSeconds: hostUptimeSeconds,
          },
          service: {
            up: serviceUp > 0,
          },
          process: {
            residentMemoryBytes,
            heapUsedBytes,
            cpuSecondsPerSecond,
            eventLoopP99Seconds,
          },
          rpc: {
            requestsPerSecond,
            errorRate,
            p95LatencySeconds,
          },
        };
      } catch (error) {
        throw this.prometheusError(error);
      }
    });
  }

  @MessagePattern('system.metrics.timeseries')
  async timeseries(@Payload() payload: TimeseriesPayload) {
    return this.measure('system.metrics.timeseries', async () => {
      const query = this.parseTimeseriesPayload(payload);

      try {
        const points = await this.prometheus.range(
          RANGE_QUERIES[query.metric],
          query.from,
          query.to,
          query.stepSeconds,
        );

        return {
          metric: query.metric,
          from: query.from,
          to: query.to,
          stepSeconds: query.stepSeconds,
          points,
        };
      } catch (error) {
        throw this.prometheusError(error);
      }
    });
  }

  private parseTimeseriesPayload(payload: TimeseriesPayload) {
    const metric = payload?.metric;
    const from = payload?.from;
    const to = payload?.to;
    const requestedStep = Number(payload?.stepSeconds ?? 60);

    if (
      typeof metric !== 'string' ||
      !Object.prototype.hasOwnProperty.call(RANGE_QUERIES, metric)
    ) {
      throw new RpcException({
        statusCode: 400,
        message: `metric must be one of: ${Object.keys(RANGE_QUERIES).join(', ')}`,
      });
    }

    if (typeof from !== 'string' || typeof to !== 'string') {
      throw new RpcException({
        statusCode: 400,
        message: 'from and to are required ISO timestamps',
      });
    }

    const fromMs = Date.parse(from);
    const toMs = Date.parse(to);
    if (!Number.isFinite(fromMs) || !Number.isFinite(toMs) || fromMs >= toMs) {
      throw new RpcException({
        statusCode: 400,
        message: 'from and to must define a valid increasing time range',
      });
    }

    if (toMs - fromMs > 24 * 60 * 60 * 1000) {
      throw new RpcException({
        statusCode: 400,
        message: 'monitoring timeseries range cannot exceed 24 hours',
      });
    }

    if (
      !Number.isInteger(requestedStep) ||
      requestedStep < 15 ||
      requestedStep > 300
    ) {
      throw new RpcException({
        statusCode: 400,
        message: 'stepSeconds must be an integer between 15 and 300',
      });
    }

    return {
      metric: metric as RangeMetric,
      from,
      to,
      stepSeconds: requestedStep,
    };
  }

  private prometheusError(error: unknown) {
    const message = error instanceof Error ? error.message : 'Prometheus query failed';
    return new RpcException({
      statusCode: 503,
      message,
    });
  }

  private async measure<T>(pattern: string, operation: () => Promise<T>): Promise<T> {
    const startedAt = process.hrtime.bigint();
    let status: 'success' | 'error' = 'success';

    try {
      return await operation();
    } catch (error) {
      status = 'error';
      throw error;
    } finally {
      const durationSeconds =
        Number(process.hrtime.bigint() - startedAt) / 1_000_000_000;
      this.metrics.recordRpc(pattern, status, durationSeconds);
    }
  }
}
