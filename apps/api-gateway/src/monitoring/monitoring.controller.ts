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
