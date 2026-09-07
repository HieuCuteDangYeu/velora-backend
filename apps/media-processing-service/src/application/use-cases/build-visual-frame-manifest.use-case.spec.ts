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
