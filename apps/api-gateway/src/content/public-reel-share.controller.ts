import { isRpcError } from '@common/constants/rpc-error.types';
import type {
  ContentResolvedReelShareLinkResponse,
  PublicResolvedReelShareLinkResponse,
} from '@common/content/interfaces/reel-share-link.interface';
import {
  Controller,
  Get,
  HttpException,
  HttpStatus,
  Inject,
  Logger,
  Param,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ClientProxy } from '@nestjs/microservices';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { catchError, lastValueFrom } from 'rxjs';

@ApiTags('Public Reel Share')
@Controller('r')
export class PublicReelShareController {
  private readonly logger = new Logger(PublicReelShareController.name);
  private readonly cdnDomain: string;
  private readonly externalShareBaseUrl: string;
  private readonly appDeepLinkBaseUrl: string;

  constructor(
    @Inject('CONTENT_SERVICE')
    private readonly contentClient: ClientProxy,
    private readonly configService: ConfigService,
  ) {
    this.cdnDomain = this.configService
      .getOrThrow<string>('R2_PUBLIC_DOMAIN')
      .replace(/\/$/, '');

    this.externalShareBaseUrl = (
      this.configService.get<string>('EXTERNAL_SHARE_BASE_URL') ||
      this.configService.get<string>('FRONTEND_URL') ||
      'http://localhost:3000'
    ).replace(/\/$/, '');

    this.appDeepLinkBaseUrl = (
      this.configService.get<string>('APP_DEEP_LINK_BASE_URL') || 'velora://r'
    ).replace(/\/$/, '');
  }

  @Get(':token')
  @ApiOperation({ summary: 'Resolve a public reel share link' })
  async resolveShareLink(
    @Param('token') token: string,
  ): Promise<PublicResolvedReelShareLinkResponse> {
    if (typeof token !== 'string' || token.trim().length === 0) {
      throw new HttpException('Invalid share token', HttpStatus.BAD_REQUEST);
    }

    const result = await lastValueFrom(
      this.contentClient
        .send<ContentResolvedReelShareLinkResponse>(
          'content.resolve_reel_share_link',
          {
            token: token.trim(),
          },
        )
        .pipe(catchError((error) => this.handleMicroserviceError(error))),
    );

    return {
      token: result.link.token,
      publicUrl: this.buildExternalShareUrl(result.link.token),
      appDeepLink: this.buildAppDeepLink(result.link.token),
      reel: {
        title: result.reel.title,
        description: result.reel.description,
        tags: result.reel.tags,
        thumbnailUrl: result.reel.thumbnailKey
          ? result.reel.thumbnailKey.startsWith('http://') ||
            result.reel.thumbnailKey.startsWith('https://')
            ? result.reel.thumbnailKey
            : `${this.cdnDomain}/${result.reel.thumbnailKey}`
          : undefined,
        streamUrl: this.buildStreamUrl(
          result.reel.hlsMasterKey ?? result.reel.mediaKey,
        ),
        createdAt: result.reel.createdAt,
      },
    };
  }

  private buildExternalShareUrl(token: string): string {
    return `${this.externalShareBaseUrl}/r/${token}`;
  }

  private buildAppDeepLink(token: string): string {
    return `${this.appDeepLinkBaseUrl}/${token}`;
  }

  private buildStreamUrl(mediaKey: string): string {
    if (mediaKey.startsWith('http://') || mediaKey.startsWith('https://')) {
      return mediaKey;
    }

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
    this.logger.error(`Public reel share request failed: ${message}`);

    throw new HttpException(
      'Internal Server Error',
      HttpStatus.INTERNAL_SERVER_ERROR,
    );
  }
}
