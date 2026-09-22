import { Controller } from '@nestjs/common';
import { MessagePattern, Payload, RpcException } from '@nestjs/microservices';
import { PrometheusMetricsService } from '../metrics/prometheus-metrics.service';
import {
  DockerEngineService,
  type DockerContainerResource,
  type DockerSnapshot,
  type DockerSnapshotMetadata,
} from '../services/docker-engine.service';
import { PrometheusQueryService } from '../services/prometheus-query.service';

const HOST_FILESYSTEM_SELECTOR =
  'job="node-exporter",mountpoint=~"^/$|^/opt/orbstack-guest/data$",fstype!~"tmpfs|overlay|squashfs"';

const hostFilesystemQuery = (metric: string) =>
  `max(${metric}{${HOST_FILESYSTEM_SELECTOR}})`;

const HOST_CPU_COUNT_QUERY =
  'count(node_cpu_seconds_total{job="node-exporter",mode="idle"})';

// Process counters report core-equivalents (CPU-seconds per wall-second).
// Divide by the host core count so every dashboard CPU metric uses the same
// whole-host ratio as host_cpu and the Docker container breakdown.
const processCpuUsageQuery = (service: string) =>
  `(sum(rate(velora_process_cpu_user_seconds_total{service="${service}"}[5m])) + sum(rate(velora_process_cpu_system_seconds_total{service="${service}"}[5m]))) / clamp_min(${HOST_CPU_COUNT_QUERY}, 1)`;

const RANGE_QUERIES = {
  memory:
    'max(velora_process_resident_memory_bytes{service="monitoring-service"})',
  heap: 'max(velora_process_heap_used_bytes{service="monitoring-service"})',
  cpu: processCpuUsageQuery('monitoring-service'),
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
  host_disk: `1 - (${hostFilesystemQuery('node_filesystem_avail_bytes')} / clamp_min(${hostFilesystemQuery('node_filesystem_size_bytes')}, 1))`,
  host_load1: 'max(node_load1{job="node-exporter"})',
  conversation_cpu: processCpuUsageQuery('conversation-service'),
  conversation_memory:
    'sum(velora_process_resident_memory_bytes{service="conversation-service"})',
  conversation_event_loop_p99:
    'max(velora_nodejs_event_loop_lag_p99_seconds{service="conversation-service"})',
  conversation_sockets:
    'sum(velora_conversation_socket_connections{service="conversation-service"})',
  conversation_message_rate:
    'sum(rate(velora_conversation_messages_created_total{service="conversation-service"}[5m]))',
  conversation_send_rate:
    'sum(rate(velora_conversation_send_message_requests_total{service="conversation-service"}[5m]))',
  conversation_success_rate:
    '(sum(rate(velora_conversation_send_message_requests_total{service="conversation-service",status="success"}[5m])) / clamp_min(sum(rate(velora_conversation_send_message_requests_total{service="conversation-service"}[5m])), 0.000001)) and on() (sum(rate(velora_conversation_send_message_requests_total{service="conversation-service"}[5m])) > 0)',
  conversation_reject_rate:
    '(sum(rate(velora_conversation_send_message_requests_total{service="conversation-service",status="rejected"}[5m])) / clamp_min(sum(rate(velora_conversation_send_message_requests_total{service="conversation-service"}[5m])), 0.000001)) and on() (sum(rate(velora_conversation_send_message_requests_total{service="conversation-service"}[5m])) > 0)',
  conversation_error_rate:
    '(sum(rate(velora_conversation_send_message_requests_total{service="conversation-service",status="error"}[5m])) / clamp_min(sum(rate(velora_conversation_send_message_requests_total{service="conversation-service"}[5m])), 0.000001)) and on() (sum(rate(velora_conversation_send_message_requests_total{service="conversation-service"}[5m])) > 0)',
  conversation_p95_send_latency:
    'histogram_quantile(0.95, sum by (le) (rate(velora_conversation_send_message_duration_seconds_bucket{service="conversation-service",status="success"}[5m])))',
  call_cpu: processCpuUsageQuery('call-service'),
  call_memory:
    'sum(velora_process_resident_memory_bytes{service="call-service"})',
  call_event_loop_p99:
    'max(velora_nodejs_event_loop_lag_p99_seconds{service="call-service"})',
  call_sockets: 'sum(velora_call_socket_connections{service="call-service"})',
  notification_cpu: processCpuUsageQuery('notification-service'),
  notification_memory:
    'sum(velora_process_resident_memory_bytes{service="notification-service"})',
  notification_event_loop_p99:
    'max(velora_nodejs_event_loop_lag_p99_seconds{service="notification-service"})',
  notification_database_up:
    'max(velora_notification_database_up{service="notification-service"})',
  notification_apns_request_rate:
    'sum(rate(velora_notification_apns_requests_total{service="notification-service"}[5m]))',
  notification_apns_transport_failure_rate:
    'sum(rate(velora_notification_apns_requests_total{service="notification-service",outcome=~"timeout|transport_error"}[5m]))',
  notification_retry_scheduler_completion_age_seconds:
    'max(time() - velora_notification_retry_scheduler_last_completion_timestamp_seconds{service="notification-service"})',
  rag_request_rate:
    'sum(rate(velora_rag_requests_total{service="ai-service"}[5m]))',
  rag_failure_rate:
    '(sum(rate(velora_rag_requests_total{service="ai-service",outcome="FAILED"}[5m])) / clamp_min(sum(rate(velora_rag_requests_total{service="ai-service"}[5m])), 0.000001)) and on() (sum(rate(velora_rag_requests_total{service="ai-service"}[5m])) > 0)',
  rag_p95_latency:
    'histogram_quantile(0.95, sum by (le) (rate(velora_rag_request_duration_seconds_bucket{service="ai-service"}[5m])))',
  rag_avg_retrieved_chunks:
    '(sum(rate(velora_rag_retrieved_chunks_total{service="ai-service"}[5m])) / clamp_min(sum(rate(velora_rag_requests_total{service="ai-service"}[5m])), 0.000001)) and on() (sum(rate(velora_rag_requests_total{service="ai-service"}[5m])) > 0)',
  rag_context_insufficient_rate:
    '(sum(rate(velora_rag_context_insufficient_total{service="ai-service"}[5m])) / clamp_min(sum(rate(velora_rag_requests_total{service="ai-service"}[5m])), 0.000001)) and on() (sum(rate(velora_rag_requests_total{service="ai-service"}[5m])) > 0)',
  rag_verifier_failure_rate:
    '(sum(rate(velora_rag_verifier_failures_total{service="ai-service"}[5m])) / clamp_min(sum(rate(velora_rag_requests_total{service="ai-service"}[5m])), 0.000001)) and on() (sum(rate(velora_rag_requests_total{service="ai-service"}[5m])) > 0)',
  rag_fallback_rate:
    '(sum(rate(velora_rag_fallbacks_total{service="ai-service"}[5m])) / clamp_min(sum(rate(velora_rag_requests_total{service="ai-service"}[5m])), 0.000001)) and on() (sum(rate(velora_rag_requests_total{service="ai-service"}[5m])) > 0)',
  rag_retries_per_request:
    '(sum(rate(velora_rag_retries_total{service="ai-service"}[5m])) / clamp_min(sum(rate(velora_rag_requests_total{service="ai-service"}[5m])), 0.000001)) and on() (sum(rate(velora_rag_requests_total{service="ai-service"}[5m])) > 0)',
  rag_input_token_rate:
    'sum(rate(velora_rag_input_tokens_total{service="ai-service"}[5m]))',
  rag_output_token_rate:
    'sum(rate(velora_rag_output_tokens_total{service="ai-service"}[5m]))',
  rag_total_token_rate:
    'sum(rate(velora_rag_tokens_total{service="ai-service"}[5m]))',
  rag_avg_tokens_per_request:
    '(sum(rate(velora_rag_tokens_total{service="ai-service"}[5m])) / clamp_min(sum(rate(velora_rag_requests_total{service="ai-service"}[5m])), 0.000001)) and on() (sum(rate(velora_rag_requests_total{service="ai-service"}[5m])) > 0)',
  rag_p95_tokens_per_request:
    'histogram_quantile(0.95, sum by (le) (rate(velora_rag_request_tokens_bucket{service="ai-service"}[5m])))',
  reel_snapshot_up:
    'max(velora_reel_pipeline_snapshot_up{service="content-service"})',
  reel_queued:
    'max(velora_reel_pipeline_items{service="content-service",state="queued"})',
  reel_processing:
    'max(velora_reel_pipeline_items{service="content-service",state="processing"})',
  reel_ready:
    'max(velora_reel_pipeline_items{service="content-service",state="ready"})',
  reel_failed:
    'max(velora_reel_pipeline_items{service="content-service",state="failed"})',
  reel_degraded:
    'max(velora_reel_pipeline_items{service="content-service",state="degraded"})',
  reel_stalled:
    'max(velora_reel_pipeline_items{service="content-service",state="stalled"})',
  reel_recent_failed:
    'max(velora_reel_pipeline_recent_failures{service="content-service"})',
  reel_ready_latency_p95:
    'max(velora_reel_pipeline_ready_latency_p95_seconds{service="content-service"})',
  reel_media_throughput:
    'sum(rate(velora_reel_worker_stage_runs_total{pipeline="MEDIA",stage="TOTAL_PIPELINE",outcome="SUCCEEDED"}[5m]))',
  reel_media_failure_rate:
    '(sum(rate(velora_reel_worker_stage_runs_total{pipeline="MEDIA",stage="TOTAL_PIPELINE",outcome="FAILED"}[5m])) / clamp_min(sum(rate(velora_reel_worker_stage_runs_total{pipeline="MEDIA",stage="TOTAL_PIPELINE"}[5m])), 0.000001)) and on() (sum(rate(velora_reel_worker_stage_runs_total{pipeline="MEDIA",stage="TOTAL_PIPELINE"}[5m])) > 0)',
  reel_media_retry_rate:
    '(sum(rate(velora_reel_worker_retries_total{pipeline="MEDIA"}[5m])) / clamp_min(sum(rate(velora_reel_worker_stage_runs_total{pipeline="MEDIA",stage="TOTAL_PIPELINE"}[5m])), 0.000001)) and on() (sum(rate(velora_reel_worker_stage_runs_total{pipeline="MEDIA",stage="TOTAL_PIPELINE"}[5m])) > 0)',
  reel_media_p95_latency:
    'histogram_quantile(0.95, sum by (le) (rate(velora_reel_worker_stage_duration_seconds_bucket{pipeline="MEDIA",stage="TOTAL_PIPELINE"}[5m])))',
  reel_media_queue_wait_p95:
    'histogram_quantile(0.95, sum by (le) (rate(velora_reel_worker_stage_duration_seconds_bucket{pipeline="MEDIA",stage="QUEUE_WAIT"}[5m])))',
  reel_media_exhausted_retry_rate:
    'sum(rate(velora_reel_worker_exhausted_retries_total{pipeline="MEDIA"}[5m]))',
  reel_index_throughput:
    'sum(rate(velora_reel_worker_stage_runs_total{pipeline="INDEX",stage="TOTAL_PIPELINE",outcome="SUCCEEDED"}[5m]))',
  reel_index_failure_rate:
    '(sum(rate(velora_reel_worker_stage_runs_total{pipeline="INDEX",stage="TOTAL_PIPELINE",outcome="FAILED"}[5m])) / clamp_min(sum(rate(velora_reel_worker_stage_runs_total{pipeline="INDEX",stage="TOTAL_PIPELINE"}[5m])), 0.000001)) and on() (sum(rate(velora_reel_worker_stage_runs_total{pipeline="INDEX",stage="TOTAL_PIPELINE"}[5m])) > 0)',
  reel_index_retry_rate:
    '(sum(rate(velora_reel_worker_retries_total{pipeline="INDEX"}[5m])) / clamp_min(sum(rate(velora_reel_worker_stage_runs_total{pipeline="INDEX",stage="TOTAL_PIPELINE"}[5m])), 0.000001)) and on() (sum(rate(velora_reel_worker_stage_runs_total{pipeline="INDEX",stage="TOTAL_PIPELINE"}[5m])) > 0)',
  reel_index_p95_latency:
    'histogram_quantile(0.95, sum by (le) (rate(velora_reel_worker_stage_duration_seconds_bucket{pipeline="INDEX",stage="TOTAL_PIPELINE"}[5m])))',
  reel_index_queue_wait_p95:
    'histogram_quantile(0.95, sum by (le) (rate(velora_reel_worker_stage_duration_seconds_bucket{pipeline="INDEX",stage="QUEUE_WAIT"}[5m])))',
  reel_index_exhausted_retry_rate:
    'sum(rate(velora_reel_worker_exhausted_retries_total{pipeline="INDEX"}[5m]))',
  reel_index_chunk_rate:
    'sum(rate(velora_reel_index_items_total{kind="chunk"}[5m]))',
  reel_index_zero_chunk_rate:
    '(sum(rate(velora_reel_index_zero_chunk_total[5m])) / clamp_min(sum(rate(velora_reel_worker_stage_runs_total{pipeline="INDEX",stage="TOTAL_PIPELINE",outcome="SUCCEEDED"}[5m])), 0.000001)) and on() (sum(rate(velora_reel_worker_stage_runs_total{pipeline="INDEX",stage="TOTAL_PIPELINE",outcome="SUCCEEDED"}[5m])) > 0)',
  reel_rabbitmq_up: 'max(up{job="rabbitmq-reels"})',
  reel_media_queue_ready:
    'sum(rabbitmq_detailed_queue_messages_ready{queue=~"reel_media_(short|long)_jobs"})',
  reel_media_queue_unacked:
    'sum(rabbitmq_detailed_queue_messages_unacked{queue=~"reel_media_(short|long)_jobs"})',
  reel_media_consumers:
    'sum(rabbitmq_detailed_queue_consumers{queue=~"reel_media_(short|long)_jobs"})',
  reel_media_retry_queue_depth:
    'sum(rabbitmq_detailed_queue_messages_ready{queue=~"reel_media_(short_retry_30s|short_retry_5m|long_retry_60s|long_retry_10m)"})',
  reel_media_dlq_depth:
    'sum(rabbitmq_detailed_queue_messages_ready{queue=~"reel_media_(short|long)_dlq"})',
  reel_media_publish_rate:
    'sum(rate(rabbitmq_detailed_queue_messages_published_total{queue=~"reel_media_.*"}[5m]))',
  reel_media_delivery_rate:
    'sum(rate(rabbitmq_detailed_channel_messages_delivered_ack_total{queue=~"reel_media_.*"}[5m])) + sum(rate(rabbitmq_detailed_channel_messages_delivered_total{queue=~"reel_media_.*"}[5m]))',
  reel_index_queue_ready:
    'sum(rabbitmq_detailed_queue_messages_ready{queue=~"reel_index_(short|long)_jobs"})',
  reel_index_queue_unacked:
    'sum(rabbitmq_detailed_queue_messages_unacked{queue=~"reel_index_(short|long)_jobs"})',
  reel_index_consumers:
    'sum(rabbitmq_detailed_queue_consumers{queue=~"reel_index_(short|long)_jobs"})',
  reel_index_retry_queue_depth:
    'sum(rabbitmq_detailed_queue_messages_ready{queue=~"reel_index_(short_retry_30s|short_retry_5m|long_retry_60s|long_retry_10m)"})',
  reel_index_dlq_depth:
    'sum(rabbitmq_detailed_queue_messages_ready{queue=~"reel_index_(short|long)_dlq"})',
  reel_index_publish_rate:
    'sum(rate(rabbitmq_detailed_queue_messages_published_total{queue=~"reel_index_.*"}[5m]))',
  reel_index_delivery_rate:
    'sum(rate(rabbitmq_detailed_channel_messages_delivered_ack_total{queue=~"reel_index_.*"}[5m])) + sum(rate(rabbitmq_detailed_channel_messages_delivered_total{queue=~"reel_index_.*"}[5m]))',
} as const;

type RangeMetric = keyof typeof RANGE_QUERIES;
type ScalarMetric = number | null;

type TimeseriesPayload = {
  metric?: unknown;
  from?: unknown;
  to?: unknown;
  stepSeconds?: unknown;
};

const subtractMetric = (
  total: ScalarMetric,
  available: ScalarMetric,
): ScalarMetric => {
  if (total === null || available === null) {
    return null;
  }

  return Math.max(0, total - available);
};

const usageRatio = (used: ScalarMetric, total: ScalarMetric): ScalarMetric => {
  if (used === null || total === null) {
    return null;
  }

  return total > 0 ? used / total : 0;
};

const targetStatus = (value: ScalarMetric): boolean | null =>
  value === null ? null : value > 0;

@Controller()
export class SystemMetricsController {
  constructor(
    private readonly prometheus: PrometheusQueryService,
    private readonly metrics: PrometheusMetricsService,
    private readonly docker: DockerEngineService,
  ) {}

  @MessagePattern('system.metrics.status')
  async status() {
    return this.measure('system.metrics.status', async () => {
      try {
        const [monitoringUp, hostUp] = await Promise.all([
          this.prometheus.scalar('max(up{job="monitoring-service"})'),
          this.prometheus.scalar('max(up{job="node-exporter"})'),
        ]);

        return {
          generatedAt: new Date().toISOString(),
          source: 'prometheus' as const,
          monitoringUp: targetStatus(monitoringUp),
          hostUp: targetStatus(hostUp),
        };
      } catch (error) {
        throw this.prometheusError(error);
      }
    });
  }

  @MessagePattern('system.metrics.containers')
  async containers() {
    return this.measure('system.metrics.containers', async () => {
      try {
        const [snapshot, metadata] = await Promise.all([
          this.readDockerSnapshot(),
          this.readDockerSnapshotMetadata(),
        ]);

        const metadataFields = metadata
          ? {
              hostCpuCount: metadata.hostCpuCount,
              storage: metadata.storage,
            }
          : {};
        const coverageFields =
          snapshot.runningContainers === undefined
            ? {}
            : {
                runningContainers: snapshot.runningContainers,
                sampledContainers: snapshot.sampledContainers,
              };

        return {
          generatedAt: new Date().toISOString(),
          source: 'docker' as const,
          dockerEngineUp: true,
          containers: snapshot.containers,
          ...metadataFields,
          ...coverageFields,
        };
      } catch {
        return {
          generatedAt: new Date().toISOString(),
          source: 'docker' as const,
          dockerEngineUp: false,
          containers: [],
        };
      }
    });
  }

  private readDockerSnapshot(): Promise<{
    containers: DockerContainerResource[];
    runningContainers?: number;
    sampledContainers?: number;
  }> {
    const snapshotWithCoverage = (
      this.docker as DockerEngineService & {
        snapshotWithCoverage?: () => Promise<DockerSnapshot>;
      }
    ).snapshotWithCoverage;

    if (typeof snapshotWithCoverage === 'function') {
      return Promise.resolve(snapshotWithCoverage.call(this.docker));
    }

    return Promise.resolve(this.docker.snapshot()).then((containers) => ({
      containers,
    }));
  }

  private readDockerSnapshotMetadata(): Promise<DockerSnapshotMetadata | null> {
    const snapshotMetadata = (
      this.docker as DockerEngineService & {
        snapshotMetadata?: () => Promise<DockerSnapshotMetadata>;
      }
    ).snapshotMetadata;

    if (typeof snapshotMetadata !== 'function') {
      return Promise.resolve(null);
    }

    return Promise.resolve(snapshotMetadata.call(this.docker)).catch(
      () => null,
    );
  }

  @MessagePattern('system.metrics.overview')
  async overview() {
    return this.measure('system.metrics.overview', async () => {
      try {
        const [
          serviceUp,
          residentMemoryBytes,
          heapUsedBytes,
          cpuUsageRatio,
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
          conversationUp,
          conversationCpuUsageRatio,
          conversationResidentMemoryBytes,
          conversationEventLoopP99Seconds,
          conversationSocketConnections,
          conversationMessagesPerSecond,
          conversationSendRequestsPerSecond,
          conversationSuccessRate,
          conversationRejectRate,
          conversationErrorRate,
          conversationP95SendLatencySeconds,
          callUp,
          callCpuUsageRatio,
          callResidentMemoryBytes,
          callEventLoopP99Seconds,
          callSocketConnections,
          notificationUp,
          notificationCpuUsageRatio,
          notificationResidentMemoryBytes,
          notificationEventLoopP99Seconds,
          notificationDatabaseUp,
          notificationApnsRequestsPerSecond,
          notificationApnsTransportFailuresPerSecond,
          notificationRetrySchedulerCompletionAgeSeconds,
          ragRequestsPerSecond,
          ragFailureRate,
          ragP95LatencySeconds,
          ragAvgRetrievedChunks,
          ragContextInsufficientRate,
          ragVerifierFailureRate,
          ragFallbackRate,
          ragRetriesPerRequest,
          ragInputTokensPerSecond,
          ragOutputTokensPerSecond,
          ragTotalTokensPerSecond,
          ragAvgTokensPerRequest,
          ragP95TokensPerRequest,
          reelSnapshotUp,
          reelQueued,
          reelProcessing,
          reelReady,
          reelFailed,
          reelDegraded,
          reelStalled,
          reelRecentFailed,
          reelReadyLatencyP95Seconds,
          reelRabbitmqUp,
          reelMediaThroughputPerSecond,
          reelMediaFailureRate,
          reelMediaRetryRate,
          reelMediaP95LatencySeconds,
          reelMediaQueueWaitP95Seconds,
          reelMediaExhaustedRetriesPerSecond,
          reelMediaQueueReady,
          reelMediaQueueUnacked,
          reelMediaConsumers,
          reelMediaRetryQueueDepth,
          reelMediaDlqDepth,
          reelMediaPublishRate,
          reelMediaDeliveryRate,
          reelIndexThroughputPerSecond,
          reelIndexFailureRate,
          reelIndexRetryRate,
          reelIndexP95LatencySeconds,
          reelIndexQueueWaitP95Seconds,
          reelIndexExhaustedRetriesPerSecond,
          reelIndexChunksPerSecond,
          reelIndexZeroChunkRate,
          reelIndexQueueReady,
          reelIndexQueueUnacked,
          reelIndexConsumers,
          reelIndexRetryQueueDepth,
          reelIndexDlqDepth,
          reelIndexPublishRate,
          reelIndexDeliveryRate,
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
          this.prometheus.scalar(
            'max(node_memory_MemTotal_bytes{job="node-exporter"})',
          ),
          this.prometheus.scalar(
            'max(node_memory_MemAvailable_bytes{job="node-exporter"})',
          ),
          this.prometheus.scalar(
            'max(node_memory_SwapTotal_bytes{job="node-exporter"})',
          ),
          this.prometheus.scalar(
            'max(node_memory_SwapFree_bytes{job="node-exporter"})',
          ),
          this.prometheus.scalar(
            hostFilesystemQuery('node_filesystem_size_bytes'),
          ),
          this.prometheus.scalar(
            hostFilesystemQuery('node_filesystem_avail_bytes'),
          ),
          this.prometheus.scalar(RANGE_QUERIES.host_load1),
          this.prometheus.scalar(
            'max(time() - node_boot_time_seconds{job="node-exporter"})',
          ),
          this.prometheus.scalar('max(up{job="conversation-service"})'),
          this.prometheus.scalar(RANGE_QUERIES.conversation_cpu),
          this.prometheus.scalar(RANGE_QUERIES.conversation_memory),
          this.prometheus.scalar(RANGE_QUERIES.conversation_event_loop_p99),
          this.prometheus.scalar(RANGE_QUERIES.conversation_sockets),
          this.prometheus.scalar(RANGE_QUERIES.conversation_message_rate),
          this.prometheus.scalar(RANGE_QUERIES.conversation_send_rate),
          this.prometheus.scalar(RANGE_QUERIES.conversation_success_rate),
          this.prometheus.scalar(RANGE_QUERIES.conversation_reject_rate),
          this.prometheus.scalar(RANGE_QUERIES.conversation_error_rate),
          this.prometheus.scalar(RANGE_QUERIES.conversation_p95_send_latency),
          this.prometheus.scalar('max(up{job="call-service"})'),
          this.prometheus.scalar(RANGE_QUERIES.call_cpu),
          this.prometheus.scalar(RANGE_QUERIES.call_memory),
          this.prometheus.scalar(RANGE_QUERIES.call_event_loop_p99),
          this.prometheus.scalar(RANGE_QUERIES.call_sockets),
          this.prometheus.scalar('max(up{job="notification-service"})'),
          this.prometheus.scalar(RANGE_QUERIES.notification_cpu),
          this.prometheus.scalar(RANGE_QUERIES.notification_memory),
          this.prometheus.scalar(RANGE_QUERIES.notification_event_loop_p99),
          this.prometheus.scalar(RANGE_QUERIES.notification_database_up),
          this.prometheus.scalar(RANGE_QUERIES.notification_apns_request_rate),
          this.prometheus.scalar(
            RANGE_QUERIES.notification_apns_transport_failure_rate,
          ),
          this.prometheus.scalar(
            RANGE_QUERIES.notification_retry_scheduler_completion_age_seconds,
          ),
          this.prometheus.scalar(RANGE_QUERIES.rag_request_rate),
          this.prometheus.scalar(RANGE_QUERIES.rag_failure_rate),
          this.prometheus.scalar(RANGE_QUERIES.rag_p95_latency),
          this.prometheus.scalar(RANGE_QUERIES.rag_avg_retrieved_chunks),
          this.prometheus.scalar(RANGE_QUERIES.rag_context_insufficient_rate),
          this.prometheus.scalar(RANGE_QUERIES.rag_verifier_failure_rate),
          this.prometheus.scalar(RANGE_QUERIES.rag_fallback_rate),
          this.prometheus.scalar(RANGE_QUERIES.rag_retries_per_request),
          this.prometheus.scalar(RANGE_QUERIES.rag_input_token_rate),
          this.prometheus.scalar(RANGE_QUERIES.rag_output_token_rate),
          this.prometheus.scalar(RANGE_QUERIES.rag_total_token_rate),
          this.prometheus.scalar(RANGE_QUERIES.rag_avg_tokens_per_request),
          this.prometheus.scalar(RANGE_QUERIES.rag_p95_tokens_per_request),
          this.prometheus.scalar(RANGE_QUERIES.reel_snapshot_up),
          this.prometheus.scalar(RANGE_QUERIES.reel_queued),
          this.prometheus.scalar(RANGE_QUERIES.reel_processing),
          this.prometheus.scalar(RANGE_QUERIES.reel_ready),
          this.prometheus.scalar(RANGE_QUERIES.reel_failed),
          this.prometheus.scalar(RANGE_QUERIES.reel_degraded),
          this.prometheus.scalar(RANGE_QUERIES.reel_stalled),
          this.prometheus.scalar(RANGE_QUERIES.reel_recent_failed),
          this.prometheus.scalar(RANGE_QUERIES.reel_ready_latency_p95),
          this.prometheus.scalar(RANGE_QUERIES.reel_rabbitmq_up),
          this.prometheus.scalar(RANGE_QUERIES.reel_media_throughput),
          this.prometheus.scalar(RANGE_QUERIES.reel_media_failure_rate),
          this.prometheus.scalar(RANGE_QUERIES.reel_media_retry_rate),
          this.prometheus.scalar(RANGE_QUERIES.reel_media_p95_latency),
          this.prometheus.scalar(RANGE_QUERIES.reel_media_queue_wait_p95),
          this.prometheus.scalar(RANGE_QUERIES.reel_media_exhausted_retry_rate),
          this.prometheus.scalar(RANGE_QUERIES.reel_media_queue_ready),
          this.prometheus.scalar(RANGE_QUERIES.reel_media_queue_unacked),
          this.prometheus.scalar(RANGE_QUERIES.reel_media_consumers),
          this.prometheus.scalar(RANGE_QUERIES.reel_media_retry_queue_depth),
          this.prometheus.scalar(RANGE_QUERIES.reel_media_dlq_depth),
          this.prometheus.scalar(RANGE_QUERIES.reel_media_publish_rate),
          this.prometheus.scalar(RANGE_QUERIES.reel_media_delivery_rate),
          this.prometheus.scalar(RANGE_QUERIES.reel_index_throughput),
          this.prometheus.scalar(RANGE_QUERIES.reel_index_failure_rate),
          this.prometheus.scalar(RANGE_QUERIES.reel_index_retry_rate),
          this.prometheus.scalar(RANGE_QUERIES.reel_index_p95_latency),
          this.prometheus.scalar(RANGE_QUERIES.reel_index_queue_wait_p95),
          this.prometheus.scalar(RANGE_QUERIES.reel_index_exhausted_retry_rate),
          this.prometheus.scalar(RANGE_QUERIES.reel_index_chunk_rate),
          this.prometheus.scalar(RANGE_QUERIES.reel_index_zero_chunk_rate),
          this.prometheus.scalar(RANGE_QUERIES.reel_index_queue_ready),
          this.prometheus.scalar(RANGE_QUERIES.reel_index_queue_unacked),
          this.prometheus.scalar(RANGE_QUERIES.reel_index_consumers),
          this.prometheus.scalar(RANGE_QUERIES.reel_index_retry_queue_depth),
          this.prometheus.scalar(RANGE_QUERIES.reel_index_dlq_depth),
          this.prometheus.scalar(RANGE_QUERIES.reel_index_publish_rate),
          this.prometheus.scalar(RANGE_QUERIES.reel_index_delivery_rate),
        ]);

        const hostMemoryUsedBytes = subtractMetric(
          hostMemoryTotalBytes,
          hostMemoryAvailableBytes,
        );
        const hostSwapUsedBytes = subtractMetric(
          hostSwapTotalBytes,
          hostSwapFreeBytes,
        );
        const hostDiskUsedBytes = subtractMetric(
          hostDiskTotalBytes,
          hostDiskAvailableBytes,
        );

        return {
          generatedAt: new Date().toISOString(),
          source: 'prometheus' as const,
          host: {
            up: targetStatus(hostUp),
            cpuUsageRatio: hostCpuUsageRatio,
            memoryTotalBytes: hostMemoryTotalBytes,
            memoryAvailableBytes: hostMemoryAvailableBytes,
            memoryUsedBytes: hostMemoryUsedBytes,
            memoryUsageRatio: usageRatio(
              hostMemoryUsedBytes,
              hostMemoryTotalBytes,
            ),
            swapTotalBytes: hostSwapTotalBytes,
            swapFreeBytes: hostSwapFreeBytes,
            swapUsedBytes: hostSwapUsedBytes,
            swapUsageRatio: usageRatio(hostSwapUsedBytes, hostSwapTotalBytes),
            diskTotalBytes: hostDiskTotalBytes,
            diskAvailableBytes: hostDiskAvailableBytes,
            diskUsedBytes: hostDiskUsedBytes,
            diskUsageRatio: usageRatio(hostDiskUsedBytes, hostDiskTotalBytes),
            load1: hostLoad1,
            uptimeSeconds: hostUptimeSeconds,
          },
          service: {
            up: targetStatus(serviceUp),
          },
          process: {
            residentMemoryBytes,
            heapUsedBytes,
            cpuUsageRatio,
            eventLoopP99Seconds,
          },
          rpc: {
            requestsPerSecond,
            errorRate,
            p95LatencySeconds,
          },
          conversation: {
            up: targetStatus(conversationUp),
            residentMemoryBytes: conversationResidentMemoryBytes,
            cpuUsageRatio: conversationCpuUsageRatio,
            eventLoopP99Seconds: conversationEventLoopP99Seconds,
            socketConnections: conversationSocketConnections,
            messagesPerSecond: conversationMessagesPerSecond,
            sendRequestsPerSecond: conversationSendRequestsPerSecond,
            successRate: conversationSuccessRate,
            rejectRate: conversationRejectRate,
            errorRate: conversationErrorRate,
            p95SendLatencySeconds: conversationP95SendLatencySeconds,
          },
          call: {
            up: targetStatus(callUp),
            residentMemoryBytes: callResidentMemoryBytes,
            cpuUsageRatio: callCpuUsageRatio,
            eventLoopP99Seconds: callEventLoopP99Seconds,
            socketConnections: callSocketConnections,
          },
          notification: {
            up: targetStatus(notificationUp),
            residentMemoryBytes: notificationResidentMemoryBytes,
            cpuUsageRatio: notificationCpuUsageRatio,
            eventLoopP99Seconds: notificationEventLoopP99Seconds,
            databaseUp: targetStatus(notificationDatabaseUp),
            apnsRequestsPerSecond: notificationApnsRequestsPerSecond,
            apnsTransportFailuresPerSecond:
              notificationApnsTransportFailuresPerSecond,
            retrySchedulerCompletionAgeSeconds:
              notificationRetrySchedulerCompletionAgeSeconds,
          },
          rag: {
            requestsPerSecond: ragRequestsPerSecond,
            failureRate: ragFailureRate,
            p95LatencySeconds: ragP95LatencySeconds,
            avgRetrievedChunks: ragAvgRetrievedChunks,
            contextInsufficientRate: ragContextInsufficientRate,
            verifierFailureRate: ragVerifierFailureRate,
            fallbackRate: ragFallbackRate,
            retriesPerRequest: ragRetriesPerRequest,
            inputTokensPerSecond: ragInputTokensPerSecond,
            outputTokensPerSecond: ragOutputTokensPerSecond,
            totalTokensPerSecond: ragTotalTokensPerSecond,
            avgTokensPerRequest: ragAvgTokensPerRequest,
            p95TokensPerRequest: ragP95TokensPerRequest,
          },
          reels: {
            snapshotUp: targetStatus(reelSnapshotUp),
            rabbitmqUp: targetStatus(reelRabbitmqUp),
            queued: reelQueued,
            processing: reelProcessing,
            ready: reelReady,
            failed: reelFailed,
            degraded: reelDegraded,
            stalled: reelStalled,
            recentFailed: reelRecentFailed,
            readyLatencyP95Seconds: reelReadyLatencyP95Seconds,
            media: {
              throughputPerSecond: reelMediaThroughputPerSecond,
              failureRate: reelMediaFailureRate,
              retryRate: reelMediaRetryRate,
              p95LatencySeconds: reelMediaP95LatencySeconds,
              queueWaitP95Seconds: reelMediaQueueWaitP95Seconds,
              exhaustedRetriesPerSecond: reelMediaExhaustedRetriesPerSecond,
              queueReady: reelMediaQueueReady,
              queueUnacked: reelMediaQueueUnacked,
              consumers: reelMediaConsumers,
              retryQueueDepth: reelMediaRetryQueueDepth,
              dlqDepth: reelMediaDlqDepth,
              publishRate: reelMediaPublishRate,
              deliveryRate: reelMediaDeliveryRate,
            },
            index: {
              throughputPerSecond: reelIndexThroughputPerSecond,
              failureRate: reelIndexFailureRate,
              retryRate: reelIndexRetryRate,
              p95LatencySeconds: reelIndexP95LatencySeconds,
              queueWaitP95Seconds: reelIndexQueueWaitP95Seconds,
              exhaustedRetriesPerSecond: reelIndexExhaustedRetriesPerSecond,
              chunksPerSecond: reelIndexChunksPerSecond,
              zeroChunkRate: reelIndexZeroChunkRate,
              queueReady: reelIndexQueueReady,
              queueUnacked: reelIndexQueueUnacked,
              consumers: reelIndexConsumers,
              retryQueueDepth: reelIndexRetryQueueDepth,
              dlqDepth: reelIndexDlqDepth,
              publishRate: reelIndexPublishRate,
              deliveryRate: reelIndexDeliveryRate,
            },
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
    const message =
      error instanceof Error ? error.message : 'Prometheus query failed';
    return new RpcException({
      statusCode: 503,
      message,
    });
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
      const durationSeconds =
        Number(process.hrtime.bigint() - startedAt) / 1_000_000_000;
      this.metrics.recordRpc(pattern, status, durationSeconds);
    }
  }
}
