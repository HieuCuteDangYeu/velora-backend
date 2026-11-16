import { SelectReelEncodingProfileUseCase } from './select-reel-encoding-profile.use-case';

describe('SelectReelEncodingProfileUseCase crop mode', () => {
  it('uses the portrait ladder constrained by cropped source resolution', () => {
    const useCase = new SelectReelEncodingProfileUseCase({
      get: jest.fn(() => undefined),
    } as never);

    const profile = useCase.execute(
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

    expect(profile.crop).toEqual({ x: 652, y: 0, width: 616, height: 1080 });
    expect(profile.variants).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: '360p', width: 360, height: 640 }),
        expect.objectContaining({ name: '540p', width: 540, height: 960 }),
      ]),
    );
    expect(profile.variants.every((item) => item.height > item.width)).toBe(
      true,
    );
  });

  it('uses trimmed output duration for HLS workload classification and timeout', () => {
    const useCase = new SelectReelEncodingProfileUseCase({
      get: jest.fn(() => undefined),
    } as never);

    const profile = useCase.execute(
      {
        width: 1920,
        height: 1080,
        durationMs: 300_000,
        fps: 30,
        hasAudio: true,
      },
      { framing: 'fit' },
      4_000,
      { sourceStartMs: 2_000, sourceEndMs: 6_000, outputDurationMs: 4_000 },
    );

    expect(profile.segmentSeconds).toBe(2);
    expect(profile.timeoutMs).toBe(312_000);
    expect(profile.trim).toEqual({
      sourceStartMs: 2_000,
      sourceEndMs: 6_000,
      outputDurationMs: 4_000,
    });
  });
});

describe('SelectReelEncodingProfileUseCase x264 preset', () => {
  const source = {
    width: 1080,
    height: 1920,
    durationMs: 60_000,
    fps: 30,
    hasAudio: true,
  };
  const build = (preset?: string) =>
    new SelectReelEncodingProfileUseCase({
      get: jest.fn((key: string) =>
        key === 'MEDIA_HLS_X264_PRESET' ? preset : undefined,
      ),
    } as never);

  it('defaults to veryfast', () => {
    expect(build().execute(source).x264Preset).toBe('veryfast');
  });

  it('honours MEDIA_HLS_X264_PRESET', () => {
    expect(build(' faster ').execute(source).x264Preset).toBe('faster');
  });
});
