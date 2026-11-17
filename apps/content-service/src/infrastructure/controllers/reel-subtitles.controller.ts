import {
  GetReelSubtitlesUseCase,
  InvalidSubtitleLanguageError,
  SubtitlesUnavailableError,
  parseSubtitleLanguage,
} from '@content/application/use-cases/get-reel-subtitles.use-case';
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
  constructor(private readonly getReelSubtitles: GetReelSubtitlesUseCase) {}

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
