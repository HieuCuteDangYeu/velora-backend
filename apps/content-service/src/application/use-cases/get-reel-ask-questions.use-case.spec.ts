import {
  GetReelAskQuestionsUseCase,
  sampleTranscript,
} from './get-reel-ask-questions.use-case';

const reel = {
  id: 'r1',
  title: 'Omelets',
  tags: ['cooking'],
  transcript: 'Crack the eggs and whisk them.',
  transcriptSegments: [
    { start: 0, end: 2, text: 'Crack the eggs and whisk them.' },
  ],
  indexCompletedAt: new Date(1_000),
  updatedAt: new Date(2_000),
};

function setup(options: {
  reel?: unknown;
  cached?: string | null;
  suggest?: jest.Mock;
}) {
  const cache = {
    get: jest.fn().mockResolvedValue(options.cached ?? null),
    set: jest.fn().mockResolvedValue('OK'),
  };
  const suggest =
    options.suggest ??
    jest.fn().mockResolvedValue({ questions: ['How do you whisk eggs?'] });
  const getReel = {
    execute: jest
      .fn()
      .mockResolvedValue(options.reel === undefined ? reel : options.reel),
  };
  const useCase = new GetReelAskQuestionsUseCase(
    getReel as never,
    { suggest },
    cache,
  );
  return { useCase, cache, suggest, getReel };
}

const input = { reelId: 'r1', viewerId: 'v1' };

describe('GetReelAskQuestionsUseCase', () => {
  it('returns null when the viewer may not see the reel', async () => {
    const { useCase, suggest } = setup({ reel: null });
    await expect(useCase.execute(input)).resolves.toBeNull();
    expect(suggest).not.toHaveBeenCalled();
  });

  it('asks the model once and caches the questions for the indexed version', async () => {
    const { useCase, cache, suggest } = setup({});
    await expect(useCase.execute(input)).resolves.toEqual({
      reelId: 'r1',
      questions: ['How do you whisk eggs?'],
    });
    expect(suggest).toHaveBeenCalledWith(
      expect.objectContaining({
        transcript: 'Crack the eggs and whisk them.',
        tags: ['cooking'],
      }),
    );
    expect(cache.set).toHaveBeenCalledWith(
      'reel:ask-questions:v1:r1:1000',
      JSON.stringify(['How do you whisk eggs?']),
      'EX',
      30 * 24 * 60 * 60,
    );
  });

  it('serves cached questions without calling the model', async () => {
    const { useCase, suggest } = setup({ cached: '["Cached question?"]' });
    await expect(useCase.execute(input)).resolves.toEqual({
      reelId: 'r1',
      questions: ['Cached question?'],
    });
    expect(suggest).not.toHaveBeenCalled();
  });

  it('shares one model call between viewers opening the same reel', async () => {
    let release: (value: unknown) => void = () => undefined;
    const suggest = jest.fn().mockReturnValue(
      new Promise((resolve) => {
        release = resolve;
      }),
    );
    const { useCase } = setup({ suggest });
    const first = useCase.execute(input);
    const second = useCase.execute({ ...input, viewerId: 'v2' });
    await new Promise((resolve) => setImmediate(resolve));
    release({ questions: ['Shared question?'] });
    await expect(Promise.all([first, second])).resolves.toHaveLength(2);
    expect(suggest).toHaveBeenCalledTimes(1);
  });

  it('does not cache a failed model call', async () => {
    const { useCase, cache } = setup({
      suggest: jest.fn().mockRejectedValue(new Error('timeout')),
    });
    await expect(useCase.execute(input)).resolves.toEqual({
      reelId: 'r1',
      questions: [],
    });
    expect(cache.set).not.toHaveBeenCalled();
  });

  it('skips the model for a reel without speech', async () => {
    const { useCase, suggest } = setup({
      reel: { ...reel, transcript: '', transcriptSegments: [] },
    });
    await expect(useCase.execute(input)).resolves.toEqual({
      reelId: 'r1',
      questions: [],
    });
    expect(suggest).not.toHaveBeenCalled();
  });
});

describe('sampleTranscript', () => {
  it('spreads a long transcript over the whole reel', () => {
    const segments = Array.from({ length: 100 }, (_, index) => ({
      start: index,
      end: index + 1,
      text: `segment-${index} ${'word '.repeat(10)}`,
    }));
    const sample = sampleTranscript({ transcriptSegments: segments }, 1_000);
    expect(sample.length).toBeLessThanOrEqual(1_000);
    expect(sample).toContain('segment-0 ');
    const last = Math.max(
      ...[...sample.matchAll(/segment-(\d+)/g)].map((match) =>
        Number(match[1]),
      ),
    );
    expect(last).toBeGreaterThan(80);
  });
});
