import {
  IContentService,
  PublicReelSearchInput,
  RecommendedReelsInput,
} from '@ai/domain/interfaces/content-service.interface';
import type { AiRecommendedReel } from '@common/ai/dtos/ask-question-response.dto';
import {
  ReelContextAccessRequest,
  ReelContextAccessResult,
} from '@common/content/interfaces/reel-context-search-request.interface';
import { Inject, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ClientProxy } from '@nestjs/microservices';
import { firstValueFrom } from 'rxjs';

interface RawReelAuthor {
  id: string;
  username?: string | null;
  displayName?: string | null;
  avatarUrl?: string | null;
  isVerified?: boolean | null;
}

interface RawContentReel {
  id: string;
  userId: string;
  mediaKey: string;
  title?: string;
  description?: string;
  tags?: string[];
  status: 'PENDING' | 'PROCESSING' | 'COMPLETED' | 'FAILED';
  visibility: 'public' | 'private';
  viewCount?: number | bigint;
  thumbnailKey?: string;
  thumbnailUrl?: string;
  streamUrl?: string;
  durationMs?: number;
  sourceDurationMs?: number;
  outputDurationMs?: number;
  sourceOrientation?: 'PORTRAIT' | 'LANDSCAPE' | 'SQUARE';
  sourceLengthClass?: 'SHORT' | 'LONG';
  playbackPresentation?: 'PORTRAIT_COVER' | 'FIT_WITH_LETTERBOX';
  createdAt: string | Date;
  author?: RawReelAuthor;
}

interface RecommendedReelsRpcResponse {
  items?: RawContentReel[];
  nextCursor?: string | null;
}

@Injectable()
export class ContentServiceAdapter implements IContentService {
  private readonly logger = new Logger(ContentServiceAdapter.name);
  private readonly cdnDomain: string;

  constructor(
    @Inject('CONTENT_RMQ')
    private readonly contentClient: ClientProxy,
    private readonly configService: ConfigService,
  ) {
    this.cdnDomain = (
      this.configService.get<string>('R2_PUBLIC_DOMAIN') ?? ''
    ).replace(/\/$/, '');
  }

  async resolveReelContextAccess(
    input: ReelContextAccessRequest,
  ): Promise<string[]> {
    try {
      const result = await firstValueFrom(
        this.contentClient.send<ReelContextAccessResult>(
          'content.resolve_reel_context_access',
          input,
        ),
      );

      return Array.isArray(result?.reelIds) ? result.reelIds : [];
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.error(
        `ContentServiceAdapter.resolveReelContextAccess failed: ${message}. Returning no accessible reels.`,
      );
      return [];
    }
  }

  async searchPublicReels(
    input: PublicReelSearchInput,
  ): Promise<AiRecommendedReel[]> {
    const query = input.query.trim();

    if (!query) {
      return [];
    }

    try {
      const results = await firstValueFrom(
        this.contentClient.send<RawContentReel[]>('content.search_reels', {
          query,
          viewerId: input.viewerId,
          limit: input.limit,
        }),
      );

      return this.normalizeReels(results);
    } catch (error: unknown) {
      const msg = error instanceof Error ? error.message : String(error);

      this.logger.error(
        `ContentServiceAdapter.searchPublicReels failed: ${msg}. Returning empty reels.`,
      );

      return [];
    }
  }

  async getRecommendedReels(
    input: RecommendedReelsInput,
  ): Promise<AiRecommendedReel[]> {
    try {
      const result = await firstValueFrom(
        this.contentClient.send<RecommendedReelsRpcResponse>(
          'content.get_recommended_reels',
          {
            viewerId: input.viewerId,
            limit: input.limit,
            excludeRecentlySeen: true,
          },
        ),
      );

      return this.normalizeReels(result.items ?? []);
    } catch (error: unknown) {
      const msg = error instanceof Error ? error.message : String(error);

      this.logger.error(
        `ContentServiceAdapter.getRecommendedReels failed: ${msg}. Returning empty reels.`,
      );

      return [];
    }
  }

  private normalizeReels(reels: RawContentReel[]): AiRecommendedReel[] {
    return reels
      .filter((reel) => reel.id.length > 0)
      .map((reel) => this.normalizeReel(reel));
  }

  private normalizeReel(reel: RawContentReel): AiRecommendedReel {
    const streamUrl =
      reel.streamUrl ??
      (this.cdnDomain && reel.mediaKey
        ? this.buildStreamUrl(reel.mediaKey)
        : undefined);

    const thumbnailUrl =
      reel.thumbnailUrl ??
      (this.cdnDomain && reel.thumbnailKey
        ? `${this.cdnDomain}/${reel.thumbnailKey}`
        : undefined);

    return {
      id: reel.id,
      userId: reel.userId,
      mediaKey: reel.mediaKey,
      title: reel.title,
      description: reel.description,
      tags: reel.tags ?? [],
      status: reel.status,
      visibility: reel.visibility,
      viewCount:
        typeof reel.viewCount === 'bigint'
          ? Number(reel.viewCount)
          : (reel.viewCount ?? 0),
      thumbnailKey: reel.thumbnailKey,
      thumbnailUrl,
      streamUrl,
      durationMs:
        reel.durationMs ?? reel.outputDurationMs ?? reel.sourceDurationMs,
      sourceOrientation: reel.sourceOrientation,
      sourceLengthClass: reel.sourceLengthClass,
      playbackPresentation:
        reel.playbackPresentation ??
        (reel.sourceOrientation === 'LANDSCAPE' &&
        reel.sourceLengthClass === 'LONG'
          ? 'FIT_WITH_LETTERBOX'
          : 'PORTRAIT_COVER'),
      createdAt: this.toIsoDate(reel.createdAt),
      author: reel.author,
    };
  }

  private toIsoDate(value: string | Date): string {
    if (value instanceof Date) {
      return value.toISOString();
    }

    const parsed = new Date(value);

    if (Number.isNaN(parsed.getTime())) {
      return new Date().toISOString();
    }

    return parsed.toISOString();
  }

  private buildStreamUrl(mediaKey: string): string {
    const extIndex = mediaKey.lastIndexOf('.');
    const folderPath =
      extIndex !== -1 ? mediaKey.substring(0, extIndex) : mediaKey;

    return `${this.cdnDomain}/${folderPath}/master.m3u8`;
  }
}
