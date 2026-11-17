import type { TranscriptSegment } from '@common/ai/interfaces/transcription-result.interface';
import {
  buildSubtitleCues,
  detectTranscriptLanguage,
  normalizeLanguageTag,
} from './subtitle-cues';

// Word-level tokens as Whisper stores them: one token per word or character, seconds.
const tokens = (
  items: Array<[text: string, start: number, end: number]>,
): TranscriptSegment[] =>
  items.map(([text, start, end], id) => ({ id, text, start, end }));

describe('buildSubtitleCues', () => {
  it('returns nothing for a missing or empty transcript', () => {
    expect(buildSubtitleCues(undefined)).toEqual([]);
    expect(buildSubtitleCues([])).toEqual([]);
    expect(buildSubtitleCues(tokens([['  ', 0, 1]]))).toEqual([]);
  });

  it('joins Chinese tokens without spaces and splits at a pause', () => {
    const cues = buildSubtitleCues(
      tokens([
        ['我是', 1.8, 1.9],
        ['定', 1.9, 2.14],
        ['北', 2.14, 2.3],
        ['王', 2.3, 2.42],
        ['的', 2.42, 2.56],
        ['奴', 2.56, 2.8],
        ['才', 2.8, 3.0],
        ['你', 3.2, 3.4],
        ['好', 3.4, 3.6],
        // 0.9 s pause, then a new sentence
        ['再见', 4.5, 4.9],
      ]),
    );
    expect(cues.map((cue) => cue.text)).toEqual([
      '我是定北王的奴才你好',
      '再见',
    ]);
    expect(cues[0]).toMatchObject({ index: 0, start: 1.8 });
    expect(cues[1]).toMatchObject({ index: 1, start: 4.5 });
  });

  it('breaks a long Chinese run into lines of at most 16 characters', () => {
    const items: Array<[string, number, number]> = Array.from(
      { length: 40 },
      (_, i) => ['字', i * 0.1, i * 0.1 + 0.1],
    );
    const cues = buildSubtitleCues(tokens(items));
    expect(cues.length).toBeGreaterThan(1);
    for (const cue of cues)
      expect([...cue.text].length).toBeLessThanOrEqual(16);
    expect(cues.map((cue) => cue.text).join('')).toBe('字'.repeat(40));
  });

  it('joins English words with spaces and attaches punctuation to the previous word', () => {
    const cues = buildSubtitleCues(
      tokens([
        ['So', 0.2, 0.4],
        ['I', 0.4, 0.5],
        ['left', 0.5, 0.8],
        [',', 0.8, 0.8],
        ['and', 0.9, 1.0],
        ['never', 1.0, 1.4],
        ['came', 1.4, 1.6],
        ['back', 1.6, 1.9],
        ['.', 1.9, 1.9],
        ['Why', 2.2, 2.4],
        ['?', 2.4, 2.4],
      ]),
    );
    expect(cues.map((cue) => cue.text)).toEqual([
      'So I left, and never came back.',
      'Why?',
    ]);
  });

  it('never lets a cue overlap the next one and gives short cues a readable length', () => {
    const cues = buildSubtitleCues(
      tokens([
        ['你好', 0, 0.2],
        ['。', 0.2, 0.2],
        ['再见', 0.3, 0.5],
      ]),
    );
    expect(cues).toHaveLength(2);
    expect(cues[0].end).toBeLessThanOrEqual(cues[1].start);
    expect(cues[0].end).toBeGreaterThan(cues[0].start);
  });

  it('ignores tokens without usable times and sorts out-of-order input', () => {
    const cues = buildSubtitleCues([
      { text: '后', start: 1, end: 1.2 },
      { text: '先', start: 0, end: 0.2 },
      { text: '坏', start: Number.NaN, end: 1 },
    ] as TranscriptSegment[]);
    expect(cues.map((cue) => cue.text)).toEqual(['先后']);
  });
});

describe('detectTranscriptLanguage', () => {
  it('prefers the language tag stored on the segments', () => {
    expect(
      detectTranscriptLanguage([
        { text: 'xin chào', start: 0, end: 1, detectedLanguage: 'Vietnamese' },
      ]),
    ).toBe('vi');
  });

  it('falls back to the script of the text', () => {
    const seg = (text: string): TranscriptSegment[] => [
      { text, start: 0, end: 1 },
    ];
    expect(detectTranscriptLanguage(seg('我是定北王的奴才'))).toBe('zh');
    expect(detectTranscriptLanguage(seg('So I left and never came back'))).toBe(
      'en',
    );
    expect(
      detectTranscriptLanguage(seg('Tôi đã rời đi và không quay lại')),
    ).toBe('vi');
    expect(detectTranscriptLanguage(seg('안녕하세요 여러분'))).toBe('ko');
    expect(detectTranscriptLanguage(seg('こんにちは、元気ですか'))).toBe('ja');
    expect(detectTranscriptLanguage(seg('...'))).toBe('und');
  });

  it('normalizes language names and region tags', () => {
    expect(normalizeLanguageTag('Chinese')).toBe('zh');
    expect(normalizeLanguageTag('zh-CN')).toBe('zh');
    expect(normalizeLanguageTag('EN_us')).toBe('en');
  });
});
