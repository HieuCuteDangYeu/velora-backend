import {
  SUBTITLE_TARGET_LANGUAGES,
  type SubtitleTargetLanguage,
} from '@common/ai/interfaces/subtitle-translation.interface';
import { ReelSubtitleTranslator } from '@content/application/services/reel-subtitle-translator.service';
import type { IContentRepository } from '@content/domain/interfaces/content.repository.interface';
import { Inject, Injectable, Logger } from '@nestjs/common';

export interface PreTranslateResult {
  /** Languages translated and stored by this call. */
  translated: SubtitleTargetLanguage[];
  /** Languages that already had an up-to-date stored translation. */
  alreadyStored: SubtitleTargetLanguage[];
  /** Languages that could not be translated this time; a viewer's request translates them later. */
  failed: SubtitleTargetLanguage[];
  /** Set when nothing could be done for the reel at all. */
  skipped?: 'reel_not_found' | 'no_transcript' | 'error';
}

/**
 * Translates a reel's subtitles into every offered language it is not already spoken in, so the first viewer does not
 * wait for the model. Reels that finish processing in a burst are translated one after another so they cannot flood
 * the AI service.
 */
@Injectable()
export class PreTranslateReelSubtitlesUseCase {
  private readonly logger = new Logger(PreTranslateReelSubtitlesUseCase.name);
  private queue: Promise<unknown> = Promise.resolve();

  constructor(
    @Inject('IContentRepository')
    private readonly repository: IContentRepository,
    private readonly translator: ReelSubtitleTranslator,
  ) {}

  /**
   * Resolves when the reel has been handled and never rejects: a language that fails here is translated on demand when
   * a viewer asks for it, so a failure must not disturb the processing step that triggered this.
   */
  execute(reelId: string): Promise<PreTranslateResult> {
    const run = this.queue.then(() => this.translateAll(reelId));
    this.queue = run;
    return run;
  }

  private async translateAll(reelId: string): Promise<PreTranslateResult> {
    const result: PreTranslateResult = {
      translated: [],
      alreadyStored: [],
      failed: [],
    };
    try {
      const reel = await this.repository.findById(reelId);
      if (!reel) return { ...result, skipped: 'reel_not_found' };
      const source = this.translator.sourceOf(reel);
      if (!source) return { ...result, skipped: 'no_transcript' };

      for (const language of SUBTITLE_TARGET_LANGUAGES) {
        if (language === source.language) continue;
        try {
          if (await this.translator.hasCurrent(reel, source, language)) {
            result.alreadyStored.push(language);
            continue;
          }
          await this.translator.track(reel, source, language);
          result.translated.push(language);
        } catch (error: unknown) {
          result.failed.push(language);
          this.logger.warn(
            `Could not pre-translate ${language} subtitles for reel ${reelId}: ${this.describe(error)}`,
          );
        }
      }
      return result;
    } catch (error: unknown) {
      this.logger.warn(
        `Could not pre-translate subtitles for reel ${reelId}: ${this.describe(error)}`,
      );
      return { ...result, skipped: 'error' };
    }
  }

  private describe(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
  }
}
