import {
  Inject,
  Injectable,
  Logger,
  OnApplicationBootstrap,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Cron, CronExpression } from '@nestjs/schedule';
import type { ITikTokCdnService } from '../../domain/interfaces/tiktok-cdn.service.interface';

@Injectable()
export class TikTokCdnKeepaliveJob implements OnApplicationBootstrap {
  private readonly logger = new Logger(TikTokCdnKeepaliveJob.name);
  private readonly isEnabled: boolean;

  constructor(
    @Inject('ITikTokCdnService')
    private readonly tiktokCdnService: ITikTokCdnService,
    private readonly configService: ConfigService,
  ) {
    this.isEnabled =
      this.configService.get<string>('TIKTOK_CDN_ENABLED')?.toLowerCase() ===
      'true';
  }

  // Pings on service startup to verify session health.
  async onApplicationBootstrap(): Promise<void> {
    if (!this.isEnabled) {
      return;
    }
    await this.handleKeepalive();
  }

  // Periodic keep-alive ping to extend TikTok sliding session TTL.
  @Cron(CronExpression.EVERY_6_HOURS)
  async handleKeepalive(): Promise<void> {
    if (!this.isEnabled) {
      return;
    }

    if (!this.tiktokCdnService.validateConfig()) {
      this.logger.warn(
        'TikTok CDN is enabled but credentials are not configured.',
      );
      return;
    }

    try {
      const result = await this.tiktokCdnService.pingSession();
      if (result.isAlive) {
        this.logger.log(`TikTok CDN session keep-alive OK: ${result.message}`);
      } else {
        this.logger.warn(
          `TikTok CDN session keep-alive failed: ${result.message} (status: ${result.statusCode ?? 'unknown'})`,
        );
      }
    } catch (err) {
      this.logger.error(`TikTok CDN session keep-alive error: ${String(err)}`);
    }
  }
}
