export interface ReelSubtitleCue {
  index: number;
  /** Seconds from the start of the reel. */
  start: number;
  end: number;
  text: string;
}

export interface ReelSubtitlesResponse {
  reelId: string;
  /** Language of `cues`. */
  language: string;
  /** Language spoken in the reel. */
  sourceLanguage: string;
  translated: boolean;
  cues: ReelSubtitleCue[];
}
