import type { SubtitleCue } from '@content/domain/subtitle-cues';

export interface StoredSubtitleTrack {
  sourceHash: string;
  cues: SubtitleCue[];
  model: string;
}

export interface IReelSubtitleTrackRepository {
  find(reelId: string, language: string): Promise<StoredSubtitleTrack | null>;
  /** Replaces the track for this reel and language. */
  save(
    reelId: string,
    language: string,
    track: StoredSubtitleTrack,
  ): Promise<void>;
}
