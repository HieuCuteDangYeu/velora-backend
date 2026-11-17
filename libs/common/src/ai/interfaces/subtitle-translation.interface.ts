export const SUBTITLE_TARGET_LANGUAGES = ['vi', 'en'] as const;
export type SubtitleTargetLanguage = (typeof SUBTITLE_TARGET_LANGUAGES)[number];

export function isSubtitleTargetLanguage(
  value: unknown,
): value is SubtitleTargetLanguage {
  return (
    typeof value === 'string' &&
    (SUBTITLE_TARGET_LANGUAGES as readonly string[]).includes(value)
  );
}

/** Upper bound for one request; a 3 minute reel has about 50 subtitle lines. */
export const SUBTITLE_TRANSLATION_MAX_CUES = 400;
export const SUBTITLE_TRANSLATION_MAX_CUE_CHARS = 300;

export interface SubtitleTranslationCue {
  index: number;
  text: string;
}

export interface TranslateSubtitleCuesRequest {
  /** ISO 639-1 code of the spoken language, for example "zh". */
  sourceLanguage: string;
  targetLanguage: SubtitleTargetLanguage;
  /** Reel title, used only to keep names consistent. */
  title?: string;
  cues: SubtitleTranslationCue[];
}

export interface TranslateSubtitleCuesResult {
  cues: SubtitleTranslationCue[];
  model: string;
}
