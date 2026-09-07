import { isRpcError } from '@common/constants/rpc-error.types';
import { resolveReelPlaybackPresentation } from '@common/content/playback-presentation';
import { ReelFeedListItem } from '@common/content/interfaces/reel-response.interface';
import { GlobalSearchQueryDto } from '@common/search/dtos/global-search-query.dto';
import { SearchSuggestionsQueryDto } from '@common/search/dtos/search-suggestions-query.dto';
import { GlobalSearchResponse } from '@common/search/interfaces/global-search-response.interface';
import { SearchSuggestionsResponse } from '@common/search/interfaces/search-suggestions-response.interface';
import { PublicUserProfile } from '@common/user/interfaces/public-user-profile.types';
import { Reel } from '@content/domain/entities/reel.entity';
import {
  JwtAuthGuard,
  type AuthenticatedRequest,
} from '@gateway/auth/guards/jwt-auth.guard';
import { ReelAuthorService } from '@gateway/content/reel-author.service';
import {
  Controller,
  Get,
  HttpException,
  HttpStatus,
  Inject,
  Logger,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ClientProxy } from '@nestjs/microservices';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { catchError, lastValueFrom } from 'rxjs';

type SearchableReel = Reel & {
  searchScore?: number;
};

@ApiTags('Search')
@Controller('search')
@UseGuards(JwtAuthGuard)
@ApiBearerAuth()
export class SearchController {
  private readonly logger = new Logger(SearchController.name);
  private readonly cdnDomain: string;

  constructor(
    @Inject('USER_SERVICE') private readonly userClient: ClientProxy,
    @Inject('CONTENT_SERVICE') private readonly contentClient: ClientProxy,
    private readonly configService: ConfigService,
    private readonly reelAuthorService: ReelAuthorService,
  ) {
    this.cdnDomain = this.configService
      .getOrThrow<string>('R2_PUBLIC_DOMAIN')
      .replace(/\/$/, '');
  }

  @Get()
  @ApiOperation({ summary: 'Global search across users and reels' })
  async search(
    @Req() request: AuthenticatedRequest,
    @Query() query: GlobalSearchQueryDto,
  ): Promise<GlobalSearchResponse> {
    const searchText = query.q.trim();
    const limit = Math.min(Math.max(query.limit ?? 12, 1), 30);
    const type = query.type ?? 'all';

    const shouldSearchUsers = type === 'all' || type === 'users';
    const shouldSearchReels = type === 'all' || type === 'reels';

    const [users, reels] = await Promise.all([
      shouldSearchUsers
        ? this.searchUsers({
            query: searchText,
            limit,
            excludeUserId: request.user!.id,
          })
        : Promise.resolve([]),
      shouldSearchReels
        ? this.searchReels({
            query: searchText,
            limit,
            viewerId: request.user!.id,
          })
        : Promise.resolve([]),
    ]);

    const enrichedReels = await this.enrichFeedItems(reels);

    return {
      query: searchText,
      type,
      users,
      reels: enrichedReels,
      counts: {
        users: users.length,
        reels: enrichedReels.length,
      },
    };
  }

  @Get('suggestions')
  @ApiOperation({ summary: 'Get dynamic search suggestion chips' })
  async suggestions(
    @Req() request: AuthenticatedRequest,
    @Query() query: SearchSuggestionsQueryDto,
  ): Promise<SearchSuggestionsResponse> {
    return await lastValueFrom(
      this.contentClient
        .send<SearchSuggestionsResponse>('content.get_search_suggestions', {
          viewerId: request.user!.id,
          type: query.type ?? 'all',
          limit: query.limit ?? 8,
        })
        .pipe(catchError((error) => this.handleMicroserviceError(error))),
    );
  }

  private async searchUsers(input: {
    query: string;
    limit: number;
    excludeUserId: string;
  }): Promise<PublicUserProfile[]> {
    return await lastValueFrom(
      this.userClient
        .send<PublicUserProfile[]>('user.search_public', {
          query: input.query,
          limit: input.limit,
          excludeUserId: input.excludeUserId,
        })
        .pipe(catchError((error) => this.handleMicroserviceError(error))),
    );
  }

  private async searchReels(input: {
    query: string;
    limit: number;
    viewerId: string;
  }): Promise<SearchableReel[]> {
    return await lastValueFrom(
      this.contentClient
        .send<SearchableReel[]>('content.search_reels', {
          query: input.query,
          limit: input.limit,
          viewerId: input.viewerId,
        })
        .pipe(catchError((error) => this.handleMicroserviceError(error))),
    );
  }

  private async enrichFeedItems(
    reels: SearchableReel[],
  ): Promise<ReelFeedListItem[]> {
    const authorsById = await this.reelAuthorService.loadAuthorMap(
      reels.map((reel) => reel.userId),
    );

    return reels.map((reel) => ({
      ...this.enrichReel(reel),
      author: this.reelAuthorService.resolveAuthor(authorsById, reel.userId),
    }));
  }

  private enrichReel(reel: SearchableReel): Omit<ReelFeedListItem, 'author'> {
    const streamUrl = this.buildStreamUrl(reel.hlsMasterKey ?? reel.mediaKey);
    const thumbnailUrl = reel.thumbnailKey
      ? `${this.cdnDomain}/${reel.thumbnailKey}`
      : undefined;

    const createdAt =
      reel.createdAt instanceof Date
        ? reel.createdAt.toISOString()
        : new Date(reel.createdAt).toISOString();

    return {
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
    };
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

  private handleMicroserviceError(error: unknown): never {
    if (isRpcError(error)) {
      throw new HttpException(error.message, error.statusCode);
    }

    const message = error instanceof Error ? error.message : String(error);
    this.logger.error(`Search microservice request failed: ${message}`);

    throw new HttpException(
      'Internal Server Error',
      HttpStatus.INTERNAL_SERVER_ERROR,
    );
  }
}
