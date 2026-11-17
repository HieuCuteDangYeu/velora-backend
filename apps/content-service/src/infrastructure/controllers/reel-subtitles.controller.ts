import {
  GetReelSubtitlesUseCase,
  InvalidSubtitleLanguageError,
  SubtitlesUnavailableError,
  parseSubtitleLanguage,
} from '@content/application/use-cases/get-reel-subtitles.use-case';
import { PreTranslateReelSubtitlesUseCase } from '@content/application/use-cases/pre-translate-reel-subtitles.use-case';
import { Controller } from '@nestjs/common';
import { MessagePattern, Payload, RpcException } from '@nestjs/microservices';
import { z } from 'zod';

const request = z.object({
  reelId: z.string().trim().min(1).max(256),
  viewerId: z.string().trim().min(1).max(256),
  isAdmin: z.boolean().optional(),
  language: z.unknown().optional(),
});

@Controller()
export class ReelSubtitlesController {
  constructor(
    private readonly getReelSubtitles: GetReelSubtitlesUseCase,
    private readonly preTranslateReelSubtitles: PreTranslateReelSubtitlesUseCase,
  ) {}

  /**
   * Operator backfill for reels that were processed before subtitles were translated on completion. Internal RMQ only,
   * no gateway route. Answers once the reel has been handled, so the caller controls how fast the AI service is used.
   */
  @MessagePattern('content.pre_translate_reel_subtitles')
  async preTranslate(@Payload() data: unknown) {
    const parsed = z
      .object({ reelId: z.string().trim().min(1).max(256) })
      .strict()
      .safeParse(data);
    if (!parsed.success) {
      throw new RpcException({
        statusCode: 400,
        message: 'Invalid pre-translation request',
      });
    }
    return this.preTranslateReelSubtitles.execute(parsed.data.reelId);
  }

  @MessagePattern('content.get_reel_subtitles')
  async getSubtitles(@Payload() data: unknown) {
    const parsed = request.safeParse(data);
    if (!parsed.success) {
      throw new RpcException({
        statusCode: 400,
        message: 'Invalid subtitles request',
      });
    }
    try {
      const subtitles = await this.getReelSubtitles.execute({
        reelId: parsed.data.reelId,
        viewerId: parsed.data.viewerId,
        isAdmin: parsed.data.isAdmin,
        language: parseSubtitleLanguage(parsed.data.language),
      });
      if (!subtitles) {
        throw new RpcException({ statusCode: 404, message: 'Reel not found' });
      }
      return subtitles;
    } catch (error: unknown) {
      if (error instanceof RpcException) throw error;
      if (error instanceof InvalidSubtitleLanguageError) {
        throw new RpcException({ statusCode: 400, message: error.message });
      }
      if (error instanceof SubtitlesUnavailableError) {
        throw new RpcException({ statusCode: 404, message: error.message });
      }
      const message = error instanceof Error ? error.message : String(error);
      throw new RpcException({
        statusCode: 502,
        message: `Subtitles could not be prepared: ${message}`,
      });
    }
  }
}
