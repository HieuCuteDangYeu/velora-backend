import type { TranscriptSegment } from '@common/ai/interfaces/transcription-result.interface';
import type { ReelSubtitleCue } from '@common/content/interfaces/reel-subtitles.interface';

export type SubtitleCue = ReelSubtitleCue;

const CJK = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/u;
const HANGUL = /\p{Script=Hangul}/u;
const VIETNAMESE_MARKS =
  /[ăâđêôơưàáạảãằắặẳẵầấậẩẫèéẹẻẽềếệểễìíịỉĩòóọỏõồốộổỗờớợởỡùúụủũừứựửữỳýỵỷỹ]/i;
const SENTENCE_END = /[。！？!?….]$/;
const CLAUSE_END = /[，、；;,:：]$/;
const PUNCTUATION_ONLY = /^[\p{P}\p{S}\s]+$/u;

// Readable on a phone: roughly two short lines of Latin text or one line of CJK.
const LIMITS = {
  cjk: { maxChars: 16, softChars: 9, pauseSeconds: 0.35 },
  latin: { maxChars: 42, softChars: 24, pauseSeconds: 0.6 },
};
const MAX_CUE_SECONDS = 5;
const MIN_CUE_SECONDS = 0.8;

export type SubtitleScript = 'cjk' | 'latin';

/** Source language of a transcript: segment tags when present, otherwise its script. */
export function detectTranscriptLanguage(
  segments: readonly TranscriptSegment[],
): string {
  const tagged = new Map<string, number>();
  for (const segment of segments) {
    const tag = segment.detectedLanguage?.trim().toLowerCase();
    if (tag) tagged.set(tag, (tagged.get(tag) ?? 0) + 1);
  }
  const [top] = [...tagged.entries()].sort((a, b) => b[1] - a[1]);
  if (top) return normalizeLanguageTag(top[0]);

  const text = segments.map((segment) => segment.text).join(' ');
  const letters = [...text].filter((char) => /\p{L}/u.test(char));
  if (letters.length === 0) return 'und';
  const share = (test: (char: string) => boolean) =>
    letters.filter(test).length / letters.length;
  if (share((char) => HANGUL.test(char)) > 0.3) return 'ko';
  if (
    share((char) => /[\p{Script=Hiragana}\p{Script=Katakana}]/u.test(char)) >
    0.1
  )
    return 'ja';
  if (share((char) => CJK.test(char)) > 0.3) return 'zh';
  return VIETNAMESE_MARKS.test(text) ? 'vi' : 'en';
}

export function normalizeLanguageTag(tag: string): string {
  const lower = tag.trim().toLowerCase();
  const names: Record<string, string> = {
    chinese: 'zh',
    mandarin: 'zh',
    cantonese: 'zh',
    english: 'en',
    vietnamese: 'vi',
    japanese: 'ja',
    korean: 'ko',
  };
  return names[lower] ?? lower.split(/[-_]/)[0];
}

function scriptOf(text: string): SubtitleScript {
  return CJK.test(text) || HANGUL.test(text) ? 'cjk' : 'latin';
}

function join(current: string, next: string, script: SubtitleScript): string {
  if (!current) return next;
  if (script === 'cjk') return `${current}${next}`;
  // Latin punctuation tokens ("." or ",") attach to the previous word.
  return PUNCTUATION_ONLY.test(next)
    ? `${current}${next}`
    : `${current} ${next}`;
}

/**
 * Groups the word-level tokens stored for a reel into readable subtitle lines. A line ends at a sentence end, at a pause,
 * or when it gets too long or too slow to read, and never overlaps the next one.
 */
export function buildSubtitleCues(
  segments: readonly TranscriptSegment[] | null | undefined,
): SubtitleCue[] {
  const tokens = (segments ?? [])
    .filter(
      (segment) =>
        typeof segment.text === 'string' &&
        segment.text.trim().length > 0 &&
        Number.isFinite(segment.start) &&
        Number.isFinite(segment.end),
    )
    .map((segment) => ({
      text: segment.text.trim(),
      start: Math.max(0, segment.start),
      end: Math.max(0, segment.end),
    }))
    .sort((a, b) => a.start - b.start);
  if (tokens.length === 0) return [];

  const script = scriptOf(tokens.map((token) => token.text).join(''));
  const limits = LIMITS[script];
  const cues: SubtitleCue[] = [];
  let text = '';
  let start = 0;
  let end = 0;

  const flush = () => {
    const trimmed = text.trim();
    if (trimmed && !PUNCTUATION_ONLY.test(trimmed)) {
      cues.push({
        index: cues.length,
        start,
        end: Math.max(end, start + MIN_CUE_SECONDS),
        text: trimmed,
      });
    }
    text = '';
  };

  for (const token of tokens) {
    if (text) {
      const joined = join(text, token.text, script);
      const pause = token.start - end;
      const tooLong = [...joined].length > limits.maxChars;
      const tooSlow = token.end - start > MAX_CUE_SECONDS;
      const paused =
        pause >= limits.pauseSeconds && [...text].length >= limits.softChars;
      if (tooLong || tooSlow || paused || pause >= 1.5) flush();
    }
    if (!text) start = token.start;
    text = join(text, token.text, script);
    end = Math.max(end, token.end);
    const length = [...text].length;
    if (
      SENTENCE_END.test(token.text) ||
      (CLAUSE_END.test(token.text) && length >= limits.softChars)
    ) {
      flush();
    }
  }
  flush();

  // A short line must not run into the next one.
  for (let i = 0; i < cues.length - 1; i += 1) {
    if (cues[i].end > cues[i + 1].start) cues[i].end = cues[i + 1].start;
    if (cues[i].end <= cues[i].start) cues[i].end = cues[i].start + 0.3;
  }
  return cues;
}
