import { MONITORING_METRIC_SET } from '@common/monitoring/monitoring-metrics';
import { Role, Roles } from '@gateway/auth/decorators/roles.decorator';
import type { AuthenticatedRequest } from '@gateway/auth/guards/jwt-auth.guard';
import { JwtAuthGuard } from '@gateway/auth/guards/jwt-auth.guard';
import { RolesGuard } from '@gateway/auth/guards/roles.guard';
import {
  BadRequestException,
  Controller,
  Get,
  Inject,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import { ClientProxy } from '@nestjs/microservices';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { lastValueFrom, timeout } from 'rxjs';

// Host metrics (host_cpu, host_network_receive, ...) are owned by the monitoring
// service, which validates the exact names; the gateway only rejects strings
// that cannot be a metric name.
const HOST_METRIC_SHAPE = /^host_[a-z0-9_]{1,40}$/;

const isAllowedMetric = (metric: string) =>
  MONITORING_METRIC_SET.has(metric) || HOST_METRIC_SHAPE.test(metric);

// Same shape the monitoring service enforces for a host id.
const HOST_ID_PATTERN = /^[a-z0-9][a-z0-9_.-]{0,63}$/i;

const parseHost = (value: string | undefined): string | undefined => {
  const host = value?.trim();
  if (!host) return undefined;
  if (!HOST_ID_PATTERN.test(host)) {
    throw new BadRequestException('host is invalid');
  }
  return host;
};

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

  @Get('hosts')
  @ApiOperation({
    summary: 'Get the current state of every monitored VPS',
  })
  hosts() {
    return lastValueFrom(
      this.monitoringClient.send('system.hosts.list', {}).pipe(timeout(7000)),
    );
  }

  @Get('hosts/history')
  @ApiOperation({
    summary: 'Get one bounded host metric series per monitored VPS',
  })
  hostsHistory(@Req() request: AuthenticatedRequest) {
    const query = request.query as {
      metric?: string;
      from?: string;
      to?: string;
      stepSeconds?: string;
    };

    if (!query.metric || !HOST_METRIC_SHAPE.test(query.metric)) {
      throw new BadRequestException('metric must be a host_* metric');
    }

    if (!query.from || !query.to) {
      throw new BadRequestException('from and to are required');
    }

    return lastValueFrom(
      this.monitoringClient
        .send('system.hosts.history', {
          metric: query.metric,
          from: query.from,
          to: query.to,
          stepSeconds: query.stepSeconds ? Number(query.stepSeconds) : 10,
        })
        .pipe(timeout(7000)),
    );
  }

  @Get('containers')
  @ApiOperation({ summary: 'Get current resource usage for Docker containers' })
  containers(@Query('host') hostParam?: string) {
    const host = parseHost(hostParam);

    return lastValueFrom(
      this.monitoringClient
        .send('system.metrics.containers', host ? { host } : {})
        .pipe(timeout(7000)),
    );
  }

  @Get('timeseries')
  @ApiOperation({ summary: 'Get a bounded monitoring timeseries' })
  timeseries(@Req() request: AuthenticatedRequest) {
    const query = request.query as {
      metric?: string;
      host?: string;
      from?: string;
      to?: string;
      stepSeconds?: string;
    };

    if (!query.metric || !isAllowedMetric(query.metric)) {
      throw new BadRequestException(
        `metric must be one of: ${Array.from(MONITORING_METRIC_SET).join(', ')}`,
      );
    }

    if (!query.from || !query.to) {
      throw new BadRequestException('from and to are required');
    }

    const host = parseHost(query.host);

    return lastValueFrom(
      this.monitoringClient
        .send('system.metrics.timeseries', {
          metric: query.metric,
          ...(host ? { host } : {}),
          from: query.from,
          to: query.to,
          stepSeconds: query.stepSeconds ? Number(query.stepSeconds) : 10,
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
      host?: string;
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
    const host = parseHost(query.host);

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
          ...(host ? { host } : {}),
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
