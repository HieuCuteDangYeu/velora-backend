import { isRpcError } from '@common/constants/rpc-error.types';
import { resolveReelPlaybackPresentation } from '@common/content/playback-presentation';
import { CreateReelShareLinkDto } from '@common/content/dtos/create-reel-share-link.dto';
import { CreateReelDto } from '@common/content/dtos/create-reel.dto';
import { FriendsReelsQueryDto } from '@common/content/dtos/friends-reels-query.dto';
import { GetReelContextQueryDto } from '@common/content/dtos/get-reel-context.dto';
import { ListReelsQueryDto } from '@common/content/dtos/list-reels.dto';
import { RecommendedReelsQueryDto } from '@common/content/dtos/recommended-reels-query.dto';
import { ShareReelDto } from '@common/content/dtos/share-reel.dto';
import { TrackReelEventsDto } from '@common/content/dtos/track-reel-events.dto';
import { UpdateReelDto } from '@common/content/dtos/update-reel.dto';
import { ReelProfileContextResponse } from '@common/content/interfaces/reel-context-response.interface';
import { ReelProcessingStatus } from '@common/content/interfaces/reel-processing-status.interface';
import {
  PaginatedReels,
  ReelDetail,
  ReelFeedListItem,
  ReelListItem,
} from '@common/content/interfaces/reel-response.interface';
import { ReelShareLinkResponse } from '@common/content/interfaces/reel-share-link.interface';
import { ReelShareResponse } from '@common/content/interfaces/reel-share.interface';
import { TrackReelEventsResponse } from '@common/content/interfaces/track-reel-events-response.interface';
import { Reel } from '@content/domain/entities/reel.entity';
import {
  JwtAuthGuard,
  type AuthenticatedRequest,
} from '@gateway/auth/guards/jwt-auth.guard';
import {
  Body,
  Controller,
  Delete,
  Get,
  HttpException,
  HttpStatus,
  Inject,
  Logger,
  Param,
  Patch,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ClientProxy } from '@nestjs/microservices';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { catchError, lastValueFrom } from 'rxjs';
import { ReelAuthorService } from './reel-author.service';

@ApiTags('Content')
@Controller('content')
@UseGuards(JwtAuthGuard)
@ApiBearerAuth()
export class ContentController {
  private readonly logger = new Logger(ContentController.name);
  private readonly cdnDomain: string;
  private readonly externalShareBaseUrl: string;

  constructor(
    @Inject('CONTENT_SERVICE') private readonly contentClient: ClientProxy,
    private readonly configService: ConfigService,
    private readonly reelAuthorService: ReelAuthorService,
  ) {
    this.cdnDomain = this.configService
      .getOrThrow<string>('R2_PUBLIC_DOMAIN')
      .replace(/\/$/, '');

    this.externalShareBaseUrl = (
      this.configService.get<string>('EXTERNAL_SHARE_BASE_URL') ||
      this.configService.get<string>('FRONTEND_URL') ||
      'http://localhost:3000'
    ).replace(/\/$/, '');
  }

  private buildExternalShareUrl(token: string): string {
    return `${this.externalShareBaseUrl}/r/${token}`;
  }

  private async enrichReelShareResponse(
    share: ReelShareResponse,
  ): Promise<ReelShareResponse> {
    if (
      !share.message?.media ||
      typeof share.message.media !== 'object' ||
      Array.isArray(share.message.media)
    ) {
      return share;
    }

    const media = { ...(share.message.media as Record<string, unknown>) };

    const authorsById = await this.reelAuthorService.loadAuthorMap([
      share.ownerId,
    ]);
    const author = this.reelAuthorService.resolveAuthor(
      authorsById,
      share.ownerId,
    );

    return {
      ...share,
      message: {
        ...share.message,
        media: {
          ...media,
          reelOwnerId:
            typeof media.reelOwnerId === 'string' && media.reelOwnerId.trim()
              ? media.reelOwnerId
              : share.ownerId,
          ...(author.username ? { reelOwnerUsername: author.username } : {}),
          ...(author.avatarUrl ? { reelOwnerAvatarUrl: author.avatarUrl } : {}),
        },
      },
    };
  }

  @Post('reels')
  @ApiOperation({ summary: 'Create a new reel from an uploaded S3 key' })
  async createReel(
    @Req() request: AuthenticatedRequest,
    @Body() body: CreateReelDto,
  ) {
    const reel = await lastValueFrom(
      this.contentClient
        .send<Reel>('content.create_reel', {
          userId: request.user!.id,
          payload: body,
        })
        .pipe(catchError((error) => this.handleMicroserviceError(error))),
    );

    return this._enrichReel(reel);
  }

  @Get('reels')
  @ApiOperation({ summary: 'List reels (public feed or user-specific)' })
  async listReels(
    @Req() request: AuthenticatedRequest,
    @Query() query: ListReelsQueryDto,
  ): Promise<PaginatedReels<ReelFeedListItem>> {
    if (
      query.visibility === 'private' &&
      query.userId !== request.user!.id &&
      !request.user!.roles?.includes('ADMIN')
    ) {
      throw new HttpException('Forbidden', HttpStatus.FORBIDDEN);
    }

    const isPublicFeed = !query.userId || query.visibility !== 'private';
    const effectiveVisibility = query.visibility ?? 'public';

    const result = await lastValueFrom(
      this.contentClient
        .send<{
          items: Reel[];
          nextCursor: string | null;
        }>('content.list_reels', {
          userId: query.userId,
          viewerId: request.user!.id,
          visibility: effectiveVisibility,
          limit: query.limit,
          cursor: query.cursor,
          onlyPublished: isPublicFeed,
          ranked: query.ranked ?? isPublicFeed,
        })
        .pipe(catchError((error) => this.handleMicroserviceError(error))),
    );

    return {
      items: await this.enrichFeedItems(result.items),
      nextCursor: result.nextCursor,
    };
  }

  @Post('reels/events')
  @ApiOperation({
    summary: 'Persist retry-safe reel interaction events',
  })
  async trackReelEvents(
    @Req()
    request: AuthenticatedRequest,
    @Body()
    body: TrackReelEventsDto,
  ): Promise<TrackReelEventsResponse> {
    const result = await lastValueFrom(
      this.contentClient
        .send<Omit<TrackReelEventsResponse, 'success'>>(
          'content.track_reel_events',
          {
            userId: request.user!.id,
            events: body.events,
          },
        )
        .pipe(catchError((error) => this.handleMicroserviceError(error))),
    );

    return {
      success: true,
      ...result,
    };
  }

  @Get('reels/recommended')
  @ApiOperation({
    summary: 'Get personalized recommended reels',
  })
  async getRecommendedReels(
    @Req() request: AuthenticatedRequest,
    @Query()
    query: RecommendedReelsQueryDto,
  ): Promise<PaginatedReels<ReelFeedListItem>> {
    const result = await lastValueFrom(
      this.contentClient
        .send<{
          items: Reel[];
          nextCursor: string | null;
          feedSessionId: string;
          algorithmVersion: string;
          generatedAt: string;
        }>('content.get_recommended_reels', {
          viewerId: request.user!.id,
          limit: query.limit,
          cursor: query.cursor,
          excludeRecentlySeen: query.excludeRecentlySeen,
          feedSessionId: query.feedSessionId,
        })
        .pipe(catchError((error) => this.handleMicroserviceError(error))),
    );

    return {
      items: await this.enrichFeedItems(result.items),
      nextCursor: result.nextCursor,
      feedSessionId: result.feedSessionId,
      algorithmVersion: result.algorithmVersion,
      generatedAt: result.generatedAt,
    };
  }

  @Get('reels/friends')
  @ApiOperation({
    summary: 'Get chronological reels from accepted friends',
  })
  async getFriendsReels(
    @Req()
    request: AuthenticatedRequest,
    @Query()
    query: FriendsReelsQueryDto,
  ): Promise<PaginatedReels<ReelFeedListItem>> {
    const result = await lastValueFrom(
      this.contentClient
        .send<{
          items: Reel[];
          nextCursor: string | null;
        }>('content.get_friends_reels', {
          viewerId: request.user!.id,
          limit: query.limit,
          cursor: query.cursor,
        })
        .pipe(catchError((error) => this.handleMicroserviceError(error))),
    );

    return {
      items: await this.enrichFeedItems(result.items),
      nextCursor: result.nextCursor,
    };
  }

  @Get('reels/:id')
  @ApiOperation({ summary: 'Get a single reel by ID' })
  async getReel(
    @Req() request: AuthenticatedRequest,
    @Param('id') reelId: string,
  ) {
    const reel = await lastValueFrom(
      this.contentClient
        .send<Reel | null>('content.get_reel', {
          reelId,
          viewerId: request.user!.id,
          isAdmin: request.user!.roles?.includes('ADMIN') === true,
        })
        .pipe(catchError((error) => this.handleMicroserviceError(error))),
    );

    if (!reel) {
      throw new HttpException('Reel not found', HttpStatus.NOT_FOUND);
    }

    // Only owner can view private reels
    if (
      reel.visibility === 'private' &&
      reel.userId !== request.user!.id &&
      !request.user!.roles?.includes('ADMIN')
    ) {
      throw new HttpException('Reel not found', HttpStatus.NOT_FOUND);
    }

    return this._enrichReel(reel, { includeTranscript: true });
  }

  @Get('reels/:id/context')
  @ApiOperation({ summary: 'Get contextual profile reel feed around a reel' })
  async getReelContext(
    @Req() request: AuthenticatedRequest,
    @Param('id') reelId: string,
    @Query() query: GetReelContextQueryDto,
  ): Promise<ReelProfileContextResponse> {
    const context = await lastValueFrom(
      this.contentClient
        .send<{
          source: 'profile';
          scope: {
            userId: string;
            visibility: 'public' | 'friends' | 'private';
          };
          selectedId: string;
          selectedIndex: number;
          items: Reel[];
          previousCursor: string | null;
          nextCursor: string | null;
        }>('content.get_profile_reel_context', {
          reelId,
          viewerId: request.user!.id,
          before: query.before,
          after: query.after,
        })
        .pipe(catchError((error) => this.handleMicroserviceError(error))),
    );

    if (
      context.scope.visibility === 'private' &&
      context.scope.userId !== request.user!.id &&
      !request.user!.roles?.includes('ADMIN')
    ) {
      throw new HttpException('Reel not found', HttpStatus.NOT_FOUND);
    }

    return {
      source: 'profile',
      scope: context.scope,
      selectedId: context.selectedId,
      selectedIndex: context.selectedIndex,
      items: await this.enrichFeedItems(context.items),
      previousCursor: context.previousCursor,
      nextCursor: context.nextCursor,
    };
  }

  @Post('reels/:id/reprocess')
  @ApiOperation({ summary: 'Retry processing a failed reel' })
  async reprocessReel(
    @Req() request: AuthenticatedRequest,
    @Param('id') reelId: string,
  ) {
    const reel = await lastValueFrom(
      this.contentClient
        .send<Reel>('content.reprocess_reel', {
          reelId,
          userId: request.user!.id,
          isAdmin: request.user!.roles?.includes('ADMIN') === true,
        })
        .pipe(catchError((error) => this.handleMicroserviceError(error))),
    );

    return this._enrichReel(reel);
  }

  @Get('reels/:id/status')
  @ApiOperation({ summary: 'Get reel processing status' })
  async getReelStatus(
    @Req() request: AuthenticatedRequest,
    @Param('id') reelId: string,
  ) {
    const status = await lastValueFrom(
      this.contentClient
        .send<ReelProcessingStatus>('content.get_reel_status', { reelId })
        .pipe(catchError((error) => this.handleMicroserviceError(error))),
    );

    if (status.status === 'NOT_FOUND') {
      throw new HttpException('Reel not found', HttpStatus.NOT_FOUND);
    }

    if (
      status.visibility === 'private' &&
      status.userId !== request.user!.id &&
      !request.user!.roles?.includes('ADMIN')
    ) {
      throw new HttpException('Reel not found', HttpStatus.NOT_FOUND);
    }

    return {
      reelId: status.reelId,
      status: status.status,
      mediaStatus: status.mediaStatus,
      indexStatus: status.indexStatus,
      stage: status.stage,
      message: status.message,
      progress: status.progress,
      mediaKey: status.mediaKey,
      hlsMasterKey: status.hlsMasterKey,
      thumbnailKey: status.thumbnailKey,
      thumbnailUrl: status.thumbnailKey
        ? `${this.cdnDomain}/${status.thumbnailKey}`
        : undefined,
      streamUrl:
        status.hlsMasterKey || status.mediaKey
          ? this.buildStreamUrl(status.hlsMasterKey ?? status.mediaKey!)
          : undefined,
    };
  }

  @Post('reels/:id/share')
  @ApiOperation({ summary: 'Share a reel into a conversation' })
  async shareReel(
    @Req() request: AuthenticatedRequest,
    @Param('id') reelId: string,
    @Body() body: ShareReelDto,
  ): Promise<ReelShareResponse> {
    if (!body?.conversationId || body.conversationId.trim().length === 0) {
      throw new HttpException(
        'conversationId is required',
        HttpStatus.BAD_REQUEST,
      );
    }

    const share = await lastValueFrom(
      this.contentClient
        .send<ReelShareResponse>('content.share_reel', {
          reelId,
          sharedByUserId: request.user!.id,
          conversationId: body.conversationId.trim(),
          sharedWithUserId: body.sharedWithUserId?.trim(),
        })
        .pipe(catchError((error) => this.handleMicroserviceError(error))),
    );

    return await this.enrichReelShareResponse(share);
  }

  @Post('reels/:id/share-link')
  @ApiOperation({ summary: 'Create an external public share link for a reel' })
  async createReelShareLink(
    @Req() request: AuthenticatedRequest,
    @Param('id') reelId: string,
    @Body() body: CreateReelShareLinkDto,
  ): Promise<ReelShareLinkResponse> {
    const link = await lastValueFrom(
      this.contentClient
        .send<ReelShareLinkResponse>('content.create_reel_share_link', {
          reelId,
          createdBy: request.user!.id,
          expiresInDays: body?.expiresInDays,
          reuseExisting: body?.reuseExisting,
        })
        .pipe(catchError((error) => this.handleMicroserviceError(error))),
    );

    return {
      ...link,
      publicUrl: this.buildExternalShareUrl(link.token),
    };
  }

  @Delete('reels/share-links/:token')
  @ApiOperation({ summary: 'Revoke an external reel share link' })
  async revokeReelShareLink(
    @Req() request: AuthenticatedRequest,
    @Param('token') token: string,
  ): Promise<ReelShareLinkResponse> {
    const link = await lastValueFrom(
      this.contentClient
        .send<ReelShareLinkResponse>('content.revoke_reel_share_link', {
          token,
          revokedByUserId: request.user!.id,
        })
        .pipe(catchError((error) => this.handleMicroserviceError(error))),
    );

    return {
      ...link,
      publicUrl: this.buildExternalShareUrl(link.token),
    };
  }

  @Patch('reels/:id')
  @ApiOperation({ summary: 'Update reel metadata (owner only)' })
  async updateReel(
    @Req() request: AuthenticatedRequest,
    @Param('id') reelId: string,
    @Body() body: UpdateReelDto,
  ) {
    const reel = await lastValueFrom(
      this.contentClient
        .send<Reel | null>('content.update_reel', {
          reelId,
          userId: request.user!.id,
          payload: body,
        })
        .pipe(catchError((error) => this.handleMicroserviceError(error))),
    );

    if (!reel) {
      throw new HttpException(
        'Reel not found or not owned by you',
        HttpStatus.NOT_FOUND,
      );
    }

    return this._enrichReel(reel);
  }

  @Delete('reels/:id')
  @ApiOperation({ summary: 'Delete a reel (owner only)' })
  async deleteReel(
    @Req() request: AuthenticatedRequest,
    @Param('id') reelId: string,
  ) {
    await lastValueFrom(
      this.contentClient
        .send<{ success: boolean }>('content.delete_reel', {
          reelId,
          userId: request.user!.id,
        })
        .pipe(catchError((error) => this.handleMicroserviceError(error))),
    );

    return { success: true };
  }

  private _enrichReel(
    reel: Reel,
    opts?: { includeTranscript?: false },
  ): ReelListItem;

  private _enrichReel(
    reel: Reel,
    opts: { includeTranscript: true },
  ): ReelDetail;

  private _enrichReel(
    reel: Reel,
    opts: { includeTranscript?: boolean } = {},
  ): ReelListItem | ReelDetail {
    const streamUrl = this.buildStreamUrl(reel.hlsMasterKey ?? reel.mediaKey);
    const thumbnailUrl = reel.thumbnailKey
      ? `${this.cdnDomain}/${reel.thumbnailKey}`
      : undefined;
    const createdAt =
      reel.createdAt instanceof Date
        ? reel.createdAt.toISOString()
        : new Date(reel.createdAt).toISOString();

    const result: ReelListItem = {
      id: reel.id,
      userId: reel.userId,
      mediaKey: reel.mediaKey,
      hlsMasterKey: reel.hlsMasterKey,
      title: reel.title,
      description: reel.description,
      tags: reel.tags,
      status: reel.status,
      mediaStatus: reel.mediaStatus,
      indexStatus: reel.indexStatus,
      visibility: reel.visibility,
      viewCount:
        typeof reel.viewCount === 'bigint'
          ? Number(reel.viewCount)
          : reel.viewCount,
      thumbnailKey: reel.thumbnailKey,
      thumbnailUrl,
      processingStage: reel.processingStage,
      processingMessage: reel.processingMessage,
      processingProgress: reel.processingProgress,
      durationMs: reel.outputDurationMs ?? reel.sourceDurationMs,
      outputDurationMs: reel.outputDurationMs,
      sourceOrientation: reel.sourceOrientation,
      sourceLengthClass: reel.sourceLengthClass,
      edit: reel.mediaEdit,
      playbackPresentation: resolveReelPlaybackPresentation({
        mediaEdit: reel.mediaEdit,
        sourceOrientation: reel.sourceOrientation,
        sourceLengthClass: reel.sourceLengthClass,
      }),
      sourceAspectRatio: reel.sourceAspectRatio,
      sourceEffectiveWidth: reel.sourceEffectiveWidth,
      sourceEffectiveHeight: reel.sourceEffectiveHeight,
      streamUrl,
      createdAt,
      recommendation: reel.recommendation,
    };

    if (opts.includeTranscript) {
      return {
        ...result,
        transcript: reel.transcript,
        transcriptVtt: reel.transcriptVtt,
        transcriptSegments: reel.transcriptSegments,
      };
    }

    return result;
  }

  private async enrichFeedItems(reels: Reel[]): Promise<ReelFeedListItem[]> {
    const authorsById = await this.reelAuthorService.loadAuthorMap(
      reels.map((reel) => reel.userId),
    );

    return reels.map((reel) => ({
      ...this._enrichReel(reel),
      author: this.reelAuthorService.resolveAuthor(authorsById, reel.userId),
    }));
  }

  private buildStreamUrl(mediaKey: string): string {
    if (mediaKey.endsWith('.m3u8')) {
      return `${this.cdnDomain}/${mediaKey.replace(/^\/+/, '')}`;
    }

    const extIndex = mediaKey.lastIndexOf('.');
    const folderPath =
      extIndex !== -1 ? mediaKey.substring(0, extIndex) : mediaKey;

    return `${this.cdnDomain}/${folderPath}/master.m3u8`;
  }

  private handleMicroserviceError(error: any): never {
    if (isRpcError(error)) {
      throw new HttpException(error.message, error.statusCode);
    }

    const message = error instanceof Error ? error.message : String(error);
    this.logger.error(`Content microservice request failed: ${message}`);
    throw new HttpException(
      'Internal Server Error',
      HttpStatus.INTERNAL_SERVER_ERROR,
    );
  }
}
