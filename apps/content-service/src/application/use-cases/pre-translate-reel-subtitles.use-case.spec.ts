import type { TranslateSubtitleCuesRequest } from '@common/ai/interfaces/subtitle-translation.interface';
import type { TranscriptSegment } from '@common/ai/interfaces/transcription-result.interface';
import { ReelSubtitleTranslator } from '@content/application/services/reel-subtitle-translator.service';
import type { StoredSubtitleTrack } from '@content/domain/interfaces/reel-subtitle-track.repository.interface';
import { PreTranslateReelSubtitlesUseCase } from './pre-translate-reel-subtitles.use-case';

const chinese: TranscriptSegment[] = [
  { text: '我是', start: 1.8, end: 1.9 },
  { text: '定北王', start: 1.9, end: 2.4 },
  { text: '再见', start: 4.5, end: 4.9 },
];
const vietnamese: TranscriptSegment[] = [
  { text: 'Xin', start: 0, end: 0.3 },
  { text: 'chào', start: 0.3, end: 0.6 },
  { text: 'các', start: 0.6, end: 0.8 },
  { text: 'bạn', start: 0.8, end: 1.2 },
];

const reelWith = (segments?: TranscriptSegment[]) => ({
  id: 'reel-1',
  title: 'Episode 1',
  transcriptSegments: segments,
});

const targets = (mock: jest.Mock) =>
  (mock.mock.calls as [TranslateSubtitleCuesRequest][]).map(
    ([request]) => request.targetLanguage,
  );

function build(
  options: {
    reel?: unknown;
    stored?: StoredSubtitleTrack | null;
    translate?: jest.Mock;
  } = {},
) {
  const repository = {
    findById: jest
      .fn()
      .mockResolvedValue('reel' in options ? options.reel : reelWith(chinese)),
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
          text: `t-${cue.index}`,
        })),
      }),
    );
  const translator = new ReelSubtitleTranslator(tracks, { translate });
  const useCase = new PreTranslateReelSubtitlesUseCase(
    repository as never,
    translator,
  );
  return { useCase, repository, tracks, translate, translator };
}

describe('PreTranslateReelSubtitlesUseCase', () => {
  it('stores a translation for each offered language the reel is not spoken in', async () => {
    const { useCase, translate, tracks, repository } = build();
    await useCase.execute('reel-1');

    expect(repository.findById).toHaveBeenCalledWith('reel-1');
    expect(targets(translate)).toEqual(['vi', 'en']);
    expect(
      (tracks.save.mock.calls as [string, string][]).map(
        ([, language]) => language,
      ),
    ).toEqual(['vi', 'en']);
  });

  it('skips the spoken language', async () => {
    const { useCase, translate } = build({ reel: reelWith(vietnamese) });
    await useCase.execute('reel-1');
    expect(targets(translate)).toEqual(['en']);
  });

  it('skips languages that are already stored for this transcript', async () => {
    const first = build();
    await first.translator.track(
      reelWith(chinese),
      first.translator.sourceOf(reelWith(chinese)) as never,
      'vi',
    );
    const saved = first.tracks.save.mock.calls[0][2] as StoredSubtitleTrack;

    const second = build({ stored: saved });
    await second.useCase.execute('reel-1');
    expect(second.translate).not.toHaveBeenCalled();
  });

  it('never rejects: no reel, no transcript, a failing model or a failing lookup are all absorbed', async () => {
    const missing = build({ reel: null });
    await expect(missing.useCase.execute('reel-1')).resolves.toBeUndefined();

    const silent = build({ reel: reelWith(undefined) });
    await expect(silent.useCase.execute('reel-1')).resolves.toBeUndefined();
    expect(silent.translate).not.toHaveBeenCalled();

    const failing = build({
      translate: jest.fn().mockRejectedValue(new Error('boom')),
    });
    await expect(failing.useCase.execute('reel-1')).resolves.toBeUndefined();
    // One failed language does not stop the next one.
    expect(failing.translate).toHaveBeenCalledTimes(2);
    expect(failing.tracks.save).not.toHaveBeenCalled();

    const broken = build();
    broken.repository.findById.mockRejectedValue(new Error('db down'));
    await expect(broken.useCase.execute('reel-1')).resolves.toBeUndefined();
  });

  it('translates one reel at a time', async () => {
    let running = 0;
    let peak = 0;
    const translate = jest
      .fn()
      .mockImplementation(async (request: TranslateSubtitleCuesRequest) => {
        running += 1;
        peak = Math.max(peak, running);
        await new Promise((resolve) => setTimeout(resolve, 5));
        running -= 1;
        return {
          model: 'm1',
          cues: request.cues.map((cue) => ({ index: cue.index, text: 'x' })),
        };
      });
    const { useCase } = build({ translate });
    await Promise.all([useCase.execute('a'), useCase.execute('b')]);
    expect(peak).toBe(1);
    expect(translate).toHaveBeenCalledTimes(4);
  });

  it('shares one model call with a viewer who asks for the same language meanwhile', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const translate = jest
      .fn()
      .mockImplementation(async (request: TranslateSubtitleCuesRequest) => {
        await gate;
        return {
          model: 'm1',
          cues: request.cues.map((cue) => ({ index: cue.index, text: 'x' })),
        };
      });
    const { useCase, translator } = build({ translate });
    const reel = reelWith(chinese);
    const source = translator.sourceOf(reel) as never;

    const background = useCase.execute('reel-1');
    await new Promise((resolve) => setImmediate(resolve));
    const viewer = translator.track(reel, source, 'vi');
    release();
    await Promise.all([background, viewer]);

    expect(
      targets(translate).filter((language) => language === 'vi'),
    ).toHaveLength(1);
  });
});
