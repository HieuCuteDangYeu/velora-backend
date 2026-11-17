import type { SubtitleTargetLanguage } from '@common/ai/interfaces/subtitle-translation.interface';
import type { TranscriptSegment } from '@common/ai/interfaces/transcription-result.interface';
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

export interface SubtitleSource {
  language: string;
  cues: SubtitleCue[];
}

export interface SubtitleTranslationReel {
  id: string;
  title?: string | null;
  transcriptSegments?: TranscriptSegment[] | null;
}

/**
 * The stored, translated subtitle tracks of a reel. Shared by the viewer's request and by the translation that runs
 * when a reel is processed, so the two never pay for the same translation twice.
 */
@Injectable()
export class ReelSubtitleTranslator {
  // Two requests for the same new translation share one model call.
  private readonly inFlight = new Map<string, Promise<StoredSubtitleTrack>>();

  constructor(
    @Inject('IReelSubtitleTrackRepository')
    private readonly tracks: IReelSubtitleTrackRepository,
    @Inject('ISubtitleTranslationService')
    private readonly translation: ISubtitleTranslationService,
  ) {}

  /** The spoken-language lines of a reel, or null when it has no usable transcript. */
  sourceOf(reel: SubtitleTranslationReel): SubtitleSource | null {
    const cues = buildSubtitleCues(reel.transcriptSegments);
    if (cues.length === 0) return null;
    return {
      language: detectTranscriptLanguage(reel.transcriptSegments ?? []),
      cues,
    };
  }

  /** Whether a stored translation already matches the reel's current transcript. */
  async hasCurrent(
    reel: SubtitleTranslationReel,
    source: SubtitleSource,
    language: SubtitleTargetLanguage,
  ): Promise<boolean> {
    const stored = await this.tracks.find(reel.id, language);
    return stored?.sourceHash === this.hashSource(source);
  }

  /** The stored translation when it still matches the transcript, otherwise a fresh one that is stored. */
  async track(
    reel: SubtitleTranslationReel,
    source: SubtitleSource,
    language: SubtitleTargetLanguage,
  ): Promise<StoredSubtitleTrack> {
    const sourceHash = this.hashSource(source);
    const cached = await this.tracks.find(reel.id, language);
    if (cached && cached.sourceHash === sourceHash) return cached;

    const key = `${reel.id}:${language}:${sourceHash}`;
    const running = this.inFlight.get(key);
    if (running) return running;

    const work = this.translateAndStore(
      reel,
      source,
      language,
      sourceHash,
    ).finally(() => this.inFlight.delete(key));
    this.inFlight.set(key, work);
    return work;
  }

  private async translateAndStore(
    reel: SubtitleTranslationReel,
    source: SubtitleSource,
    language: SubtitleTargetLanguage,
    sourceHash: string,
  ): Promise<StoredSubtitleTrack> {
    const result = await this.translation.translate({
      sourceLanguage: source.language,
      targetLanguage: language,
      ...(reel.title ? { title: reel.title } : {}),
      cues: source.cues.map((cue) => ({ index: cue.index, text: cue.text })),
    });
    const text = new Map(result.cues.map((cue) => [cue.index, cue.text]));
    const translated = source.cues.map((cue) => {
      const line = text.get(cue.index);
      if (!line) {
        throw new Error(`Translation is missing subtitle line ${cue.index}`);
      }
      return { ...cue, text: line };
    });
    const track = { sourceHash, cues: translated, model: result.model };
    await this.tracks.save(reel.id, language, track);
    return track;
  }

  private hashSource(source: SubtitleSource): string {
    return createHash('sha256')
      .update(
        JSON.stringify([
          source.language,
          source.cues.map((cue) => [cue.start, cue.end, cue.text]),
        ]),
      )
      .digest('hex');
  }
}
