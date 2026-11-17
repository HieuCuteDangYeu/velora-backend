import { ProcessReelUseCase } from './process-reel.use-case';

const mediaOutput = {
  hlsMasterKey: 'reels/user-1/attempt-1/master.m3u8',
  thumbnailKey: 'reels/user-1/attempt-1/thumbnail.jpg',
  sourceHasAudio: true,
  sourceLengthClass: 'SHORT' as const,
  variants: [],
  hlsObjectCount: 2,
  hlsTotalBytes: 10,
  checksums: {
    sourceSha256: 'source',
    hlsMasterSha256: 'hls',
    thumbnailSha256: 'thumbnail',
  },
};

const workspace = {
  workDir: '/tmp/reel',
  inputPath: '/tmp/reel/input.mp4',
  hlsOutputDir: '/tmp/reel/hls',
  audioOutputDir: '/tmp/reel/audio',
  thumbnailPath: '/tmp/reel/thumbnail.jpg',
};

const metrics = {
  record: jest.fn(),
  startStage: jest.fn(() => ({
    succeed: jest.fn(),
    fail: jest.fn(),
  })),
  estimatePayloadBytes: jest.fn(() => 100),
};

const makeUseCase = (
  overrides: Record<string, unknown> = {},
  config: Record<string, string> = {},
) => {
  const contentService = {
    claimReelProcessingAttempt: jest.fn().mockResolvedValue(true),
    persistMediaCompleted: jest.fn().mockResolvedValue(true),
    persistExistingHlsEvidence: jest.fn().mockResolvedValue(true),
    emitProcessingStarted: jest.fn().mockResolvedValue(undefined),
    emitProcessingProgress: jest.fn().mockResolvedValue(undefined),
    emitProcessingFailed: jest.fn().mockResolvedValue(undefined),
    persistProcessingRetryScheduled: jest.fn().mockResolvedValue(undefined),
  };
  const prepareReelMediaUseCase = {
    execute: jest.fn().mockResolvedValue({
      mediaMetadata: {
        sourceDurationMs: 100_000,
        outputDurationMs: 100_000,
        sourceOrientation: 'PORTRAIT',
        sourceLengthClass: 'SHORT',
      },
      mediaOutput,
    }),
  };
  const evidenceResult = {
    mediaMetadata: {
      sourceDurationMs: 100_000,
      outputDurationMs: 100_000,
      sourceHasAudio: true,
      sourceOrientation: 'PORTRAIT',
      sourceLengthClass: 'SHORT',
    },
    transcriptionAudioManifestKey:
      'reels/user-1/attempt-1/transcription/attempt-1/manifest.json',
  };
  const prepareExistingHlsEvidenceUseCase = {
    execute: jest.fn().mockResolvedValue(evidenceResult),
    executeFromLocalMedia: jest.fn().mockResolvedValue(evidenceResult),
  };
  const buildVisualFrameManifestUseCase = {
    execute: jest.fn().mockResolvedValue({
      manifest: { artifacts: [] },
      manifestKey: 'reels/user-1/attempt-1/visual/attempt-1/manifest.json',
      manifestChecksum: 'visual',
      totalFrameBytes: 0,
    }),
  };
  const tempFileService = {
    createReelProcessingWorkspace: jest.fn(() => workspace),
    removeDirIfExists: jest.fn(),
  };
  const instance = new ProcessReelUseCase(
    { get: jest.fn((key: string) => config[key]) } as never,
    prepareReelMediaUseCase as never,
    prepareExistingHlsEvidenceUseCase as never,
    buildVisualFrameManifestUseCase as never,
    contentService,
    tempFileService as never,
    {
      runExclusive: jest.fn((callback: () => Promise<unknown>) => callback()),
    } as never,
    metrics,
  );

  return {
    instance,
    contentService,
    prepareReelMediaUseCase,
    prepareExistingHlsEvidenceUseCase,
    buildVisualFrameManifestUseCase,
    ...overrides,
  };
};

describe('ProcessReelUseCase readiness split', () => {
  it('persists playable media before audio and visual evidence work', async () => {
    const fakes = makeUseCase();

    await expect(
      fakes.instance.execute({
        reelId: 'reel-1',
        mediaKey: 'reels/user-1/source.mp4',
        userId: 'user-1',
        processingAttemptId: 'attempt-1',
        expectedLengthClass: 'SHORT',
      }),
    ).resolves.toEqual({ status: 'COMPLETED' });

    expect(
      fakes.contentService.claimReelProcessingAttempt,
    ).toHaveBeenCalledWith(expect.objectContaining({ evidenceOnly: false }));
    expect(fakes.contentService.persistMediaCompleted).toHaveBeenCalledWith(
      expect.objectContaining({ mediaOutput }),
    );
    expect(
      fakes.prepareExistingHlsEvidenceUseCase.execute,
    ).not.toHaveBeenCalled();
    expect(
      fakes.buildVisualFrameManifestUseCase.execute,
    ).not.toHaveBeenCalled();
  });

  it('runs existing-HLS evidence with the same attempt fence after media is ready', async () => {
    const fakes = makeUseCase();

    await expect(
      fakes.instance.execute({
        reelId: 'reel-1',
        mediaKey: 'reels/user-1/source.mp4',
        userId: 'user-1',
        processingAttemptId: 'attempt-1',
        sourceMode: 'EXISTING_HLS',
        hlsMasterKey: 'reels/user-1/attempt-1/master.m3u8',
        expectedLengthClass: 'SHORT',
      }),
    ).resolves.toEqual({ status: 'COMPLETED' });

    expect(
      fakes.contentService.claimReelProcessingAttempt,
    ).toHaveBeenCalledWith(expect.objectContaining({ evidenceOnly: true }));
    expect(
      fakes.contentService.persistExistingHlsEvidence,
    ).toHaveBeenCalledWith(
      expect.objectContaining({
        transcriptionAudioManifestKey:
          'reels/user-1/attempt-1/transcription/attempt-1/manifest.json',
      }),
    );
    expect(fakes.contentService.persistMediaCompleted).not.toHaveBeenCalled();
  });

  describe('evidence built next to the encode', () => {
    const run = (fakes: ReturnType<typeof makeUseCase>) =>
      fakes.instance.execute({
        reelId: 'reel-1',
        mediaKey: 'reels/user-1/source.mp4',
        userId: 'user-1',
        processingAttemptId: 'attempt-1',
        expectedLengthClass: 'SHORT',
      });

    const readyAfterEncode = (fakes: ReturnType<typeof makeUseCase>) =>
      fakes.prepareReelMediaUseCase.execute.mockImplementation(
        async (input: {
          inlineEvidence?: {
            onReady: (info: {
              hlsMasterKey: string;
              mediaMetadata: Record<string, unknown>;
            }) => void;
          };
        }) => {
          await Promise.resolve();
          input.inlineEvidence?.onReady({
            hlsMasterKey: 'reels/user-1/attempt-1/master.m3u8',
            mediaMetadata: {
              sourceDurationMs: 100_000,
              sourceOrientation: 'PORTRAIT',
              sourceLengthClass: 'SHORT',
            },
          });
          return {
            mediaMetadata: { sourceDurationMs: 100_000 },
            mediaOutput: { ...mediaOutput, evidenceInline: true },
          };
        },
      );

    it('reports the reel ready first, then hands over the evidence it built locally', async () => {
      const fakes = makeUseCase();
      readyAfterEncode(fakes);

      await expect(run(fakes)).resolves.toEqual({ status: 'COMPLETED' });

      const order = [
        fakes.contentService.persistMediaCompleted.mock.invocationCallOrder[0],
        fakes.contentService.persistExistingHlsEvidence.mock
          .invocationCallOrder[0],
      ];
      expect(order[0]).toBeLessThan(order[1]);
      expect(
        fakes.prepareExistingHlsEvidenceUseCase.executeFromLocalMedia,
      ).toHaveBeenCalledWith(
        expect.objectContaining({
          inputPath: '/tmp/reel/evidence-input.mp4',
          hlsMasterKey: 'reels/user-1/attempt-1/master.m3u8',
          preservedSourceDurationMs: 100_000,
        }),
      );
      expect(
        fakes.prepareExistingHlsEvidenceUseCase.execute,
      ).not.toHaveBeenCalled();
      expect(
        fakes.contentService.persistExistingHlsEvidence,
      ).toHaveBeenCalledWith(
        expect.objectContaining({
          processingAttemptId: 'attempt-1',
          visualFrameManifestKey:
            'reels/user-1/attempt-1/visual/attempt-1/manifest.json',
        }),
      );
    });

    it('still completes the job when the local evidence fails, leaving it to the evidence job', async () => {
      const fakes = makeUseCase();
      readyAfterEncode(fakes);
      fakes.prepareExistingHlsEvidenceUseCase.executeFromLocalMedia.mockRejectedValue(
        new Error('ffmpeg exploded'),
      );

      await expect(run(fakes)).resolves.toEqual({ status: 'COMPLETED' });

      expect(
        fakes.contentService.persistExistingHlsEvidence,
      ).not.toHaveBeenCalled();
      expect(fakes.contentService.emitProcessingFailed).not.toHaveBeenCalled();
      expect(
        fakes.contentService.persistProcessingRetryScheduled,
      ).not.toHaveBeenCalled();
    });

    it('does not ask for local media when MEDIA_INLINE_EVIDENCE is off', async () => {
      const fakes = makeUseCase({}, { MEDIA_INLINE_EVIDENCE: 'false' });

      await run(fakes);

      expect(
        fakes.prepareReelMediaUseCase.execute.mock.calls[0][0],
      ).not.toHaveProperty('inlineEvidence');
    });
  });
});
