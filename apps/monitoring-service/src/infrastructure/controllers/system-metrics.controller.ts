import { Controller } from '@nestjs/common';
import { MessagePattern, Payload, RpcException } from '@nestjs/microservices';
import { PrometheusMetricsService } from '../metrics/prometheus-metrics.service';
import { PrometheusQueryService } from '../services/prometheus-query.service';

const RANGE_QUERIES = {
  memory: 'max(velora_process_resident_memory_bytes{service="monitoring-service"})',
  heap: 'max(velora_process_heap_used_bytes{service="monitoring-service"})',
  cpu: 'sum(rate(velora_process_cpu_user_seconds_total{service="monitoring-service"}[5m])) + sum(rate(velora_process_cpu_system_seconds_total{service="monitoring-service"}[5m]))',
  rpc_rate: 'sum(rate(velora_monitoring_rpc_requests_total[5m]))',
  error_rate: 'sum(rate(velora_monitoring_rpc_requests_total{status="error"}[5m])) / clamp_min(sum(rate(velora_monitoring_rpc_requests_total[5m])), 0.000001)',
  p95_rpc_latency: 'histogram_quantile(0.95, sum by (le) (rate(velora_monitoring_rpc_duration_seconds_bucket[5m])))',
  event_loop_p99: 'max(velora_nodejs_event_loop_lag_p99_seconds{service="monitoring-service"})',
  host_cpu: '1 - avg(rate(node_cpu_seconds_total{job="node-exporter",mode="idle"}[5m]))',
  host_memory: '1 - (node_memory_MemAvailable_bytes{job="node-exporter"} / node_memory_MemTotal_bytes{job="node-exporter"})',
  host_swap: '(node_memory_SwapTotal_bytes{job="node-exporter"} - node_memory_SwapFree_bytes{job="node-exporter"}) / clamp_min(node_memory_SwapTotal_bytes{job="node-exporter"}, 1)',
  host_disk: '(node_filesystem_size_bytes{job="node-exporter",mountpoint="/",fstype!~"tmpfs|overlay|squashfs"} - node_filesystem_avail_bytes{job="node-exporter",mountpoint="/",fstype!~"tmpfs|overlay|squashfs"}) / clamp_min(node_filesystem_size_bytes{job="node-exporter",mountpoint="/",fstype!~"tmpfs|overlay|squashfs"}, 1)',
  host_load1: 'node_load1{job="node-exporter"}',
  conversation_cpu: 'sum(rate(velora_process_cpu_user_seconds_total{service="conversation-service"}[5m])) + sum(rate(velora_process_cpu_system_seconds_total{service="conversation-service"}[5m]))',
  conversation_memory: 'max(velora_process_resident_memory_bytes{service="conversation-service"})',
  conversation_event_loop_p99: 'max(velora_nodejs_event_loop_lag_p99_seconds{service="conversation-service"})',
  conversation_sockets: 'max(velora_realtime_socket_connections{service="conversation-service"})',
  conversation_message_rate: 'sum(rate(velora_conversation_messages_total{service="conversation-service"}[5m]))',
  conversation_send_rate: 'sum(rate(velora_conversation_send_requests_total{service="conversation-service"}[5m]))',
  conversation_success_rate: 'sum(rate(velora_conversation_send_requests_total{service="conversation-service",status="success"}[5m])) / clamp_min(sum(rate(velora_conversation_send_requests_total{service="conversation-service"}[5m])), 0.000001)',
  conversation_reject_rate: null,
  conversation_error_rate: 'sum(rate(velora_conversation_send_requests_total{service="conversation-service",status="error"}[5m])) / clamp_min(sum(rate(velora_conversation_send_requests_total{service="conversation-service"}[5m])), 0.000001)',
  conversation_p95_send_latency: 'histogram_quantile(0.95, sum by (le) (rate(velora_conversation_send_duration_seconds_bucket{service="conversation-service"}[5m])))',
  call_cpu: 'sum(rate(velora_process_cpu_user_seconds_total{service="call-service"}[5m])) + sum(rate(velora_process_cpu_system_seconds_total{service="call-service"}[5m]))',
  call_memory: 'max(velora_process_resident_memory_bytes{service="call-service"})',
  call_event_loop_p99: 'max(velora_nodejs_event_loop_lag_p99_seconds{service="call-service"})',
  call_sockets: 'max(velora_realtime_socket_connections{service="call-service"})',
} as const;

type RangeMetric = keyof typeof RANGE_QUERIES;
type TimeseriesPayload = { metric?: unknown; from?: unknown; to?: unknown; stepSeconds?: unknown };

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
        const scalar = (query: string) => this.prometheus.scalarNullable(query);
        const [
          hostUp, hostCpu, memTotal, memAvailable, swapTotal, swapFree,
          diskTotal, diskAvailable, load1, hostUptime,
          serviceUp, residentMemoryBytes, heapUsedBytes, cpuSecondsPerSecond,
          eventLoopP99Seconds, requestsPerSecond, rpcErrorRate, p95LatencySeconds,
          conversationUp, conversationMemory, conversationCpu, conversationLoop,
          conversationSockets, messageRate, sendRate, successRate, conversationErrorRate,
          conversationP95, callUp, callMemory, callCpu, callLoop, callSockets,
        ] = await Promise.all([
          scalar('max(up{job="node-exporter"})'),
          scalar(RANGE_QUERIES.host_cpu),
          scalar('node_memory_MemTotal_bytes{job="node-exporter"}'),
          scalar('node_memory_MemAvailable_bytes{job="node-exporter"}'),
          scalar('node_memory_SwapTotal_bytes{job="node-exporter"}'),
          scalar('node_memory_SwapFree_bytes{job="node-exporter"}'),
          scalar('max(node_filesystem_size_bytes{job="node-exporter",mountpoint="/",fstype!~"tmpfs|overlay|squashfs"})'),
          scalar('max(node_filesystem_avail_bytes{job="node-exporter",mountpoint="/",fstype!~"tmpfs|overlay|squashfs"})'),
          scalar(RANGE_QUERIES.host_load1),
          scalar('node_time_seconds{job="node-exporter"} - node_boot_time_seconds{job="node-exporter"}'),
          scalar('max(up{job="monitoring-service"})'),
          scalar(RANGE_QUERIES.memory), scalar(RANGE_QUERIES.heap), scalar(RANGE_QUERIES.cpu),
          scalar(RANGE_QUERIES.event_loop_p99), scalar(RANGE_QUERIES.rpc_rate),
          scalar(RANGE_QUERIES.error_rate), scalar(RANGE_QUERIES.p95_rpc_latency),
          scalar('max(up{job="conversation-service"})'), scalar(RANGE_QUERIES.conversation_memory),
          scalar(RANGE_QUERIES.conversation_cpu), scalar(RANGE_QUERIES.conversation_event_loop_p99),
          scalar(RANGE_QUERIES.conversation_sockets), scalar(RANGE_QUERIES.conversation_message_rate),
          scalar(RANGE_QUERIES.conversation_send_rate), scalar(RANGE_QUERIES.conversation_success_rate),
          scalar(RANGE_QUERIES.conversation_error_rate), scalar(RANGE_QUERIES.conversation_p95_send_latency),
          scalar('max(up{job="call-service"})'), scalar(RANGE_QUERIES.call_memory),
          scalar(RANGE_QUERIES.call_cpu), scalar(RANGE_QUERIES.call_event_loop_p99), scalar(RANGE_QUERIES.call_sockets),
        ]);

        const subtract = (total: number | null, available: number | null) =>
          total === null || available === null ? null : Math.max(0, total - available);
        const ratio = (used: number | null, total: number | null) =>
          used === null || total === null ? null : total > 0 ? used / total : 0;
        const asUp = (value: number | null) => value === null ? null : value > 0;
        const memUsed = subtract(memTotal, memAvailable);
        const swapUsed = subtract(swapTotal, swapFree);
        const diskUsed = subtract(diskTotal, diskAvailable);

        return {
          generatedAt: new Date().toISOString(),
          source: 'prometheus' as const,
          host: {
            up: asUp(hostUp), cpuUsageRatio: hostCpu,
            memoryTotalBytes: memTotal, memoryAvailableBytes: memAvailable,
            memoryUsedBytes: memUsed, memoryUsageRatio: ratio(memUsed, memTotal),
            swapTotalBytes: swapTotal, swapFreeBytes: swapFree,
            swapUsedBytes: swapUsed, swapUsageRatio: ratio(swapUsed, swapTotal),
            diskTotalBytes: diskTotal, diskAvailableBytes: diskAvailable,
            diskUsedBytes: diskUsed, diskUsageRatio: ratio(diskUsed, diskTotal),
            load1, uptimeSeconds: hostUptime,
          },
          service: { up: asUp(serviceUp) },
          process: { residentMemoryBytes, heapUsedBytes, cpuSecondsPerSecond, eventLoopP99Seconds },
          rpc: { requestsPerSecond, errorRate: rpcErrorRate, p95LatencySeconds },
          conversation: {
            up: asUp(conversationUp), residentMemoryBytes: conversationMemory,
            cpuSecondsPerSecond: conversationCpu, eventLoopP99Seconds: conversationLoop,
            socketConnections: conversationSockets, messagesPerSecond: messageRate,
            sendRequestsPerSecond: sendRate, successRate, rejectRate: null,
            errorRate: conversationErrorRate, p95SendLatencySeconds: conversationP95,
          },
          call: {
            up: asUp(callUp), residentMemoryBytes: callMemory,
            cpuSecondsPerSecond: callCpu, eventLoopP99Seconds: callLoop,
            socketConnections: callSockets,
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
      const promql = RANGE_QUERIES[query.metric];
      try {
        const points = promql
          ? await this.prometheus.range(promql, query.from, query.to, query.stepSeconds)
          : [];
        return { metric: query.metric, from: query.from, to: query.to, stepSeconds: query.stepSeconds, points };
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
    if (typeof metric !== 'string' || !Object.prototype.hasOwnProperty.call(RANGE_QUERIES, metric)) {
      throw new RpcException({ statusCode: 400, message: `metric must be one of: ${Object.keys(RANGE_QUERIES).join(', ')}` });
    }
    if (typeof from !== 'string' || typeof to !== 'string') {
      throw new RpcException({ statusCode: 400, message: 'from and to are required ISO timestamps' });
    }
    const fromMs = Date.parse(from);
    const toMs = Date.parse(to);
    if (!Number.isFinite(fromMs) || !Number.isFinite(toMs) || fromMs >= toMs) {
      throw new RpcException({ statusCode: 400, message: 'from and to must define a valid increasing time range' });
    }
    if (toMs - fromMs > 24 * 60 * 60 * 1000) {
      throw new RpcException({ statusCode: 400, message: 'monitoring timeseries range cannot exceed 24 hours' });
    }
    if (!Number.isInteger(requestedStep) || requestedStep < 15 || requestedStep > 300) {
      throw new RpcException({ statusCode: 400, message: 'stepSeconds must be an integer between 15 and 300' });
    }
    return { metric: metric as RangeMetric, from, to, stepSeconds: requestedStep };
  }

  private prometheusError(error: unknown) {
    const message = error instanceof Error ? error.message : 'Prometheus query failed';
    return new RpcException({ statusCode: 503, message });
  }

  private async measure<T>(pattern: string, operation: () => Promise<T>): Promise<T> {
    const startedAt = process.hrtime.bigint();
    let status: 'success' | 'error' = 'success';
    try { return await operation(); }
    catch (error) { status = 'error'; throw error; }
    finally {
      this.metrics.recordRpc(pattern, status, Number(process.hrtime.bigint() - startedAt) / 1_000_000_000);
    }
  }
}
