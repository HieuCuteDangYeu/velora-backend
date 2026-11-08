import type { IVisionService } from '@ai/domain/interfaces/vision.service.interface';
import type { VisualFrameAnalysis } from '@common/ai/interfaces/visual-analysis.interface';
import { Injectable, Logger, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { CloudflareVisionAdapter } from './cloudflare-vision.adapter';
import { GroqVisionAdapter } from './groq-vision.adapter';

const QUOTA_ERROR =
  /\b429\b|daily free allocation|rate[- ]?limit|quota|too many requests/i;
const DAILY_ALLOCATION = /daily free allocation/i;

/**
 * Frame analysis on Cloudflare Workers AI with Groq as overflow. When
 * Cloudflare reports its daily free allocation is spent, it is skipped until
 * the next UTC midnight so each remaining frame goes straight to Groq.
 */
@Injectable()
export class FallbackVisionAdapter implements IVisionService {
  private readonly logger = new Logger(FallbackVisionAdapter.name);
  private primaryBlockedUntil = 0;

  // The trailing parameters exist so tests can inject fakes; @Optional keeps Nest from trying to resolve them.
  constructor(
    config: ConfigService,
    @Optional()
    private readonly primary: IVisionService = new CloudflareVisionAdapter(
      config,
    ),
    @Optional()
    private readonly secondary: IVisionService = new GroqVisionAdapter(config),
    @Optional() private readonly now: () => number = Date.now,
  ) {}

  async analyzeImage(input: {
    image: Uint8Array;
    mimeType: 'image/jpeg' | 'image/png' | 'image/webp';
  }): Promise<VisualFrameAnalysis> {
    if (this.now() >= this.primaryBlockedUntil) {
      try {
        return await this.primary.analyzeImage(input);
      } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error);
        if (!QUOTA_ERROR.test(message)) throw error;
        if (DAILY_ALLOCATION.test(message)) {
          this.primaryBlockedUntil = this.nextUtcMidnight();
          this.logger.warn(
            `Cloudflare vision daily allocation spent; using Groq until ${new Date(this.primaryBlockedUntil).toISOString()}`,
          );
        } else {
          this.logger.warn('Cloudflare vision rate limited; using Groq');
        }
      }
    }
    return this.secondary.analyzeImage(input);
  }

  private nextUtcMidnight(): number {
    const date = new Date(this.now());
    return Date.UTC(
      date.getUTCFullYear(),
      date.getUTCMonth(),
      date.getUTCDate() + 1,
    );
  }
}
