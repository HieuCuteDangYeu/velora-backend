import {
  type SubtitleTargetLanguage,
  isSubtitleTargetLanguage,
} from '@common/ai/interfaces/subtitle-translation.interface';
import type { ReelSubtitlesResponse } from '@common/content/interfaces/reel-subtitles.interface';
import type {
  IReelSubtitleTrackRepository,
  StoredSubtitleTrack,
} from '@content/domain/interfaces/reel-subtitle-track.repository.interface';
import type { ISubtitleTranslationService } from '@content/domain/interfaces/subtitle-translation.service.interface';
import {
  type SubtitleCue,
  buildSubtitleCues,
  detectTranscriptLanguage,
} from '@content/domain/subtitle-cues';
import { Inject, Injectable } from '@nestjs/common';
import { createHash } from 'crypto';
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
  // Two viewers asking for the same new translation share one model call.
  private readonly inFlight = new Map<string, Promise<StoredSubtitleTrack>>();

  constructor(
    private readonly getReel: GetReelUseCase,
    @Inject('IReelSubtitleTrackRepository')
    private readonly tracks: IReelSubtitleTrackRepository,
    @Inject('ISubtitleTranslationService')
    private readonly translation: ISubtitleTranslationService,
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

    const cues = buildSubtitleCues(reel.transcriptSegments);
    if (cues.length === 0) {
      throw new SubtitlesUnavailableError(
        'This reel has no transcript to show as subtitles',
      );
    }
    const sourceLanguage = detectTranscriptLanguage(
      reel.transcriptSegments ?? [],
    );
    if (input.language === 'original' || input.language === sourceLanguage) {
      return {
        reelId: reel.id,
        language: sourceLanguage,
        sourceLanguage,
        translated: false,
        cues,
      };
    }

    const sourceHash = this.hashSource(sourceLanguage, cues);
    const track = await this.translatedTrack({
      reelId: reel.id,
      title: reel.title,
      sourceLanguage,
      language: input.language,
      sourceHash,
      cues,
    });
    return {
      reelId: reel.id,
      language: input.language,
      sourceLanguage,
      translated: true,
      cues: track.cues,
    };
  }

  private async translatedTrack(input: {
    reelId: string;
    title?: string;
    sourceLanguage: string;
    language: SubtitleTargetLanguage;
    sourceHash: string;
    cues: SubtitleCue[];
  }): Promise<StoredSubtitleTrack> {
    const cached = await this.tracks.find(input.reelId, input.language);
    if (cached && cached.sourceHash === input.sourceHash) return cached;

    const key = `${input.reelId}:${input.language}:${input.sourceHash}`;
    const running = this.inFlight.get(key);
    if (running) return running;

    const work = this.translateAndStore(input).finally(() =>
      this.inFlight.delete(key),
    );
    this.inFlight.set(key, work);
    return work;
  }

  private async translateAndStore(input: {
    reelId: string;
    title?: string;
    sourceLanguage: string;
    language: SubtitleTargetLanguage;
    sourceHash: string;
    cues: SubtitleCue[];
  }): Promise<StoredSubtitleTrack> {
    const result = await this.translation.translate({
      sourceLanguage: input.sourceLanguage,
      targetLanguage: input.language,
      ...(input.title ? { title: input.title } : {}),
      cues: input.cues.map((cue) => ({ index: cue.index, text: cue.text })),
    });
    const text = new Map(result.cues.map((cue) => [cue.index, cue.text]));
    const translated = input.cues.map((cue) => {
      const line = text.get(cue.index);
      if (!line) {
        throw new Error(`Translation is missing subtitle line ${cue.index}`);
      }
      return { ...cue, text: line };
    });
    const track = {
      sourceHash: input.sourceHash,
      cues: translated,
      model: result.model,
    };
    await this.tracks.save(input.reelId, input.language, track);
    return track;
  }

  private hashSource(language: string, cues: SubtitleCue[]): string {
    return createHash('sha256')
      .update(
        JSON.stringify([
          language,
          cues.map((cue) => [cue.start, cue.end, cue.text]),
        ]),
      )
      .digest('hex');
  }
}
