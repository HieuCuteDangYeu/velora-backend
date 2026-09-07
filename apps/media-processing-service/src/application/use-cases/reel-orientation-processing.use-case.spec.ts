import { ClassifyReelMediaUseCase } from '@processing/application/use-cases/classify-reel-media.use-case';
import { SelectReelEncodingProfileUseCase } from '@processing/application/use-cases/select-reel-encoding-profile.use-case';

const config = {
  get: jest.fn(() => undefined),
};

const classify = new ClassifyReelMediaUseCase(config as never);
const selectProfile = new SelectReelEncodingProfileUseCase(config as never);

describe('reel orientation processing', () => {
  beforeEach(() => {
    config.get.mockClear();
  });

  it('keeps portrait sources portrait through classification and HLS profile selection', () => {
    const metadata = {
      width: 1080,
      height: 1920,
      durationMs: 60_000,
      fps: 30,
      hasAudio: true,
    };

    expect(classify.execute(metadata)).toMatchObject({
      orientation: 'PORTRAIT',
      mediaClass: 'SHORT',
      effectiveWidth: 1080,
      effectiveHeight: 1920,
      aspectRatio: 0.5625,
    });

    expect(selectProfile.execute(metadata).variants).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: '360p', width: 360, height: 640 }),
        expect.objectContaining({ name: '540p', width: 540, height: 960 }),
        expect.objectContaining({ name: '720p', width: 720, height: 1280 }),
      ]),
    );
  });

  it('keeps landscape sources landscape through classification and HLS profile selection', () => {
    const metadata = {
      width: 1920,
      height: 1080,
      durationMs: 60_000,
      fps: 30,
      hasAudio: true,
    };

    expect(classify.execute(metadata)).toMatchObject({
      orientation: 'LANDSCAPE',
      mediaClass: 'SHORT',
      effectiveWidth: 1920,
      effectiveHeight: 1080,
      aspectRatio: 1.7778,
    });

    expect(selectProfile.execute(metadata).variants).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: '360p', width: 640, height: 360 }),
        expect.objectContaining({ name: '540p', width: 960, height: 540 }),
        expect.objectContaining({ name: '720p', width: 1280, height: 720 }),
      ]),
    );
  });

  it('preserves square sources with square HLS variants', () => {
    const metadata = {
      width: 1080,
      height: 1080,
      durationMs: 60_000,
      fps: 30,
      hasAudio: false,
    };

    expect(classify.execute(metadata)).toMatchObject({
      orientation: 'SQUARE',
      mediaClass: 'SHORT',
      effectiveWidth: 1080,
      effectiveHeight: 1080,
      aspectRatio: 1,
    });

    expect(selectProfile.execute(metadata).variants).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: '360p', width: 360, height: 360 }),
        expect.objectContaining({ name: '540p', width: 540, height: 540 }),
        expect.objectContaining({ name: '720p', width: 720, height: 720 }),
      ]),
    );
  });

  it('uses rotation-aware effective dimensions before deciding orientation', () => {
    const metadata = {
      width: 1920,
      height: 1080,
      rotation: 90,
      durationMs: 60_000,
      fps: 30,
      hasAudio: true,
    };

    expect(classify.execute(metadata)).toMatchObject({
      orientation: 'PORTRAIT',
      effectiveWidth: 1080,
      effectiveHeight: 1920,
      aspectRatio: 0.5625,
    });

    expect(selectProfile.execute(metadata).variants[0]).toMatchObject({
      width: 360,
      height: 640,
    });
  });

  it('forces the portrait ladder for a landscape source with crop framing', () => {
    const profile = selectProfile.execute(
      {
        width: 1920,
        height: 1080,
        durationMs: 60_000,
        fps: 30,
        hasAudio: true,
      },
      {
        framing: 'crop',
        crop: {
          version: 1,
          x: 0.34,
          y: 0,
          width: 0.32,
          height: 1,
          aspectRatio: '9:16',
        },
      },
    );

    expect(profile.variants[0]).toMatchObject({ width: 360, height: 640 });
    expect(
      profile.variants.every((variant) => variant.height > variant.width),
    ).toBe(true);
  });
});
