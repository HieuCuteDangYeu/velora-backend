import type { AuthenticatedRequest } from '@gateway/auth/guards/jwt-auth.guard';
import { JwtAuthGuard } from '@gateway/auth/guards/jwt-auth.guard';
import {
  BadRequestException,
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
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import { ClientProxy } from '@nestjs/microservices';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { catchError, lastValueFrom, of, timeout } from 'rxjs';
import type {
  CallHistoryItem,
  CallHistoryPage,
} from '@common/calls/call-history.types';
import { TrackCallTelemetrySchema } from '@common/calls/dtos/call-telemetry.dto';
import type { PublicUserProfile } from '@common/user/interfaces/public-user-profile.types';
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
        isGroupCall?: boolean;
        groupName?: string;
        groupAvatarUrl?: string;
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
    @Inject('USER_SERVICE') private readonly userClient: ClientProxy,
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

  @Get('conversations/:conversationId/active-group')
  @ApiOperation({ summary: 'Get the active group call in a conversation' })
  async getActiveGroupByConversation(
    @Param('conversationId') conversationId: string,
    @Req() request: AuthenticatedRequest,
  ) {
    return lastValueFrom(
      this.callClient
        .send<{
          call: {
            callId: string;
            conversationId: string;
            participantCount: number;
            startedAt: string;
            elapsedSeconds: number;
            joined: boolean;
          } | null;
        }>('call.get_active_group_by_conversation', {
          conversationId,
          userId: request.user!.id,
        })
        .pipe(timeout(5000)),
    );
  }

  @Get('history')
  @ApiOperation({ summary: 'List my calls, newest first' })
  async getHistory(
    @Req() request: AuthenticatedRequest,
    @Query('cursor') cursor?: string,
    @Query('limit') limit?: string,
  ) {
    const pageSize = limit === undefined ? 30 : Number(limit);
    if (!Number.isInteger(pageSize) || pageSize < 1 || pageSize > 50) {
      throw new BadRequestException('limit must be an integer from 1 to 50');
    }

    const page = await lastValueFrom(
      this.callClient
        .send<
          CallHistoryPage | { error: 'invalid_cursor' }
        >('call.get_history', { userId: request.user!.id, cursor, limit: pageSize })
        .pipe(timeout(5000)),
    );
    if ('error' in page) {
      throw new BadRequestException('Invalid cursor');
    }

    const profiles = await this.loadPeerProfiles(page.items);
    return {
      items: page.items.map((item) => ({
        ...item,
        peers: item.peerUserIds.map(
          (userId) =>
            profiles.get(userId) ?? {
              id: userId,
              fullName: null,
              username: null,
              picture: null,
            },
        ),
      })),
      nextCursor: page.nextCursor,
    };
  }

  @Get('history/missed-count')
  @ApiOperation({ summary: 'Count my missed calls I have not seen yet' })
  async getMissedCount(@Req() request: AuthenticatedRequest) {
    return lastValueFrom(
      this.callClient
        .send<{ count: number }>('call.get_missed_count', {
          userId: request.user!.id,
        })
        .pipe(timeout(5000)),
    );
  }

  @Post('history/seen')
  @ApiOperation({ summary: 'Mark all my missed calls as seen' })
  async markMissedSeen(@Req() request: AuthenticatedRequest) {
    return lastValueFrom(
      this.callClient
        .send<{ updated: number }>('call.mark_missed_seen', {
          userId: request.user!.id,
        })
        .pipe(timeout(5000)),
    );
  }

  /** Names and avatars are best effort: history still loads without them. */
  private async loadPeerProfiles(
    items: CallHistoryItem[],
  ): Promise<Map<string, PublicUserProfile>> {
    const userIds = [...new Set(items.flatMap((item) => item.peerUserIds))];
    if (userIds.length === 0) return new Map();

    const profiles = await lastValueFrom(
      this.userClient
        .send<PublicUserProfile[]>('user.find_public_by_ids', userIds)
        .pipe(
          timeout(5000),
          catchError(() => of([] as PublicUserProfile[])),
        ),
    );
    return new Map(profiles.map((profile) => [profile.id, profile]));
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
