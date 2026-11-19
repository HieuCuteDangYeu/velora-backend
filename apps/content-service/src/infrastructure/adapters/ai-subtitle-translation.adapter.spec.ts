import type { TranslateSubtitleCuesRequest } from '@common/ai/interfaces/subtitle-translation.interface';
import { SUBTITLE_TRANSLATION_MAX_CUES } from '@common/ai/interfaces/subtitle-translation.interface';
import type { ClientProxy } from '@nestjs/microservices';
import { of, throwError } from 'rxjs';
import {
  AiSubtitleTranslationAdapter,
  SUBTITLE_TRANSLATION_CHUNK_CUES,
} from './ai-subtitle-translation.adapter';

const request = (count: number): TranslateSubtitleCuesRequest => ({
  sourceLanguage: 'en',
  targetLanguage: 'vi',
  title: 'Talk',
  cues: Array.from({ length: count }, (_, index) => ({
    index: index * 2, // not contiguous: original cue numbers must survive
    text: `line ${index}`,
  })),
});

// Echoes every line back, as the AI service does, refusing what it refuses.
const echoingSend = () =>
  jest.fn((_pattern: string, payload: TranslateSubtitleCuesRequest) =>
    payload.cues.length > SUBTITLE_TRANSLATION_MAX_CUES
      ? throwError(() => ({
          statusCode: 400,
          message: `Expected between 1 and ${SUBTITLE_TRANSLATION_MAX_CUES} subtitle lines`,
        }))
      : of({
          cues: payload.cues.map((cue) => ({
            index: cue.index,
            text: `vi ${cue.text}`,
          })),
          model: 'test-model',
        }),
  );

const build = (send: jest.Mock) =>
  new AiSubtitleTranslationAdapter({ send } as unknown as ClientProxy);

describe('AiSubtitleTranslationAdapter', () => {
  it('keeps chunks under the AI service limit', () => {
    expect(SUBTITLE_TRANSLATION_CHUNK_CUES).toBeLessThanOrEqual(
      SUBTITLE_TRANSLATION_MAX_CUES,
    );
  });

  it('sends a short reel as a single request', async () => {
    const send = echoingSend();

    const result = await build(send).translate(request(40));

    expect(send).toHaveBeenCalledTimes(1);
    expect(result.cues).toHaveLength(40);
    expect(result.model).toBe('test-model');
  });

  it('translates a transcript longer than the AI limit in ordered chunks', async () => {
    const send = echoingSend();
    const lines = SUBTITLE_TRANSLATION_MAX_CUES * 3 + 7;

    const result = await build(send).translate(request(lines));

    const sizes = send.mock.calls.map(([, payload]) => payload.cues.length);
    expect(Math.max(...sizes)).toBeLessThanOrEqual(
      SUBTITLE_TRANSLATION_CHUNK_CUES,
    );
    expect(sizes.reduce((a, b) => a + b, 0)).toBe(lines);
    expect(result.cues).toHaveLength(lines);
    expect(result.cues.map((cue) => cue.index)).toEqual(
      request(lines).cues.map((cue) => cue.index),
    );
    expect(result.cues[lines - 1].text).toBe(`vi line ${lines - 1}`);
    for (const [, payload] of send.mock.calls) {
      expect(payload).toMatchObject({
        sourceLanguage: 'en',
        targetLanguage: 'vi',
        title: 'Talk',
      });
    }
  });

  it('stops at the first chunk that fails and reports the AI error', async () => {
    const send = jest
      .fn()
      .mockReturnValueOnce(of({ cues: [], model: 'm' }))
      .mockReturnValueOnce(
        throwError(() => ({ statusCode: 500, message: 'model down' })),
      );

    await expect(
      build(send).translate(request(SUBTITLE_TRANSLATION_CHUNK_CUES * 4)),
    ).rejects.toThrow('AI service error [500]: model down');
    expect(send).toHaveBeenCalledTimes(2);
  });
});
