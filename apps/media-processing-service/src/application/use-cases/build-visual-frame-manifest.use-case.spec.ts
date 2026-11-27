import { BuildVisualFrameManifestUseCase } from './build-visual-frame-manifest.use-case';

describe('BuildVisualFrameManifestUseCase crop propagation', () => {
  it('passes the canonical crop rectangle to visual frame extraction', async () => {
    const extractCandidateFrames = jest.fn().mockResolvedValue([]);
    const useCase = new BuildVisualFrameManifestUseCase(
      { get: jest.fn(() => undefined) } as never,
      { extractCandidateFrames },
      {
        uploadTextObject: jest
          .fn()
          .mockResolvedValue({ key: 'manifest.json', checksum: 'sha256' }),
      } as never,
      { getFileChecksum: jest.fn() } as never,
    );
    const crop = { x: 320, y: 0, width: 608, height: 1080 };

    await useCase.execute({
      reelId: 'reel-1',
      mediaAttemptId: 'attempt-1',
      inputPath: '/tmp/source.mp4',
      outputDir: '/tmp/visual-frames',
      storagePrefix: 'uploads/source',
      metadata: { durationMs: 10_000 },
      crop,
    });

    expect(extractCandidateFrames).toHaveBeenCalledWith(
      expect.objectContaining({ crop }),
    );
  });
});

describe('BuildVisualFrameManifestUseCase frame budget', () => {
  const run = async (durationMs: number, env: Record<string, string> = {}) => {
    const candidates = Array.from({ length: 400 }, (_, index) => ({
      timestampMs: index * 10_000,
      outputPath: `/tmp/frame-${index}.jpg`,
      reason: 'PERIODIC',
    }));
    const uploadArtifact = jest
      .fn()
      .mockImplementation((_path: string, key: string) =>
        Promise.resolve({ key, byteLength: 1 }),
      );
    const useCase = new BuildVisualFrameManifestUseCase(
      { get: jest.fn((key: string) => env[key]) } as never,
      { extractCandidateFrames: jest.fn().mockResolvedValue(candidates) },
      {
        uploadArtifact,
        uploadTextObject: jest
          .fn()
          .mockResolvedValue({ key: 'manifest.json', checksum: 'sha256' }),
      } as never,
      { getFileChecksum: jest.fn().mockResolvedValue('sha') } as never,
    );
    const result = await useCase.execute({
      reelId: 'reel-1',
      mediaAttemptId: 'attempt-1',
      inputPath: '/tmp/source.mp4',
      outputDir: '/tmp/visual-frames',
      storagePrefix: 'uploads/source',
      metadata: { durationMs },
    });
    return result.manifest.artifacts.length;
  };

  it('keeps 24 frames for a short video', async () => {
    await expect(run(10 * 60_000)).resolves.toBe(24);
  });

  it('takes about one frame a minute for a long video, up to 120', async () => {
    await expect(run(60 * 60_000)).resolves.toBe(60);
    await expect(run(180 * 60_000)).resolves.toBe(120);
  });

  it('can be turned back to a flat cap', async () => {
    await expect(
      run(60 * 60_000, { MEDIA_VISUAL_FRAMES_PER_MINUTE: '0' }),
    ).resolves.toBe(24);
  });
});
