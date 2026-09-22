import { Role, Roles } from '@gateway/auth/decorators/roles.decorator';
import type { AuthenticatedRequest } from '@gateway/auth/guards/jwt-auth.guard';
import { JwtAuthGuard } from '@gateway/auth/guards/jwt-auth.guard';
import { RolesGuard } from '@gateway/auth/guards/roles.guard';
import {
  BadRequestException,
  Controller,
  Get,
  Inject,
  Req,
  UseGuards,
} from '@nestjs/common';
import { ClientProxy } from '@nestjs/microservices';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { lastValueFrom, timeout } from 'rxjs';

const ALLOWED_METRICS = new Set([
  'memory',
  'heap',
  'cpu',
  'rpc_rate',
  'error_rate',
  'p95_rpc_latency',
  'event_loop_p99',
  'host_cpu',
  'host_memory',
  'host_swap',
  'host_disk',
  'host_load1',
  'conversation_cpu',
  'conversation_memory',
  'conversation_event_loop_p99',
  'conversation_sockets',
  'conversation_message_rate',
  'conversation_send_rate',
  'conversation_success_rate',
  'conversation_reject_rate',
  'conversation_error_rate',
  'conversation_p95_send_latency',
  'call_cpu',
  'call_memory',
  'call_event_loop_p99',
  'call_sockets',
  'notification_cpu',
  'notification_memory',
  'notification_event_loop_p99',
  'notification_database_up',
  'notification_apns_request_rate',
  'notification_apns_transport_failure_rate',
  'notification_retry_scheduler_completion_age_seconds',
  'rag_request_rate',
  'rag_failure_rate',
  'rag_p95_latency',
  'rag_avg_retrieved_chunks',
  'rag_context_insufficient_rate',
  'rag_verifier_failure_rate',
  'rag_fallback_rate',
  'rag_retries_per_request',
  'rag_input_token_rate',
  'rag_output_token_rate',
  'rag_total_token_rate',
  'rag_avg_tokens_per_request',
  'rag_p95_tokens_per_request',
  'reel_snapshot_up',
  'reel_queued',
  'reel_processing',
  'reel_ready',
  'reel_failed',
  'reel_degraded',
  'reel_stalled',
  'reel_recent_failed',
  'reel_ready_latency_p95',
  'reel_rabbitmq_up',
  'reel_media_throughput',
  'reel_media_failure_rate',
  'reel_media_retry_rate',
  'reel_media_p95_latency',
  'reel_media_queue_wait_p95',
  'reel_media_exhausted_retry_rate',
  'reel_media_queue_ready',
  'reel_media_queue_unacked',
  'reel_media_consumers',
  'reel_media_retry_queue_depth',
  'reel_media_dlq_depth',
  'reel_media_publish_rate',
  'reel_media_delivery_rate',
  'reel_index_throughput',
  'reel_index_failure_rate',
  'reel_index_retry_rate',
  'reel_index_p95_latency',
  'reel_index_queue_wait_p95',
  'reel_index_exhausted_retry_rate',
  'reel_index_chunk_rate',
  'reel_index_zero_chunk_rate',
  'reel_index_queue_ready',
  'reel_index_queue_unacked',
  'reel_index_consumers',
  'reel_index_retry_queue_depth',
  'reel_index_dlq_depth',
  'reel_index_publish_rate',
  'reel_index_delivery_rate',
]);

const ALLOWED_LOG_LEVELS = new Set(['all', 'error', 'warn', 'info', 'debug']);

@ApiTags('Monitoring')
@Controller('monitoring')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(Role.ADMIN)
@ApiBearerAuth()
export class MonitoringController {
  constructor(
    @Inject('MONITORING_SERVICE')
    private readonly monitoringClient: ClientProxy,
  ) {}

  @Get('overview')
  @ApiOperation({ summary: 'Get Prometheus-backed monitoring overview' })
  overview() {
    return lastValueFrom(
      this.monitoringClient
        .send('system.metrics.overview', {})
        .pipe(timeout(7000)),
    );
  }

  @Get('status')
  @ApiOperation({ summary: 'Get lightweight monitoring pipeline status' })
  status() {
    return lastValueFrom(
      this.monitoringClient
        .send('system.metrics.status', {})
        .pipe(timeout(5000)),
    );
  }

  @Get('containers')
  @ApiOperation({ summary: 'Get current resource usage for Docker containers' })
  containers() {
    return lastValueFrom(
      this.monitoringClient
        .send('system.metrics.containers', {})
        .pipe(timeout(7000)),
    );
  }

  @Get('timeseries')
  @ApiOperation({ summary: 'Get a bounded monitoring timeseries' })
  timeseries(@Req() request: AuthenticatedRequest) {
    const query = request.query as {
      metric?: string;
      from?: string;
      to?: string;
      stepSeconds?: string;
    };

    if (!query.metric || !ALLOWED_METRICS.has(query.metric)) {
      throw new BadRequestException(
        `metric must be one of: ${Array.from(ALLOWED_METRICS).join(', ')}`,
      );
    }

    if (!query.from || !query.to) {
      throw new BadRequestException('from and to are required');
    }

    return lastValueFrom(
      this.monitoringClient
        .send('system.metrics.timeseries', {
          metric: query.metric,
          from: query.from,
          to: query.to,
          stepSeconds: query.stepSeconds ? Number(query.stepSeconds) : 60,
        })
        .pipe(timeout(7000)),
    );
  }

  @Get('alerts')
  @ApiOperation({ summary: 'List active Prometheus alerts' })
  alerts() {
    return lastValueFrom(
      this.monitoringClient.send('system.alerts.list', {}).pipe(timeout(5000)),
    );
  }

  @Get('logs')
  @ApiOperation({ summary: 'Query bounded Docker service logs from Loki' })
  logs(@Req() request: AuthenticatedRequest) {
    const query = request.query as {
      service?: string;
      level?: string;
      search?: string;
      from?: string;
      to?: string;
      limit?: string;
    };

    const service = query.service?.trim() || 'all';
    const level = query.level?.trim() || 'all';
    const search = query.search?.trim() || '';
    const limit = query.limit ? Number(query.limit) : 200;

    if (!/^(all|[a-z0-9][a-z0-9_.-]{0,79})$/i.test(service)) {
      throw new BadRequestException('service is invalid');
    }

    if (!ALLOWED_LOG_LEVELS.has(level)) {
      throw new BadRequestException(
        `level must be one of: ${Array.from(ALLOWED_LOG_LEVELS).join(', ')}`,
      );
    }

    if (search.length > 200) {
      throw new BadRequestException('search cannot exceed 200 characters');
    }

    if (!query.from || !query.to) {
      throw new BadRequestException('from and to are required');
    }

    if (!Number.isInteger(limit) || limit < 20 || limit > 500) {
      throw new BadRequestException(
        'limit must be an integer between 20 and 500',
      );
    }

    return lastValueFrom(
      this.monitoringClient
        .send('system.logs.query', {
          service,
          level,
          search,
          from: query.from,
          to: query.to,
          limit,
        })
        .pipe(timeout(7000)),
    );
  }
}
