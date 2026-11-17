import {
  type SubtitleTargetLanguage,
  isSubtitleTargetLanguage,
} from '@common/ai/interfaces/subtitle-translation.interface';
import type { ReelSubtitlesResponse } from '@common/content/interfaces/reel-subtitles.interface';
import { ReelSubtitleTranslator } from '@content/application/services/reel-subtitle-translator.service';
import { Injectable } from '@nestjs/common';
import { GetReelUseCase } from './get-reel.use-case';

/** "original" is the spoken language; the others are translations. */
export type SubtitleLanguage = 'original' | SubtitleTargetLanguage;

export type ReelSubtitles = ReelSubtitlesResponse;

export class SubtitlesUnavailableError extends Error {}
export class InvalidSubtitleLanguageError extends Error {}

export function parseSubtitleLanguage(value: unknown): SubtitleLanguage {
  if (value === undefined || value === null || value === '') return 'original';
  if (value === 'original' || isSubtitleTargetLanguage(value)) return value;
  throw new InvalidSubtitleLanguageError(
    'Subtitle language must be one of: original, vi, en',
  );
}

@Injectable()
export class GetReelSubtitlesUseCase {
  constructor(
    private readonly getReel: GetReelUseCase,
    private readonly translator: ReelSubtitleTranslator,
  ) {}

  /** Returns null when the reel does not exist or the viewer may not see it. */
  async execute(input: {
    reelId: string;
    viewerId: string;
    isAdmin?: boolean;
    language: SubtitleLanguage;
  }): Promise<ReelSubtitles | null> {
    const reel = await this.getReel.execute(
      input.reelId,
      input.viewerId,
      input.isAdmin === true,
    );
    if (!reel) return null;

    const source = this.translator.sourceOf(reel);
    if (!source) {
      throw new SubtitlesUnavailableError(
        'This reel has no transcript to show as subtitles',
      );
    }
    if (input.language === 'original' || input.language === source.language) {
      return {
        reelId: reel.id,
        language: source.language,
        sourceLanguage: source.language,
        translated: false,
        cues: source.cues,
      };
    }

    const track = await this.translator.track(reel, source, input.language);
    return {
      reelId: reel.id,
      language: input.language,
      sourceLanguage: source.language,
      translated: true,
      cues: track.cues,
    };
  }
}
