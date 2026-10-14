import { InvalidMediaFileError } from '@content/domain/errors/content.error';
import { EnrichReelFromExistingHlsUseCase } from './enrich-reel-from-existing-hls.use-case';

const buildReel = (mediaKey: string, hlsMasterKey: string) => ({
  id: 'reel-1',
  userId: 'user-1',
  mediaKey,
  hlsMasterKey,
  mediaStatus: 'COMPLETED',
  transcriptionAudioManifestKey: undefined,
  visualFrameManifestKey: undefined,
  sourceOrientation: undefined,
  sourceLengthClass: undefined,
  mediaOutput: undefined,
  sourceDurationMs: 10_000,
  outputDurationMs: 10_000,
  createdAt: new Date(Date.now() - 60 * 60 * 1000),
  updatedAt: new Date(Date.now() - 60 * 60 * 1000),
});

const buildUseCase = (mediaKey: string, hlsMasterKey: string) => {
  const findById = jest
    .fn()
    .mockResolvedValue(buildReel(mediaKey, hlsMasterKey));
  const checkFileExists = jest.fn().mockResolvedValue(true);
  const execute = jest.fn().mockReturnValue({
    jobId: 'job-1',
    createdAt: new Date().toISOString(),
  });
  const queueReelProcessingAttemptWithMediaJob = jest
    .fn()
    .mockResolvedValue(undefined);
  const trigger = jest.fn();

  return {
    findById,
    useCase: new EnrichReelFromExistingHlsUseCase(
      { findById, queueReelProcessingAttemptWithMediaJob } as never,
      { checkFileExists } as never,
      { trigger },
      { execute } as never,
    ),
    checkFileExists,
    execute,
    queueReelProcessingAttemptWithMediaJob,
    trigger,
  };
};

describe('EnrichReelFromExistingHlsUseCase media-key compatibility', () => {
  it('does not promote failed media from a master-only existence check', async () => {
    const harness = buildUseCase(
      'reels/user-1/source.mp4',
      'reels/user-1/source/master.m3u8',
    );
    harness.findById.mockResolvedValue({
      ...buildReel(
        'reels/user-1/source.mp4',
        'reels/user-1/source/master.m3u8',
      ),
      mediaStatus: 'FAILED',
    });
    await expect(harness.useCase.execute('reel-1')).rejects.toBeInstanceOf(
      InvalidMediaFileError,
    );
    expect(
      harness.queueReelProcessingAttemptWithMediaJob,
    ).not.toHaveBeenCalled();
  });
  it.each([
    {
      mediaKey: 'chat-videos/user-1/source.webm',
      hlsMasterKey: 'chat-videos/user-1/source/master.m3u8',
    },
    {
      mediaKey: 'reels/user-1/source.mp4',
      hlsMasterKey: 'reels/user-1/source/master.m3u8',
    },
  ])('queues owned source and HLS keys', async ({ mediaKey, hlsMasterKey }) => {
    const harness = buildUseCase(mediaKey, hlsMasterKey);

    await expect(harness.useCase.execute('reel-1')).resolves.toEqual({
      queued: true,
      mediaAttemptId: expect.any(String),
      indexAttemptId: expect.any(String),
    });

    expect(harness.checkFileExists).toHaveBeenCalledWith(hlsMasterKey);
    expect(harness.execute).toHaveBeenCalledWith(
      expect.objectContaining({ mediaKey }),
    );
    expect(harness.queueReelProcessingAttemptWithMediaJob).toHaveBeenCalled();
    expect(harness.trigger).toHaveBeenCalledTimes(1);
  });

  it.each([
    {
      mediaKey: 'chat-videos/user-2/source.mp4',
      hlsMasterKey: 'chat-videos/user-1/source/master.m3u8',
    },
    {
      mediaKey: 'chat-videos/user-1/source.mp4',
      hlsMasterKey: 'chat-videos/user-1/../user-2/master.m3u8',
    },
    {
      mediaKey: 'chat-videos/user-1\\source.mp4',
      hlsMasterKey: 'chat-videos/user-1/source/master.m3u8',
    },
  ])('rejects unsafe or foreign source/HLS keys', async (keys) => {
    const harness = buildUseCase(keys.mediaKey, keys.hlsMasterKey);

    await expect(harness.useCase.execute('reel-1')).rejects.toBeInstanceOf(
      InvalidMediaFileError,
    );
    expect(harness.checkFileExists).not.toHaveBeenCalled();
    expect(
      harness.queueReelProcessingAttemptWithMediaJob,
    ).not.toHaveBeenCalled();
  });
  it('enriches trusted imported HLS using only its stored master, never the external original', async () => {
    const id = '12345678-1234-1234-1234-123456789abc';
    const hlsMasterKey = `reels/${id}/master.m3u8`;
    const harness = buildUseCase(
      'https://external.example/original.mp4',
      hlsMasterKey,
    );
    harness.findById.mockResolvedValue({
      ...buildReel('https://external.example/original.mp4', hlsMasterKey),
      id,
    });
    await expect(harness.useCase.execute(id)).resolves.toEqual(
      expect.objectContaining({ queued: true }),
    );
    expect(harness.execute).toHaveBeenCalledWith(
      expect.objectContaining({ mediaKey: hlsMasterKey }),
    );
    expect(harness.checkFileExists).toHaveBeenCalledWith(hlsMasterKey);
  });
});
