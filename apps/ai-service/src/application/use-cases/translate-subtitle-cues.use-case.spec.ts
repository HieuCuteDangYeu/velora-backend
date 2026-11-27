import type { IAiApplicationConfig } from '@ai/domain/interfaces/ai-application-config.interface';
import type { TranslateSubtitleCuesRequest } from '@common/ai/interfaces/subtitle-translation.interface';
import {
  InvalidSubtitleTranslationRequestError,
  TranslateSubtitleCuesUseCase,
} from './translate-subtitle-cues.use-case';

describe('TranslateSubtitleCuesUseCase', () => {
  const config = {
    model: jest.fn(() => 'test-model'),
    timeoutMs: jest.fn(() => 90_000),
    maxCompletionTokens: jest.fn(() => 2_048),
  } as unknown as IAiApplicationConfig;

  const request = (
    count: number,
    overrides: Partial<TranslateSubtitleCuesRequest> = {},
  ): TranslateSubtitleCuesRequest => ({
    sourceLanguage: 'zh',
    targetLanguage: 'vi',
    title: 'Episode 1',
    cues: Array.from({ length: count }, (_, index) => ({
      index,
      text: `câu ${index}`,
    })),
    ...overrides,
  });

  const answer = (indexes: number[]) => ({
    translations: indexes.map((index) => ({ index, text: ` dịch ${index} ` })),
  });

  const build = (generateObject: jest.Mock) =>
    new TranslateSubtitleCuesUseCase({ generateObject } as never, config);

  it('translates every line in order and reports the model', async () => {
    const generateObject = jest.fn().mockResolvedValue(answer([2, 0, 1]));
    const result = await build(generateObject).execute(request(3));

    expect(result.model).toBe('test-model');
    expect(result.cues).toEqual([
      { index: 0, text: 'dịch 0' },
      { index: 1, text: 'dịch 1' },
      { index: 2, text: 'dịch 2' },
    ]);
    const call = generateObject.mock.calls[0][0];
    expect(call.modelRole).toBe('SUBTITLE_TRANSLATION');
    expect(call.systemPrompt).toContain('Chinese into natural Vietnamese');
    expect(call.userPrompt).toContain(
      'Video title (for names only): Episode 1',
    );
    expect(call.userPrompt).toContain('[0] câu 0');
  });

  it('batches long reels and gives each batch the line before it as context', async () => {
    const generateObject = jest
      .fn()
      .mockResolvedValueOnce(answer(Array.from({ length: 20 }, (_, i) => i)))
      .mockResolvedValueOnce(answer([20, 21, 22]));
    const result = await build(generateObject).execute(request(23));

    expect(generateObject).toHaveBeenCalledTimes(2);
    expect(result.cues).toHaveLength(23);
    const second = generateObject.mock.calls[1][0].userPrompt as string;
    expect(second).toContain('context, do not translate): câu 19');
    expect(second).not.toContain('[19]');
  });

  it('asks again for only the lines the model skipped', async () => {
    const generateObject = jest
      .fn()
      .mockResolvedValueOnce(answer([0, 2]))
      .mockResolvedValueOnce(answer([1]));
    const result = await build(generateObject).execute(request(3));

    expect(result.cues.map((cue) => cue.text)).toEqual([
      'dịch 0',
      'dịch 1',
      'dịch 2',
    ]);
    const retryPrompt = generateObject.mock.calls[1][0].userPrompt as string;
    expect(retryPrompt).toContain('[1] câu 1');
    expect(retryPrompt).not.toContain('[0] câu 0');
  });

  it('ignores indexes it did not ask for and blank translations', async () => {
    const generateObject = jest
      .fn()
      .mockResolvedValueOnce({
        translations: [
          { index: 0, text: 'ok' },
          { index: 99, text: 'stray' },
          { index: 1, text: '   ' },
        ],
      })
      .mockResolvedValueOnce(answer([1]));
    const result = await build(generateObject).execute(request(2));

    expect(result.cues).toEqual([
      { index: 0, text: 'ok' },
      { index: 1, text: 'dịch 1' },
    ]);
  });

  it('fails instead of returning a mostly untranslated track', async () => {
    const generateObject = jest.fn().mockResolvedValue(answer([0]));
    await expect(build(generateObject).execute(request(4))).rejects.toThrow(
      'did not return 3 of 4 line(s)',
    );
    // 3 batch attempts, then one retry for each of the 3 missing lines
    expect(generateObject).toHaveBeenCalledTimes(6);
  });

  it('retries a stubborn line on its own, then keeps its source text', async () => {
    const all = Array.from({ length: 40 }, (_, i) => i);
    const generateObject = jest.fn(({ userPrompt }: { userPrompt: string }) => {
      const asked = [...userPrompt.matchAll(/^\[(\d+)\]/gm)].map((m) =>
        Number(m[1]),
      );
      return Promise.resolve(answer(asked.filter((i) => i !== 5)));
    });
    const result = await build(generateObject).execute(request(40));
    expect(result.cues.map((c) => c.text)).toEqual(
      all.map((i) => (i === 5 ? 'câu 5' : `dịch ${i}`)),
    );
    expect(generateObject).toHaveBeenCalledTimes(2 + 2 + 1);
  });

  it('retries after a provider error instead of failing the reel', async () => {
    const generateObject = jest
      .fn()
      .mockRejectedValueOnce(new Error('Ollama structured completion failed'))
      .mockResolvedValueOnce(answer([0, 1]));
    const result = await build(generateObject).execute(request(2));
    expect(result.cues).toEqual([
      { index: 0, text: 'dịch 0' },
      { index: 1, text: 'dịch 1' },
    ]);
  });

  it('does not call the model when source and target language match', async () => {
    const generateObject = jest.fn();
    const result = await build(generateObject).execute(
      request(2, { sourceLanguage: 'vi' }),
    );

    expect(generateObject).not.toHaveBeenCalled();
    expect(result).toMatchObject({ model: 'none' });
    expect(result.cues).toHaveLength(2);
  });

  it.each([
    ['unsupported target', { targetLanguage: 'fr' as never }],
    ['bad source language', { sourceLanguage: 'Chinese!' }],
    ['no lines', { cues: [] }],
    ['blank line', { cues: [{ index: 0, text: '  ' }] }],
    [
      'duplicate index',
      {
        cues: [
          { index: 0, text: 'a' },
          { index: 0, text: 'b' },
        ],
      },
    ],
    ['oversized line', { cues: [{ index: 0, text: 'x'.repeat(301) }] }],
  ])('rejects a request with %s', async (_name, overrides) => {
    const generateObject = jest.fn();
    await expect(
      build(generateObject).execute(request(1, overrides)),
    ).rejects.toBeInstanceOf(InvalidSubtitleTranslationRequestError);
    expect(generateObject).not.toHaveBeenCalled();
  });
});
