import { SUBTITLE_TARGET_LANGUAGES } from '@common/ai/interfaces/subtitle-translation.interface';
import { ReelSubtitleTranslator } from '@content/application/services/reel-subtitle-translator.service';
import type { IContentRepository } from '@content/domain/interfaces/content.repository.interface';
import { Inject, Injectable, Logger } from '@nestjs/common';

/**
 * Translates a reel's subtitles into every offered language it is not already spoken in, so the first viewer does not
 * wait for the model. Reels that finish processing in a burst are translated one after another so they cannot flood
 * the AI service.
 */
@Injectable()
export class PreTranslateReelSubtitlesUseCase {
  private readonly logger = new Logger(PreTranslateReelSubtitlesUseCase.name);
  private queue: Promise<void> = Promise.resolve();

  constructor(
    @Inject('IContentRepository')
    private readonly repository: IContentRepository,
    private readonly translator: ReelSubtitleTranslator,
  ) {}

  /**
   * Resolves when the reel has been handled and never rejects: a language that fails here is translated on demand when
   * a viewer asks for it, so a failure must not disturb the processing step that triggered this.
   */
  execute(reelId: string): Promise<void> {
    const run = this.queue.then(() => this.translateAll(reelId));
    this.queue = run;
    return run;
  }

  private async translateAll(reelId: string): Promise<void> {
    try {
      const reel = await this.repository.findById(reelId);
      const source = reel ? this.translator.sourceOf(reel) : null;
      if (!reel || !source) return;

      for (const language of SUBTITLE_TARGET_LANGUAGES) {
        if (language === source.language) continue;
        try {
          await this.translator.track(reel, source, language);
        } catch (error: unknown) {
          this.logger.warn(
            `Could not pre-translate ${language} subtitles for reel ${reelId}: ${this.describe(error)}`,
          );
        }
      }
    } catch (error: unknown) {
      this.logger.warn(
        `Could not pre-translate subtitles for reel ${reelId}: ${this.describe(error)}`,
      );
    }
  }

  private describe(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
  }
}
