import { InvalidMediaFileError } from '@content/domain/errors/content.error';
import { ReprocessReelUseCase } from './reprocess-reel.use-case';

const buildReel = (mediaKey: string) => ({
  id: 'reel-1',
  userId: 'user-1',
  mediaKey,
  status: 'FAILED',
  mediaEdit: undefined,
  tags: [],
  createdAt: new Date(Date.now() - 60 * 60 * 1000),
  updatedAt: new Date(Date.now() - 60 * 60 * 1000),
});

const buildUseCase = (mediaKey: string) => {
  const findById = jest.fn().mockResolvedValue(buildReel(mediaKey));
  const checkFileExists = jest.fn().mockResolvedValue(true);
  const execute = jest.fn().mockReturnValue({
    jobId: 'job-1',
    createdAt: new Date().toISOString(),
  });
  const queueReelProcessingAttemptWithMediaJob = jest
    .fn()
    .mockResolvedValue(buildReel(mediaKey));
  const trigger = jest.fn();

  return {
    useCase: new ReprocessReelUseCase(
      { findById, queueReelProcessingAttemptWithMediaJob } as never,
      { checkFileExists } as never,
      { trigger },
      { execute } as never,
    ),
    findById,
    checkFileExists,
    execute,
    queueReelProcessingAttemptWithMediaJob,
    trigger,
  };
};

describe('ReprocessReelUseCase media-key compatibility', () => {
  it.each([
    'chat-videos/user-1/source.quicktime',
    'chat-videos/user-1/source.webm',
    'reels/user-1/source.mp4',
  ])('queues an owned source key: %s', async (mediaKey) => {
    const harness = buildUseCase(mediaKey);

    await expect(harness.useCase.execute('reel-1', 'user-1')).resolves.toEqual(
      expect.objectContaining({ mediaKey }),
    );

    expect(harness.checkFileExists).toHaveBeenCalledWith(mediaKey);
    expect(harness.execute).toHaveBeenCalledWith(
      expect.objectContaining({ mediaKey }),
    );
    expect(harness.queueReelProcessingAttemptWithMediaJob).toHaveBeenCalled();
    expect(harness.trigger).toHaveBeenCalledTimes(1);
  });

  it.each([
    'chat-videos/user-2/source.mp4',
    'chat-videos/user-1/../user-2/source.mp4',
    'chat-videos/user-1\\source.mp4',
  ])('rejects an unsafe or foreign source key: %s', async (mediaKey) => {
    const harness = buildUseCase(mediaKey);

    await expect(
      harness.useCase.execute('reel-1', 'user-1'),
    ).rejects.toBeInstanceOf(InvalidMediaFileError);
    expect(harness.checkFileExists).not.toHaveBeenCalled();
    expect(
      harness.queueReelProcessingAttemptWithMediaJob,
    ).not.toHaveBeenCalled();
  });
});
