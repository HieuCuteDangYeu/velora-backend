import type { AuthenticatedRequest } from '@gateway/auth/guards/jwt-auth.guard';
import { JwtAuthGuard } from '@gateway/auth/guards/jwt-auth.guard';
import {
  Body,
  Controller,
  ForbiddenException,
  Get,
  HttpException,
  HttpStatus,
  Inject,
  NotFoundException,
  Param,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import { ClientProxy } from '@nestjs/microservices';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { lastValueFrom, timeout } from 'rxjs';
import { TrackCallTelemetrySchema } from '@common/calls/dtos/call-telemetry.dto';
import { Role, Roles } from '@gateway/auth/decorators/roles.decorator';
import { RolesGuard } from '@gateway/auth/guards/roles.guard';

type CallStateLookupResponse =
  | {
      found: false;
      authorized: false;
    }
  | {
      found: true;
      authorized: false;
    }
  | {
      found: true;
      authorized: true;
      call: {
        callId: string;
        conversationId: string;
        initiatorId: string;
        targetUserId: string;
        recipientUserId: string;
        callType: 'VOICE' | 'VIDEO';
        status: string;
        initiatorDisplayName: string;
        initiatorAvatarUrl?: string;
        ringTimeoutMs: number;
        expiresAt: string;
      };
    };

@ApiTags('Calls')
@Controller('calls')
@UseGuards(JwtAuthGuard)
@ApiBearerAuth()
export class CallController {
  private readonly telemetryRequestTimesByUser = new Map<string, number[]>();

  constructor(
    @Inject('CALL_SERVICE') private readonly callClient: ClientProxy,
    @Inject('MONITORING_SERVICE')
    private readonly monitoringClient: ClientProxy,
  ) {}

  @Post('telemetry/events')
  @ApiOperation({ summary: 'Ingest sanitized call telemetry events' })
  async trackTelemetry(
    @Body() body: unknown,
    @Req() request: AuthenticatedRequest,
  ) {
    this.assertTelemetryRateLimit(request.user!.id);
    const payload = TrackCallTelemetrySchema.parse(body);
    return lastValueFrom(
      this.monitoringClient
        .send<{
          accepted: number;
          rejected: number;
        }>('call.telemetry.ingest', payload)
        .pipe(timeout(5000)),
    );
  }

  @Get('telemetry/summary')
  @UseGuards(RolesGuard)
  @Roles(Role.ADMIN)
  @ApiOperation({ summary: 'Get aggregated call telemetry' })
  async telemetrySummary(@Req() request: AuthenticatedRequest) {
    const query = request.query as {
      from?: string;
      to?: string;
      platform?: string;
      osVersion?: string;
      appVersion?: string;
      direction?: string;
    };
    if (!query.from || !query.to) {
      throw new ForbiddenException('from and to are required');
    }

    return lastValueFrom(
      this.monitoringClient
        .send<unknown>('call.telemetry.summary', query)
        .pipe(timeout(5000)),
    );
  }

  @Get('telemetry/calls/:callId')
  @UseGuards(RolesGuard)
  @Roles(Role.ADMIN)
  @ApiOperation({ summary: 'Get a call telemetry timeline' })
  async telemetryTimeline(@Param('callId') callId: string) {
    return lastValueFrom(
      this.monitoringClient
        .send<unknown>('call.telemetry.timeline', { callId })
        .pipe(timeout(5000)),
    );
  }

  @Get('telemetry/calls')
  @UseGuards(RolesGuard)
  @Roles(Role.ADMIN)
  @ApiOperation({ summary: 'Get recent call telemetry legs' })
  async recentTelemetryCalls(@Req() request: AuthenticatedRequest) {
    const query = request.query as {
      from?: string;
      to?: string;
      platform?: string;
      osVersion?: string;
      appVersion?: string;
      direction?: string;
    };
    if (!query.from || !query.to) {
      throw new ForbiddenException('from and to are required');
    }

    return lastValueFrom(
      this.monitoringClient
        .send<unknown>('call.telemetry.recent', query)
        .pipe(timeout(5000)),
    );
  }

  private assertTelemetryRateLimit(userId: string) {
    const now = Date.now();
    const recent = (this.telemetryRequestTimesByUser.get(userId) ?? []).filter(
      (timestamp) => timestamp > now - 60_000,
    );
    if (recent.length >= 120) {
      throw new HttpException(
        'Call telemetry rate limit exceeded',
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }

    recent.push(now);
    this.telemetryRequestTimesByUser.set(userId, recent);
  }

  @Get(':callId/state')
  @ApiOperation({ summary: 'Get the current state for a call before joining' })
  async getCallState(
    @Param('callId') callId: string,
    @Req() request: AuthenticatedRequest,
  ) {
    const result = await lastValueFrom(
      this.callClient
        .send<CallStateLookupResponse>('call.get_state', {
          callId,
          userId: request.user!.id,
        })
        .pipe(timeout(5000)),
    );

    if (!result.found) {
      throw new NotFoundException('Call not found');
    }

    if (!result.authorized) {
      throw new ForbiddenException('You are not part of this call');
    }

    return result.call;
  }
}
