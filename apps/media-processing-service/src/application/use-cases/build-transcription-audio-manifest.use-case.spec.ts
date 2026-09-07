import { BuildTranscriptionAudioManifestUseCase } from './build-transcription-audio-manifest.use-case';

describe('BuildTranscriptionAudioManifestUseCase trim propagation', () => {
  it('extracts source-offset audio but publishes output-relative timestamps', async () => {
    const extractTranscriptionAudioSegments = jest.fn().mockResolvedValue([
      {
        outputPath: '/tmp/audio_000000.wav',
        startMs: 5000,
        endMs: 9000,
        overlapBeforeMs: 0,
        byteLength: 12,
      },
    ]);
    const useCase = new BuildTranscriptionAudioManifestUseCase(
      { get: jest.fn(() => undefined) } as never,
      { extractTranscriptionAudioSegments } as never,
      {
        uploadArtifact: jest
          .fn()
          .mockResolvedValue({ key: 'audio.wav', byteLength: 12 }),
        uploadTextObject: jest
          .fn()
          .mockResolvedValue({ key: 'manifest.json', checksum: 'sha256' }),
      } as never,
      {
        getFileChecksum: jest.fn().mockResolvedValue('audio-sha256'),
      } as never,
    );

    const result = await useCase.execute({
      reelId: 'reel-1',
      mediaAttemptId: 'attempt-1',
      inputPath: '/tmp/source.mp4',
      outputDir: '/tmp/audio',
      storagePrefix: 'uploads/source',
      metadata: { durationMs: 10_000, hasAudio: true },
      trim: {
        sourceStartMs: 5000,
        sourceEndMs: 9000,
        outputDurationMs: 4000,
      },
    });

    expect(extractTranscriptionAudioSegments).toHaveBeenCalledWith(
      '/tmp/source.mp4',
      [
        expect.objectContaining({
          startMs: 5000,
          endMs: 9000,
        }),
      ],
      'wav',
    );
    expect(result.manifest.totalDurationMs).toBe(4000);
    expect(result.manifest.artifacts[0]).toMatchObject({
      startMs: 0,
      endMs: 4000,
      overlapBeforeMs: 0,
    });
  });
});
