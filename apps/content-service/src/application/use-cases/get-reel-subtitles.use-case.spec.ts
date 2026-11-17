import type { TranslateSubtitleCuesRequest } from '@common/ai/interfaces/subtitle-translation.interface';
import type { TranscriptSegment } from '@common/ai/interfaces/transcription-result.interface';
import type { StoredSubtitleTrack } from '@content/domain/interfaces/reel-subtitle-track.repository.interface';
import { ReelSubtitleTranslator } from '@content/application/services/reel-subtitle-translator.service';
import {
  GetReelSubtitlesUseCase,
  InvalidSubtitleLanguageError,
  SubtitlesUnavailableError,
  parseSubtitleLanguage,
} from './get-reel-subtitles.use-case';

const chinese: TranscriptSegment[] = [
  { text: '我是', start: 1.8, end: 1.9 },
  { text: '定北王', start: 1.9, end: 2.4 },
  { text: '再见', start: 4.5, end: 4.9 },
];

const reelWith = (segments?: TranscriptSegment[]) => ({
  id: 'reel-1',
  title: 'Episode 1',
  transcriptSegments: segments,
});

function build(options: {
  reel?: unknown;
  stored?: StoredSubtitleTrack | null;
  translate?: jest.Mock;
}) {
  const getReel = {
    execute: jest.fn().mockResolvedValue(options.reel ?? reelWith(chinese)),
  };
  const tracks = {
    find: jest.fn().mockResolvedValue(options.stored ?? null),
    save: jest.fn().mockResolvedValue(undefined),
  };
  const translate =
    options.translate ??
    jest.fn().mockImplementation((request: TranslateSubtitleCuesRequest) =>
      Promise.resolve({
        model: 'm1',
        cues: request.cues.map((cue) => ({
          index: cue.index,
          text: `vi-${cue.index}`,
        })),
      }),
    );
  const translator = new ReelSubtitleTranslator(tracks, { translate });
  const useCase = new GetReelSubtitlesUseCase(getReel as never, translator);
  return { useCase, getReel, tracks, translate };
}

const ask = (language: 'original' | 'vi' | 'en') => ({
  reelId: 'reel-1',
  viewerId: 'viewer',
  language,
});

describe('GetReelSubtitlesUseCase', () => {
  it('returns null when the reel is missing or hidden from the viewer', async () => {
    const { useCase, getReel } = build({});
    getReel.execute.mockResolvedValue(null);
    await expect(useCase.execute(ask('vi'))).resolves.toBeNull();
  });

  it('fails clearly when the reel has no transcript', async () => {
    const { useCase } = build({ reel: reelWith(undefined) });
    await expect(useCase.execute(ask('vi'))).rejects.toBeInstanceOf(
      SubtitlesUnavailableError,
    );
  });

  it('returns the spoken-language lines for "original" without translating', async () => {
    const { useCase, translate } = build({});
    const result = await useCase.execute(ask('original'));

    expect(result).toMatchObject({
      reelId: 'reel-1',
      language: 'zh',
      sourceLanguage: 'zh',
      translated: false,
    });
    expect(result?.cues.map((cue) => cue.text)).toEqual(['我是定北王', '再见']);
    expect(translate).not.toHaveBeenCalled();
  });

  it('translates once, keeps the timing and stores the result', async () => {
    const { useCase, translate, tracks } = build({});
    const result = await useCase.execute(ask('vi'));

    expect(result).toMatchObject({
      language: 'vi',
      sourceLanguage: 'zh',
      translated: true,
    });
    expect(result?.cues).toEqual([
      { index: 0, start: 1.8, end: expect.any(Number), text: 'vi-0' },
      { index: 1, start: 4.5, end: expect.any(Number), text: 'vi-1' },
    ]);
    expect(translate).toHaveBeenCalledWith(
      expect.objectContaining({
        sourceLanguage: 'zh',
        targetLanguage: 'vi',
        title: 'Episode 1',
      }),
    );
    expect(tracks.save).toHaveBeenCalledWith(
      'reel-1',
      'vi',
      expect.objectContaining({ model: 'm1' }),
    );
  });

  it('serves the stored translation without calling the model again', async () => {
    const first = build({});
    await first.useCase.execute(ask('en'));
    const saved = first.tracks.save.mock.calls[0][2] as StoredSubtitleTrack;

    const second = build({ stored: saved });
    const result = await second.useCase.execute(ask('en'));

    expect(second.translate).not.toHaveBeenCalled();
    expect(result?.cues).toEqual(saved.cues);
  });

  it('translates again when the transcript changed since the stored translation', async () => {
    const { useCase, translate } = build({
      stored: { sourceHash: 'old', cues: [], model: 'm0' },
    });
    await useCase.execute(ask('vi'));
    expect(translate).toHaveBeenCalledTimes(1);
  });

  it('returns the original lines when the spoken language is already the requested one', async () => {
    const { useCase, translate } = build({
      reel: reelWith([
        { text: 'Xin', start: 0, end: 0.3 },
        { text: 'chào', start: 0.3, end: 0.6 },
        { text: 'các', start: 0.6, end: 0.8 },
        { text: 'bạn', start: 0.8, end: 1.2 },
      ]),
    });
    const result = await useCase.execute(ask('vi'));
    expect(result).toMatchObject({ language: 'vi', translated: false });
    expect(translate).not.toHaveBeenCalled();
  });

  it('shares one model call between simultaneous requests for the same translation', async () => {
    let release!: () => void;
    const translate = jest.fn().mockImplementation(
      (request: TranslateSubtitleCuesRequest) =>
        new Promise((resolve) => {
          release = () =>
            resolve({
              model: 'm1',
              cues: request.cues.map((cue) => ({
                index: cue.index,
                text: 'x',
              })),
            });
        }),
    );
    const { useCase } = build({ translate });

    const a = useCase.execute(ask('vi'));
    const b = useCase.execute(ask('vi'));
    await new Promise((resolve) => setImmediate(resolve));
    release();
    await Promise.all([a, b]);

    expect(translate).toHaveBeenCalledTimes(1);
  });

  it('does not store anything when the model leaves a line out', async () => {
    const translate = jest.fn().mockResolvedValue({
      model: 'm1',
      cues: [{ index: 0, text: 'only one' }],
    });
    const { useCase, tracks } = build({ translate });

    await expect(useCase.execute(ask('vi'))).rejects.toThrow(
      'missing subtitle line 1',
    );
    expect(tracks.save).not.toHaveBeenCalled();
  });
});

describe('parseSubtitleLanguage', () => {
  it('defaults to the original language and accepts vi and en', () => {
    expect(parseSubtitleLanguage(undefined)).toBe('original');
    expect(parseSubtitleLanguage('')).toBe('original');
    expect(parseSubtitleLanguage('vi')).toBe('vi');
    expect(parseSubtitleLanguage('en')).toBe('en');
  });

  it.each(['fr', 'VI', 'zh', 42])('rejects %p', (value) => {
    expect(() => parseSubtitleLanguage(value)).toThrow(
      InvalidSubtitleLanguageError,
    );
  });
});
