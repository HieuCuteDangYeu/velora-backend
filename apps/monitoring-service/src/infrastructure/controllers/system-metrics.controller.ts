import {
  MONITORING_METRICS,
  MONITORING_METRIC_SET,
  type MonitoringMetric,
} from '@common/monitoring/monitoring-metrics';
import { Controller } from '@nestjs/common';
import { MessagePattern, Payload, RpcException } from '@nestjs/microservices';
import { PrometheusMetricsService } from '../metrics/prometheus-metrics.service';
import {
  DockerEngineService,
  type DockerContainerResource,
  type DockerEndpoint,
  type DockerSnapshot,
  type DockerSnapshotMetadata,
} from '../services/docker-engine.service';
import {
  hostBaseQueries,
  hostScope,
  hostTimeseriesQuery,
  HOST_TIMESERIES_METRICS,
  HOST_TIMESERIES_METRIC_SET,
  PRIMARY_HOST_SCOPE,
  type HostTimeseriesMetric,
} from '../services/host-queries';
import {
  defaultHostOf,
  HostRegistryService,
  HOST_REGISTRY_QUERY,
  mergeHostRecords,
} from '../services/host-registry.service';
import {
  subtractMetric,
  targetStatus,
  usageRatio,
} from '../services/metric-math';
import { PrometheusQueryService } from '../services/prometheus-query.service';
import { parseTimeRange } from '../services/time-range';
import { KeyedTtlSingleFlight } from '../services/ttl-single-flight';
import { HOST_ID_PATTERN } from '@monitoring/domain/models/monitoring-host.model';

// The overview keeps its single-host `host` block for older dashboards. It
// always describes the primary machine; use the hosts endpoints for the rest.
const PRIMARY_HOST = hostBaseQueries(PRIMARY_HOST_SCOPE, false);

// Service process counters are fractions of the machine running the stack, so
// divide by the primary host's core count, not by every VPS in the fleet.
const HOST_CPU_COUNT_QUERY = PRIMARY_HOST.cpuCount;

const PRIMARY_HOST_UP_QUERY = `max(up{${PRIMARY_HOST_SCOPE}})`;

// Process counters report core-equivalents (CPU-seconds per wall-second).
// Divide by the host core count so every dashboard CPU metric uses the same
// whole-host ratio as host_cpu and the Docker container breakdown.
const processCpuUsageQuery = (service: string) =>
  `(sum(rate(velora_process_cpu_user_seconds_total{service="${service}"}[1m])) + sum(rate(velora_process_cpu_system_seconds_total{service="${service}"}[1m]))) / clamp_min(${HOST_CPU_COUNT_QUERY}, 1)`;

const observedRatioQuery = (numerator: string, denominator: string) =>
  `((${numerator}) or on() vector(0)) / clamp_min(${denominator}, 0.000001) and on() (${denominator} > 0)`;

const REEL_QUEUE_PATTERN = 'reel_(media|index)_(short|long)_jobs';
const REEL_QUEUE_READY_QUERY = `sum by (queue, vhost) (rabbitmq_detailed_queue_messages_ready{job="rabbitmq-reels",queue=~"${REEL_QUEUE_PATTERN}"})`;
const REEL_QUEUE_CONSUMERS_QUERY = `sum by (queue, vhost) (rabbitmq_detailed_queue_consumers{job="rabbitmq-reels",queue=~"${REEL_QUEUE_PATTERN}"})`;

const RANGE_QUERIES = {
  memory:
    'max(velora_process_resident_memory_bytes{service="monitoring-service"})',
  heap: 'max(velora_process_heap_used_bytes{service="monitoring-service"})',
  cpu: processCpuUsageQuery('monitoring-service'),
  rpc_rate: 'sum(rate(velora_monitoring_rpc_requests_total[1m]))',
  error_rate:
    'sum(rate(velora_monitoring_rpc_requests_total{status="error"}[1m])) / clamp_min(sum(rate(velora_monitoring_rpc_requests_total[1m])), 0.000001)',
  p95_rpc_latency:
    'histogram_quantile(0.95, sum by (le) (rate(velora_monitoring_rpc_duration_seconds_bucket[1m])))',
  event_loop_p99:
    'max(velora_nodejs_event_loop_lag_p99_seconds{service="monitoring-service"})',
  host_cpu: hostTimeseriesQuery('host_cpu', PRIMARY_HOST_SCOPE),
  host_memory: hostTimeseriesQuery('host_memory', PRIMARY_HOST_SCOPE),
  host_swap: hostTimeseriesQuery('host_swap', PRIMARY_HOST_SCOPE),
  host_disk: hostTimeseriesQuery('host_disk', PRIMARY_HOST_SCOPE),
  host_load1: hostTimeseriesQuery('host_load1', PRIMARY_HOST_SCOPE),
  conversation_cpu: processCpuUsageQuery('conversation-service'),
  conversation_memory:
    'sum(velora_process_resident_memory_bytes{service="conversation-service"})',
  conversation_event_loop_p99:
    'max(velora_nodejs_event_loop_lag_p99_seconds{service="conversation-service"})',
  conversation_sockets:
    'sum(velora_conversation_socket_connections{service="conversation-service"})',
  conversation_message_rate:
    'sum(rate(velora_conversation_messages_created_total{service="conversation-service"}[1m]))',
  conversation_send_rate:
    'sum(rate(velora_conversation_send_message_requests_total{service="conversation-service"}[1m]))',
  conversation_success_rate:
    '(sum(rate(velora_conversation_send_message_requests_total{service="conversation-service",status="success"}[1m])) / clamp_min(sum(rate(velora_conversation_send_message_requests_total{service="conversation-service"}[1m])), 0.000001)) and on() (sum(rate(velora_conversation_send_message_requests_total{service="conversation-service"}[1m])) > 0)',
  conversation_reject_rate:
    '(sum(rate(velora_conversation_send_message_requests_total{service="conversation-service",status="rejected"}[1m])) / clamp_min(sum(rate(velora_conversation_send_message_requests_total{service="conversation-service"}[1m])), 0.000001)) and on() (sum(rate(velora_conversation_send_message_requests_total{service="conversation-service"}[1m])) > 0)',
  conversation_error_rate:
    '(sum(rate(velora_conversation_send_message_requests_total{service="conversation-service",status="error"}[1m])) / clamp_min(sum(rate(velora_conversation_send_message_requests_total{service="conversation-service"}[1m])), 0.000001)) and on() (sum(rate(velora_conversation_send_message_requests_total{service="conversation-service"}[1m])) > 0)',
  conversation_p95_send_latency:
    'histogram_quantile(0.95, sum by (le) (rate(velora_conversation_send_message_duration_seconds_bucket{service="conversation-service",status="success"}[1m])))',
  call_cpu: processCpuUsageQuery('call-service'),
  call_memory:
    'sum(velora_process_resident_memory_bytes{service="call-service"})',
  call_event_loop_p99:
    'max(velora_nodejs_event_loop_lag_p99_seconds{service="call-service"})',
  call_sockets: 'sum(velora_call_socket_connections{service="call-service"})',
  // One mediasoup worker is single-threaded, so 1 means a worker has saturated
  // its core. Report the busiest worker, not the average.
  call_media_worker_cpu:
    'max(rate(velora_call_mediasoup_worker_cpu_seconds_total{service="call-service"}[1m]))',
  call_media_rooms:
    'sum(velora_call_mediasoup_worker_rooms{service="call-service"})',
  notification_cpu: processCpuUsageQuery('notification-service'),
  notification_memory:
    'sum(velora_process_resident_memory_bytes{service="notification-service"})',
  notification_event_loop_p99:
    'max(velora_nodejs_event_loop_lag_p99_seconds{service="notification-service"})',
  notification_database_up:
    'max(velora_notification_database_up{service="notification-service"})',
  notification_apns_request_rate:
    'sum(rate(velora_notification_apns_requests_total{service="notification-service"}[1m]))',
  notification_apns_transport_failure_rate:
    'sum(rate(velora_notification_apns_requests_total{service="notification-service",outcome=~"timeout|transport_error"}[1m]))',
  notification_retry_scheduler_completion_age_seconds:
    'max(time() - velora_notification_retry_scheduler_last_completion_timestamp_seconds{service="notification-service"})',
  auth_cpu: processCpuUsageQuery('auth-service'),
  auth_memory:
    'sum(velora_process_resident_memory_bytes{service="auth-service"})',
  auth_event_loop_p99:
    'max(velora_nodejs_event_loop_lag_p99_seconds{service="auth-service"})',
  auth_database_up: 'max(velora_auth_database_up{service="auth-service"})',
  auth_redis_up: 'max(velora_auth_redis_up{service="auth-service"})',
  auth_request_rate:
    'sum(rate(velora_auth_requests_total{service="auth-service"}[1m]))',
  auth_error_rate:
    '(sum(rate(velora_auth_requests_total{service="auth-service",outcome="error"}[1m])) / clamp_min(sum(rate(velora_auth_requests_total{service="auth-service"}[1m])), 0.000001)) and on() (sum(rate(velora_auth_requests_total{service="auth-service"}[1m])) > 0)',
  auth_p95_latency:
    'histogram_quantile(0.95, sum by (le) (rate(velora_auth_request_duration_seconds_bucket{service="auth-service"}[1m])))',
  auth_login_request_rate:
    'sum(rate(velora_auth_requests_total{service="auth-service",operation="login"}[1m]))',
  auth_login_success_rate:
    '(sum(rate(velora_auth_requests_total{service="auth-service",operation="login",outcome="success"}[1m])) / clamp_min(sum(rate(velora_auth_requests_total{service="auth-service",operation="login"}[1m])), 0.000001)) and on() (sum(rate(velora_auth_requests_total{service="auth-service",operation="login"}[1m])) > 0)',
  auth_refresh_request_rate:
    'sum(rate(velora_auth_requests_total{service="auth-service",operation="refresh"}[1m]))',
  auth_refresh_success_rate:
    '(sum(rate(velora_auth_refresh_rotations_total{service="auth-service",outcome=~"success|recovered"}[1m])) / clamp_min(sum(rate(velora_auth_requests_total{service="auth-service",operation="refresh"}[1m])), 0.000001)) and on() (sum(rate(velora_auth_requests_total{service="auth-service",operation="refresh"}[1m])) > 0)',
  auth_refresh_recovered_rate:
    'sum(rate(velora_auth_refresh_rotations_total{service="auth-service",outcome="recovered"}[1m]))',
  auth_refresh_replay_rate:
    'sum(rate(velora_auth_refresh_rotations_total{service="auth-service",outcome="replay_detected"}[1m]))',
  auth_cleanup_age_seconds:
    'max(time() - velora_auth_token_cleanup_last_success_timestamp_seconds{service="auth-service"})',
  auth_queue_ready:
    'sum(rabbitmq_detailed_queue_messages_ready{job="rabbitmq-auth-user",queue="auth_queue"})',
  auth_queue_unacked:
    'sum(rabbitmq_detailed_queue_messages_unacked{job="rabbitmq-auth-user",queue="auth_queue"})',
  auth_consumers:
    'sum(rabbitmq_detailed_queue_consumers{job="rabbitmq-auth-user",queue="auth_queue"})',
  user_cpu: processCpuUsageQuery('user-service'),
  user_memory:
    'sum(velora_process_resident_memory_bytes{service="user-service"})',
  user_event_loop_p99:
    'max(velora_nodejs_event_loop_lag_p99_seconds{service="user-service"})',
  user_database_up: 'max(velora_user_database_up{service="user-service"})',
  user_request_rate:
    'sum(rate(velora_user_requests_total{service="user-service"}[1m]))',
  user_error_rate:
    '(sum(rate(velora_user_requests_total{service="user-service",outcome="error"}[1m])) / clamp_min(sum(rate(velora_user_requests_total{service="user-service"}[1m])), 0.000001)) and on() (sum(rate(velora_user_requests_total{service="user-service"}[1m])) > 0)',
  user_p95_latency:
    'histogram_quantile(0.95, sum by (le) (rate(velora_user_request_duration_seconds_bucket{service="user-service"}[1m])))',
  user_create_request_rate:
    'sum(rate(velora_user_requests_total{service="user-service",operation="create"}[1m]))',
  user_search_request_rate:
    'sum(rate(velora_user_requests_total{service="user-service",operation="search"}[1m]))',
  user_search_p95_latency:
    'histogram_quantile(0.95, sum by (le) (rate(velora_user_request_duration_seconds_bucket{service="user-service",operation="search"}[1m])))',
  user_recommendation_request_rate:
    'sum(rate(velora_user_requests_total{service="user-service",operation="recommendations"}[1m]))',
  user_recommendation_p95_latency:
    'histogram_quantile(0.95, sum by (le) (rate(velora_user_request_duration_seconds_bucket{service="user-service",operation="recommendations"}[1m])))',
  user_recommendation_candidates:
    '(sum(rate(velora_user_recommendation_candidates_total{service="user-service"}[1m])) / clamp_min(sum(rate(velora_user_requests_total{service="user-service",operation="recommendations",outcome="success"}[1m])), 0.000001)) and on() (sum(rate(velora_user_requests_total{service="user-service",operation="recommendations",outcome="success"}[1m])) > 0)',
  user_storage_failure_rate:
    '(sum(rate(velora_user_storage_operations_total{service="user-service",outcome="error"}[1m])) / clamp_min(sum(rate(velora_user_storage_operations_total{service="user-service"}[1m])), 0.000001)) and on() (sum(rate(velora_user_storage_operations_total{service="user-service"}[1m])) > 0)',
  user_queue_ready:
    'sum(rabbitmq_detailed_queue_messages_ready{job="rabbitmq-auth-user",queue="user_queue"})',
  user_queue_unacked:
    'sum(rabbitmq_detailed_queue_messages_unacked{job="rabbitmq-auth-user",queue="user_queue"})',
  user_consumers:
    'sum(rabbitmq_detailed_queue_consumers{job="rabbitmq-auth-user",queue="user_queue"})',
  rag_request_rate:
    'sum(rate(velora_rag_requests_total{service="ai-service"}[1m]))',
  rag_failure_rate: observedRatioQuery(
    'sum(rate(velora_rag_requests_total{service="ai-service",outcome="FAILED"}[1m]))',
    'sum(rate(velora_rag_requests_total{service="ai-service"}[1m]))',
  ),
  rag_p95_latency:
    'histogram_quantile(0.95, sum by (le) (rate(velora_rag_request_duration_seconds_bucket{service="ai-service"}[1m])))',
  rag_avg_retrieved_chunks:
    '(sum(rate(velora_rag_retrieved_chunks_total{service="ai-service"}[1m])) / clamp_min(sum(rate(velora_rag_requests_total{service="ai-service"}[1m])), 0.000001)) and on() (sum(rate(velora_rag_requests_total{service="ai-service"}[1m])) > 0)',
  rag_context_insufficient_rate:
    '(sum(rate(velora_rag_context_insufficient_total{service="ai-service"}[1m])) / clamp_min(sum(rate(velora_rag_requests_total{service="ai-service"}[1m])), 0.000001)) and on() (sum(rate(velora_rag_requests_total{service="ai-service"}[1m])) > 0)',
  rag_verifier_failure_rate:
    '(sum(rate(velora_rag_verifier_failures_total{service="ai-service"}[1m])) / clamp_min(sum(rate(velora_rag_requests_total{service="ai-service"}[1m])), 0.000001)) and on() (sum(rate(velora_rag_requests_total{service="ai-service"}[1m])) > 0)',
  rag_fallback_rate:
    '(sum(rate(velora_rag_fallbacks_total{service="ai-service"}[1m])) / clamp_min(sum(rate(velora_rag_requests_total{service="ai-service"}[1m])), 0.000001)) and on() (sum(rate(velora_rag_requests_total{service="ai-service"}[1m])) > 0)',
  rag_retries_per_request: observedRatioQuery(
    'sum(rate(velora_rag_retries_total{service="ai-service"}[1m]))',
    'sum(rate(velora_rag_requests_total{service="ai-service"}[1m]))',
  ),
  rag_input_token_rate:
    'sum(rate(velora_rag_input_tokens_total{service="ai-service"}[1m]))',
  rag_output_token_rate:
    'sum(rate(velora_rag_output_tokens_total{service="ai-service"}[1m]))',
  rag_total_token_rate:
    'sum(rate(velora_rag_tokens_total{service="ai-service"}[1m]))',
  rag_avg_tokens_per_request:
    '(sum(rate(velora_rag_tokens_total{service="ai-service"}[1m])) / clamp_min(sum(rate(velora_rag_requests_total{service="ai-service"}[1m])), 0.000001)) and on() (sum(rate(velora_rag_requests_total{service="ai-service"}[1m])) > 0)',
  rag_p95_tokens_per_request:
    'histogram_quantile(0.95, sum by (le) (rate(velora_rag_request_tokens_bucket{service="ai-service"}[1m])))',
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
    'sum(rate(velora_reel_worker_stage_runs_total{pipeline="MEDIA",stage="TOTAL_PIPELINE",outcome="SUCCEEDED"}[1m]))',
  reel_media_failure_rate: observedRatioQuery(
    'sum(rate(velora_reel_worker_stage_runs_total{pipeline="MEDIA",stage="TOTAL_PIPELINE",outcome="FAILED"}[1m]))',
    'sum(rate(velora_reel_worker_stage_runs_total{pipeline="MEDIA",stage="TOTAL_PIPELINE"}[1m]))',
  ),
  reel_media_retry_rate: observedRatioQuery(
    'sum(rate(velora_reel_worker_retries_total{pipeline="MEDIA"}[1m]))',
    'sum(rate(velora_reel_worker_stage_runs_total{pipeline="MEDIA",stage="TOTAL_PIPELINE"}[1m]))',
  ),
  reel_media_p95_latency:
    'histogram_quantile(0.95, sum by (le) (rate(velora_reel_worker_stage_duration_seconds_bucket{pipeline="MEDIA",stage="TOTAL_PIPELINE"}[1m])))',
  reel_media_queue_wait_p95:
    'histogram_quantile(0.95, sum by (le) (rate(velora_reel_worker_stage_duration_seconds_bucket{pipeline="MEDIA",stage="QUEUE_WAIT"}[1m])))',
  reel_media_exhausted_retry_rate:
    'sum(rate(velora_reel_worker_exhausted_retries_total{pipeline="MEDIA"}[1m]))',
  reel_index_throughput:
    'sum(rate(velora_reel_worker_stage_runs_total{pipeline="INDEX",stage="TOTAL_PIPELINE",outcome="SUCCEEDED"}[1m]))',
  reel_index_failure_rate: observedRatioQuery(
    'sum(rate(velora_reel_worker_stage_runs_total{pipeline="INDEX",stage="TOTAL_PIPELINE",outcome="FAILED"}[1m]))',
    'sum(rate(velora_reel_worker_stage_runs_total{pipeline="INDEX",stage="TOTAL_PIPELINE"}[1m]))',
  ),
  reel_index_retry_rate: observedRatioQuery(
    'sum(rate(velora_reel_worker_retries_total{pipeline="INDEX"}[1m]))',
    'sum(rate(velora_reel_worker_stage_runs_total{pipeline="INDEX",stage="TOTAL_PIPELINE"}[1m]))',
  ),
  reel_index_p95_latency:
    'histogram_quantile(0.95, sum by (le) (rate(velora_reel_worker_stage_duration_seconds_bucket{pipeline="INDEX",stage="TOTAL_PIPELINE"}[1m])))',
  reel_index_queue_wait_p95:
    'histogram_quantile(0.95, sum by (le) (rate(velora_reel_worker_stage_duration_seconds_bucket{pipeline="INDEX",stage="QUEUE_WAIT"}[1m])))',
  reel_index_exhausted_retry_rate:
    'sum(rate(velora_reel_worker_exhausted_retries_total{pipeline="INDEX"}[1m]))',
  reel_index_chunk_rate:
    'sum(rate(velora_reel_index_items_total{kind="chunk"}[1m]))',
  reel_index_zero_chunk_rate:
    '(sum(rate(velora_reel_index_zero_chunk_total[1m])) / clamp_min(sum(rate(velora_reel_worker_stage_runs_total{pipeline="INDEX",stage="TOTAL_PIPELINE",outcome="SUCCEEDED"}[1m])), 0.000001)) and on() (sum(rate(velora_reel_worker_stage_runs_total{pipeline="INDEX",stage="TOTAL_PIPELINE",outcome="SUCCEEDED"}[1m])) > 0)',
  reel_rabbitmq_up: 'max(up{job="rabbitmq-reels"})',
  reel_media_queue_ready:
    'sum(rabbitmq_detailed_queue_messages_ready{job="rabbitmq-reels",queue=~"reel_media_(short|long)_jobs"})',
  reel_media_queue_unacked:
    'sum(rabbitmq_detailed_queue_messages_unacked{job="rabbitmq-reels",queue=~"reel_media_(short|long)_jobs"})',
  reel_media_consumers:
    'sum(rabbitmq_detailed_queue_consumers{job="rabbitmq-reels",queue=~"reel_media_(short|long)_jobs"})',
  reel_media_retry_queue_depth:
    'sum(rabbitmq_detailed_queue_messages_ready{job="rabbitmq-reels",queue=~"reel_media_(short_retry_30s|short_retry_5m|long_retry_60s|long_retry_10m)"})',
  reel_media_dlq_depth:
    'sum(rabbitmq_detailed_queue_messages_ready{job="rabbitmq-reels",queue=~"reel_media_(short|long)_dlq"})',
  reel_media_publish_rate:
    'sum(rate(rabbitmq_detailed_queue_messages_published_total{job="rabbitmq-reels",queue=~"reel_media_.*"}[1m]))',
  reel_media_delivery_rate:
    'sum(rate(rabbitmq_detailed_channel_messages_delivered_ack_total{job="rabbitmq-reels",queue=~"reel_media_.*"}[1m])) + sum(rate(rabbitmq_detailed_channel_messages_delivered_total{job="rabbitmq-reels",queue=~"reel_media_.*"}[1m]))',
  reel_index_queue_ready:
    'sum(rabbitmq_detailed_queue_messages_ready{job="rabbitmq-reels",queue=~"reel_index_(short|long)_jobs"})',
  reel_index_queue_unacked:
    'sum(rabbitmq_detailed_queue_messages_unacked{job="rabbitmq-reels",queue=~"reel_index_(short|long)_jobs"})',
  reel_index_consumers:
    'sum(rabbitmq_detailed_queue_consumers{job="rabbitmq-reels",queue=~"reel_index_(short|long)_jobs"})',
  reel_index_retry_queue_depth:
    'sum(rabbitmq_detailed_queue_messages_ready{job="rabbitmq-reels",queue=~"reel_index_(short_retry_30s|short_retry_5m|long_retry_60s|long_retry_10m)"})',
  reel_index_dlq_depth:
    'sum(rabbitmq_detailed_queue_messages_ready{job="rabbitmq-reels",queue=~"reel_index_(short|long)_dlq"})',
  reel_index_publish_rate:
    'sum(rate(rabbitmq_detailed_queue_messages_published_total{job="rabbitmq-reels",queue=~"reel_index_.*"}[1m]))',
  reel_index_delivery_rate:
    'sum(rate(rabbitmq_detailed_channel_messages_delivered_ack_total{job="rabbitmq-reels",queue=~"reel_index_.*"}[1m])) + sum(rate(rabbitmq_detailed_channel_messages_delivered_total{job="rabbitmq-reels",queue=~"reel_index_.*"}[1m]))',
} as const satisfies Record<MonitoringMetric, string>;
type PrometheusVectorSample = Awaited<
  ReturnType<PrometheusQueryService['vector']>
>[number];

type ReelQueueOverview = {
  queue: string;
  vhost: string;
  ready: number | null;
  consumers: number | null;
};

const mergeReelQueueSamples = (
  readySamples: readonly PrometheusVectorSample[],
  consumerSamples: readonly PrometheusVectorSample[],
): ReelQueueOverview[] => {
  const queues = new Map<string, ReelQueueOverview>();
  const addSamples = (
    samples: readonly PrometheusVectorSample[],
    field: 'ready' | 'consumers',
  ) => {
    for (const sample of samples) {
      const queue = sample.metric.queue?.trim();
      if (!queue) continue;
      const vhost = sample.metric.vhost?.trim() || 'unknown';
      const key = `${queue}\u0000${vhost}`;
      const current = queues.get(key) ?? {
        queue,
        vhost,
        ready: null,
        consumers: null,
      };
      queues.set(key, { ...current, [field]: sample.value });
    }
  };

  addSamples(readySamples, 'ready');
  addSamples(consumerSamples, 'consumers');

  return [...queues.values()].sort(
    (left, right) =>
      left.queue.localeCompare(right.queue) ||
      left.vhost.localeCompare(right.vhost),
  );
};

type TimeseriesPayload = {
  metric?: unknown;
  host?: unknown;
  from?: unknown;
  to?: unknown;
  stepSeconds?: unknown;
};

// The container dialog polls every few seconds; two admins should not double
// the Docker Engine sampling.
const CONTAINER_SNAPSHOT_TTL_MS = 2_000;

const LOCAL_DOCKER = { key: 'local', endpoint: undefined } as const;

@Controller()
export class SystemMetricsController {
  private overviewRequest: ReturnType<
    SystemMetricsController['fetchOverview']
  > | null = null;
  private overviewExpiresAt = 0;

  private readonly containerSnapshots = new KeyedTtlSingleFlight<
    Awaited<ReturnType<SystemMetricsController['readContainers']>>
  >(CONTAINER_SNAPSHOT_TTL_MS);

  constructor(
    private readonly prometheus: PrometheusQueryService,
    private readonly metrics: PrometheusMetricsService,
    private readonly docker: DockerEngineService,
    private readonly hosts: HostRegistryService,
  ) {}

  @MessagePattern('system.metrics.status')
  async status() {
    return this.measure('system.metrics.status', async () => {
      try {
        const [monitoringUp, hostUp, hostTargets] = await Promise.all([
          this.prometheus.scalar('max(up{job="monitoring-service"})'),
          this.prometheus.scalar(PRIMARY_HOST_UP_QUERY),
          this.prometheus.vector(HOST_REGISTRY_QUERY),
        ]);
        const hosts = mergeHostRecords(hostTargets);

        return {
          generatedAt: new Date().toISOString(),
          source: 'prometheus' as const,
          monitoringUp: targetStatus(monitoringUp),
          // The machine that runs the stack; other VPSs are in `hosts`.
          hostUp: targetStatus(hostUp),
          hosts: {
            total: hosts.length,
            up: hosts.filter((host) => host.up).length,
          },
        };
      } catch (error) {
        throw this.prometheusError(error);
      }
    });
  }

  @MessagePattern('system.metrics.containers')
  async containers(@Payload() payload?: { host?: unknown }) {
    return this.measure('system.metrics.containers', async () => {
      const hostId = this.parseHostId(payload?.host);
      const target = hostId
        ? await this.resolveDockerTarget(hostId)
        : LOCAL_DOCKER;

      if (target === null) {
        return {
          generatedAt: new Date().toISOString(),
          source: 'docker' as const,
          dockerEngineUp: null,
          containers: [],
          reason: 'not-configured' as const,
        };
      }

      try {
        // Sampling every container costs about a second per call and the
        // dialog polls: share one batch between concurrent viewers.
        return await this.containerSnapshots.get(target.key, () =>
          this.readContainers(target.endpoint),
        );
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

  private async readContainers(endpoint: DockerEndpoint | undefined) {
    const [snapshot, metadata] = await Promise.all([
      this.readDockerSnapshot(endpoint),
      this.readDockerSnapshotMetadata(endpoint),
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
  }

  /** `null` when the host's containers cannot be read from here. */
  private async resolveDockerTarget(
    hostId: string,
  ): Promise<{ key: string; endpoint: DockerEndpoint | undefined } | null> {
    const host = await this.requireHost(hostId);

    if (host.containers === 'local') return LOCAL_DOCKER;
    if (host.containers === 'remote' && host.dockerEndpoint) {
      return { key: host.id, endpoint: host.dockerEndpoint };
    }

    return null;
  }

  private async requireHost(hostId: string) {
    try {
      return await this.hosts.require(hostId);
    } catch (error) {
      // An unknown host is a client error; anything else is Prometheus.
      throw error instanceof RpcException ? error : this.prometheusError(error);
    }
  }

  private parseHostId(value: unknown): string | undefined {
    if (value === undefined || value === null || value === '') {
      return undefined;
    }

    if (typeof value !== 'string' || !HOST_ID_PATTERN.test(value)) {
      throw new RpcException({ statusCode: 400, message: 'host is invalid' });
    }

    return value;
  }

  private readDockerSnapshot(endpoint: DockerEndpoint | undefined): Promise<{
    containers: DockerContainerResource[];
    runningContainers?: number;
    sampledContainers?: number;
  }> {
    const snapshotWithCoverage = (
      this.docker as DockerEngineService & {
        snapshotWithCoverage?: (
          endpoint?: DockerEndpoint,
        ) => Promise<DockerSnapshot>;
      }
    ).snapshotWithCoverage;

    if (typeof snapshotWithCoverage === 'function') {
      return Promise.resolve(snapshotWithCoverage.call(this.docker, endpoint));
    }

    return Promise.resolve(this.docker.snapshot(endpoint)).then(
      (containers) => ({ containers }),
    );
  }

  private readDockerSnapshotMetadata(
    endpoint: DockerEndpoint | undefined,
  ): Promise<DockerSnapshotMetadata | null> {
    const snapshotMetadata = (
      this.docker as DockerEngineService & {
        snapshotMetadata?: (
          endpoint?: DockerEndpoint,
        ) => Promise<DockerSnapshotMetadata>;
      }
    ).snapshotMetadata;

    if (typeof snapshotMetadata !== 'function') {
      return Promise.resolve(null);
    }

    return Promise.resolve(snapshotMetadata.call(this.docker, endpoint)).catch(
      () => null,
    );
  }

  @MessagePattern('system.metrics.overview')
  async overview() {
    return this.measure('system.metrics.overview', () => {
      if (!this.overviewRequest || Date.now() >= this.overviewExpiresAt) {
        // Share the 130-query fan-out across callers for one scrape interval.
        // In-flight calls are shared too; failures are never cached.
        this.overviewExpiresAt = Infinity;
        this.overviewRequest = this.fetchOverview().then(
          (overview) => {
            this.overviewExpiresAt = Date.now() + 5000;
            return overview;
          },
          (error: unknown) => {
            this.overviewRequest = null;
            throw error;
          },
        );
      }
      return this.overviewRequest;
    });
  }

  private async fetchOverview() {
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
        callMediaWorkerCpuRatio,
        callMediaRooms,
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
        authUp,
        authCpuUsageRatio,
        authResidentMemoryBytes,
        authEventLoopP99Seconds,
        authDatabaseUp,
        authRedisUp,
        authRequestsPerSecond,
        authErrorRate,
        authP95LatencySeconds,
        authLoginRequestsPerSecond,
        authLoginSuccessRate,
        authRefreshRequestsPerSecond,
        authRefreshSuccessRate,
        authRefreshRecoveriesPerSecond,
        authRefreshReplayDetectionsPerSecond,
        authCleanupAgeSeconds,
        authQueueReady,
        authQueueUnacked,
        authConsumers,
        userUp,
        userCpuUsageRatio,
        userResidentMemoryBytes,
        userEventLoopP99Seconds,
        userDatabaseUp,
        userRequestsPerSecond,
        userErrorRate,
        userP95LatencySeconds,
        userCreateRequestsPerSecond,
        userSearchRequestsPerSecond,
        userSearchP95LatencySeconds,
        userRecommendationRequestsPerSecond,
        userRecommendationP95LatencySeconds,
        userRecommendationCandidates,
        userStorageFailureRate,
        userQueueReady,
        userQueueUnacked,
        userConsumers,
        chatPhaseP95,
        chatPhaseRates,
        chatPhaseErrors,
        reelQueueReadySamples,
        reelQueueConsumerSamples,
      ] = await Promise.all([
        this.prometheus.scalar('max(up{job="monitoring-service"})'),
        this.prometheus.scalar(RANGE_QUERIES.memory),
        this.prometheus.scalar(RANGE_QUERIES.heap),
        this.prometheus.scalar(RANGE_QUERIES.cpu),
        this.prometheus.scalar(RANGE_QUERIES.event_loop_p99),
        this.prometheus.scalar(RANGE_QUERIES.rpc_rate),
        this.prometheus.scalar(RANGE_QUERIES.error_rate),
        this.prometheus.scalar(RANGE_QUERIES.p95_rpc_latency),
        this.prometheus.scalar(PRIMARY_HOST_UP_QUERY),
        this.prometheus.scalar(PRIMARY_HOST.cpuUsageRatio),
        this.prometheus.scalar(PRIMARY_HOST.memoryTotalBytes),
        this.prometheus.scalar(PRIMARY_HOST.memoryAvailableBytes),
        this.prometheus.scalar(PRIMARY_HOST.swapTotalBytes),
        this.prometheus.scalar(PRIMARY_HOST.swapFreeBytes),
        this.prometheus.scalar(PRIMARY_HOST.diskTotalBytes),
        this.prometheus.scalar(PRIMARY_HOST.diskAvailableBytes),
        this.prometheus.scalar(PRIMARY_HOST.load1),
        this.prometheus.scalar(PRIMARY_HOST.uptimeSeconds),
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
        this.prometheus.scalar(RANGE_QUERIES.call_media_worker_cpu),
        this.prometheus.scalar(RANGE_QUERIES.call_media_rooms),
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
        this.prometheus.scalar('max(up{job="auth-service"})'),
        this.prometheus.scalar(RANGE_QUERIES.auth_cpu),
        this.prometheus.scalar(RANGE_QUERIES.auth_memory),
        this.prometheus.scalar(RANGE_QUERIES.auth_event_loop_p99),
        this.prometheus.scalar(RANGE_QUERIES.auth_database_up),
        this.prometheus.scalar(RANGE_QUERIES.auth_redis_up),
        this.prometheus.scalar(RANGE_QUERIES.auth_request_rate),
        this.prometheus.scalar(RANGE_QUERIES.auth_error_rate),
        this.prometheus.scalar(RANGE_QUERIES.auth_p95_latency),
        this.prometheus.scalar(RANGE_QUERIES.auth_login_request_rate),
        this.prometheus.scalar(RANGE_QUERIES.auth_login_success_rate),
        this.prometheus.scalar(RANGE_QUERIES.auth_refresh_request_rate),
        this.prometheus.scalar(RANGE_QUERIES.auth_refresh_success_rate),
        this.prometheus.scalar(RANGE_QUERIES.auth_refresh_recovered_rate),
        this.prometheus.scalar(RANGE_QUERIES.auth_refresh_replay_rate),
        this.prometheus.scalar(RANGE_QUERIES.auth_cleanup_age_seconds),
        this.prometheus.scalar(RANGE_QUERIES.auth_queue_ready),
        this.prometheus.scalar(RANGE_QUERIES.auth_queue_unacked),
        this.prometheus.scalar(RANGE_QUERIES.auth_consumers),
        this.prometheus.scalar('max(up{job="user-service"})'),
        this.prometheus.scalar(RANGE_QUERIES.user_cpu),
        this.prometheus.scalar(RANGE_QUERIES.user_memory),
        this.prometheus.scalar(RANGE_QUERIES.user_event_loop_p99),
        this.prometheus.scalar(RANGE_QUERIES.user_database_up),
        this.prometheus.scalar(RANGE_QUERIES.user_request_rate),
        this.prometheus.scalar(RANGE_QUERIES.user_error_rate),
        this.prometheus.scalar(RANGE_QUERIES.user_p95_latency),
        this.prometheus.scalar(RANGE_QUERIES.user_create_request_rate),
        this.prometheus.scalar(RANGE_QUERIES.user_search_request_rate),
        this.prometheus.scalar(RANGE_QUERIES.user_search_p95_latency),
        this.prometheus.scalar(RANGE_QUERIES.user_recommendation_request_rate),
        this.prometheus.scalar(RANGE_QUERIES.user_recommendation_p95_latency),
        this.prometheus.scalar(RANGE_QUERIES.user_recommendation_candidates),
        this.prometheus.scalar(RANGE_QUERIES.user_storage_failure_rate),
        this.prometheus.scalar(RANGE_QUERIES.user_queue_ready),
        this.prometheus.scalar(RANGE_QUERIES.user_queue_unacked),
        this.prometheus.scalar(RANGE_QUERIES.user_consumers),
        this.prometheus.vector(
          'histogram_quantile(0.95, sum by (phase, le) (rate(velora_conversation_send_phase_duration_seconds_bucket[1m])))',
        ),
        this.prometheus.vector(
          'sum by (phase) (rate(velora_conversation_send_phase_duration_seconds_count[1m]))',
        ),
        this.prometheus.vector(
          'sum by (phase) (rate(velora_conversation_send_phase_duration_seconds_count{status="error"}[1m]))',
        ),
        this.prometheus.vector(REEL_QUEUE_READY_QUERY),
        this.prometheus.vector(REEL_QUEUE_CONSUMERS_QUERY),
      ]);

      const reelQueues = mergeReelQueueSamples(
        reelQueueReadySamples,
        reelQueueConsumerSamples,
      );

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
          sendPhases: chatPhaseRates.map((sample) => ({
            phase: sample.metric.phase,
            callsPerSecond: sample.value,
            errorsPerSecond:
              chatPhaseErrors.find(
                (error) => error.metric.phase === sample.metric.phase,
              )?.value ?? 0,
            p95Seconds:
              chatPhaseP95.find(
                (p95) => p95.metric.phase === sample.metric.phase,
              )?.value ?? null,
          })),
        },
        call: {
          up: targetStatus(callUp),
          residentMemoryBytes: callResidentMemoryBytes,
          cpuUsageRatio: callCpuUsageRatio,
          eventLoopP99Seconds: callEventLoopP99Seconds,
          socketConnections: callSocketConnections,
          mediaWorkerCpuRatio: callMediaWorkerCpuRatio,
          mediaRooms: callMediaRooms,
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
        auth: {
          up: targetStatus(authUp),
          residentMemoryBytes: authResidentMemoryBytes,
          cpuUsageRatio: authCpuUsageRatio,
          eventLoopP99Seconds: authEventLoopP99Seconds,
          databaseUp: targetStatus(authDatabaseUp),
          redisUp: targetStatus(authRedisUp),
          requestsPerSecond: authRequestsPerSecond,
          errorRate: authErrorRate,
          p95LatencySeconds: authP95LatencySeconds,
          loginRequestsPerSecond: authLoginRequestsPerSecond,
          loginSuccessRate: authLoginSuccessRate,
          refreshRequestsPerSecond: authRefreshRequestsPerSecond,
          refreshSuccessRate: authRefreshSuccessRate,
          refreshRecoveriesPerSecond: authRefreshRecoveriesPerSecond,
          replayDetectionsPerSecond: authRefreshReplayDetectionsPerSecond,
          cleanupAgeSeconds: authCleanupAgeSeconds,
          queueReady: authQueueReady,
          queueUnacked: authQueueUnacked,
          consumers: authConsumers,
        },
        user: {
          up: targetStatus(userUp),
          residentMemoryBytes: userResidentMemoryBytes,
          cpuUsageRatio: userCpuUsageRatio,
          eventLoopP99Seconds: userEventLoopP99Seconds,
          databaseUp: targetStatus(userDatabaseUp),
          requestsPerSecond: userRequestsPerSecond,
          errorRate: userErrorRate,
          p95LatencySeconds: userP95LatencySeconds,
          createRequestsPerSecond: userCreateRequestsPerSecond,
          searchRequestsPerSecond: userSearchRequestsPerSecond,
          searchP95LatencySeconds: userSearchP95LatencySeconds,
          recommendationRequestsPerSecond: userRecommendationRequestsPerSecond,
          recommendationP95LatencySeconds: userRecommendationP95LatencySeconds,
          recommendationCandidates: userRecommendationCandidates,
          storageFailureRate: userStorageFailureRate,
          queueReady: userQueueReady,
          queueUnacked: userQueueUnacked,
          consumers: userConsumers,
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
            queues: reelQueues.filter((queue) =>
              queue.queue.startsWith('reel_media_'),
            ),
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
            queues: reelQueues.filter((queue) =>
              queue.queue.startsWith('reel_index_'),
            ),
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
  }

  @MessagePattern('system.metrics.timeseries')
  async timeseries(@Payload() payload: TimeseriesPayload) {
    return this.measure('system.metrics.timeseries', async () => {
      const query = this.parseTimeseriesPayload(payload);

      try {
        const promql = await this.timeseriesQuery(query);
        const points = await this.prometheus.range(
          promql,
          query.from,
          query.to,
          query.stepSeconds,
        );

        return {
          metric: query.metric,
          ...(query.host ? { host: query.host } : {}),
          from: query.from,
          to: query.to,
          stepSeconds: query.stepSeconds,
          points,
        };
      } catch (error) {
        throw error instanceof RpcException
          ? error
          : this.prometheusError(error);
      }
    });
  }

  /** Host metrics follow the requested host, or the primary machine. */
  private async timeseriesQuery(query: {
    metric: MonitoringMetric | HostTimeseriesMetric;
    host?: string;
  }): Promise<string> {
    if (!HOST_TIMESERIES_METRIC_SET.has(query.metric)) {
      return RANGE_QUERIES[query.metric as MonitoringMetric];
    }

    const host = query.host ? await this.requireHost(query.host) : null;

    if (query.metric.startsWith('host_network_')) {
      const target = host ?? defaultHostOf(await this.hosts.list());
      if (target?.network === 'unavailable') {
        throw new RpcException({
          statusCode: 400,
          message:
            'network metrics are not available for this host: its node-exporter cannot see the machine network interfaces',
        });
      }
    }

    return hostTimeseriesQuery(
      query.metric as HostTimeseriesMetric,
      host ? hostScope(host) : PRIMARY_HOST_SCOPE,
    );
  }

  private parseTimeseriesPayload(payload: TimeseriesPayload) {
    const metric = payload?.metric;

    if (
      typeof metric !== 'string' ||
      !(
        MONITORING_METRIC_SET.has(metric) ||
        HOST_TIMESERIES_METRIC_SET.has(metric)
      )
    ) {
      throw new RpcException({
        statusCode: 400,
        message: `metric must be one of: ${[
          ...MONITORING_METRICS,
          ...HOST_TIMESERIES_METRICS.filter(
            (name) => !MONITORING_METRIC_SET.has(name),
          ),
        ].join(', ')}`,
      });
    }

    const range = parseTimeRange(payload);
    const host = this.parseHostId(payload?.host);

    if (host !== undefined && !HOST_TIMESERIES_METRIC_SET.has(metric)) {
      throw new RpcException({
        statusCode: 400,
        message: 'host is only supported for host_* metrics',
      });
    }

    return {
      metric: metric as MonitoringMetric | HostTimeseriesMetric,
      host,
      ...range,
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
