import { RpcException } from '@nestjs/microservices';
import {
  InvalidSubtitleLanguageError,
  SubtitlesUnavailableError,
} from '@content/application/use-cases/get-reel-subtitles.use-case';
import { ReelSubtitlesController } from './reel-subtitles.controller';

const build = (execute: jest.Mock, preTranslate: jest.Mock = jest.fn()) =>
  new ReelSubtitlesController(
    { execute } as never,
    { execute: preTranslate } as never,
  );

const payload = { reelId: 'r1', viewerId: 'u1', language: 'vi' };

const statusOf = async (promise: Promise<unknown>) => {
  try {
    await promise;
  } catch (error) {
    return (error as RpcException).getError();
  }
  throw new Error('expected rejection');
};

describe('ReelSubtitlesController', () => {
  it('passes the viewer and the parsed language to the use case', async () => {
    const execute = jest.fn().mockResolvedValue({ cues: [] });
    await build(execute).getSubtitles({ ...payload, isAdmin: true });
    expect(execute).toHaveBeenCalledWith({
      reelId: 'r1',
      viewerId: 'u1',
      isAdmin: true,
      language: 'vi',
    });
  });

  it('defaults to the original language', async () => {
    const execute = jest.fn().mockResolvedValue({ cues: [] });
    await build(execute).getSubtitles({ reelId: 'r1', viewerId: 'u1' });
    expect(execute.mock.calls[0][0].language).toBe('original');
  });

  it.each([
    ['malformed payload', undefined, jest.fn()],
    [
      'a language that is not offered',
      { ...payload, language: 'fr' },
      jest.fn(),
    ],
  ])('answers 400 for %s', async (_name, data, execute) => {
    execute.mockRejectedValue(new InvalidSubtitleLanguageError('bad'));
    await expect(
      statusOf(build(execute).getSubtitles(data)),
    ).resolves.toMatchObject({ statusCode: 400 });
  });

  it('answers 404 when the reel is hidden from the viewer', async () => {
    await expect(
      statusOf(build(jest.fn().mockResolvedValue(null)).getSubtitles(payload)),
    ).resolves.toMatchObject({ statusCode: 404, message: 'Reel not found' });
  });

  it('answers 404 when the reel has no transcript', async () => {
    const execute = jest
      .fn()
      .mockRejectedValue(new SubtitlesUnavailableError('no transcript'));
    await expect(
      statusOf(build(execute).getSubtitles(payload)),
    ).resolves.toMatchObject({ statusCode: 404, message: 'no transcript' });
  });

  it('answers 502 when the translation fails', async () => {
    const execute = jest.fn().mockRejectedValue(new Error('model down'));
    await expect(
      statusOf(build(execute).getSubtitles(payload)),
    ).resolves.toMatchObject({
      statusCode: 502,
      message: 'Subtitles could not be prepared: model down',
    });
  });

  describe('preTranslate', () => {
    it('hands the reel to the pre-translation use case and returns its result', async () => {
      const result = { translated: ['vi'], alreadyStored: ['en'], failed: [] };
      const preTranslate = jest.fn().mockResolvedValue(result);
      await expect(
        build(jest.fn(), preTranslate).preTranslate({ reelId: ' r1 ' }),
      ).resolves.toEqual(result);
      expect(preTranslate).toHaveBeenCalledWith('r1');
    });

    it.each([undefined, {}, { reelId: '' }, { reelId: 'r1', extra: true }])(
      'answers 400 for %p',
      async (data) => {
        const preTranslate = jest.fn();
        expect(
          await statusOf(build(jest.fn(), preTranslate).preTranslate(data)),
        ).toMatchObject({ statusCode: 400 });
        expect(preTranslate).not.toHaveBeenCalled();
      },
    );
  });
});
