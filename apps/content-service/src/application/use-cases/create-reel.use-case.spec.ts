import { CreateReelUseCase } from './create-reel.use-case';
import { fingerprintCreateReelRequest } from '@common/content/publish-request-fingerprint';
import { ClassifyReelJobLengthUseCase } from './classify-reel-job-length.use-case';
import { BuildReelMediaJobUseCase } from './build-reel-media-job.use-case';
import {
  InvalidMediaFileError,
  ReelPublishIntentConflictError,
} from '@content/domain/errors/content.error';

const publishIntentId = '11111111-1111-4111-8111-111111111111';
const payload = {
  publishIntentId,
  mediaKey: 'reels/user-1/source.mp4',
  title: 'Title',
  description: 'Description',
  tags: ['tag'],
  visibility: 'private' as const,
};

const buildJob = () =>
  new BuildReelMediaJobUseCase(
    new ClassifyReelJobLengthUseCase({
      get: jest.fn(() => undefined),
    } as never),
  );

const existingReel = {
  id: 'reel-1',
  userId: 'user-1',
  publishIntentId,
  mediaKey: payload.mediaKey,
  title: payload.title,
  description: payload.description,
  tags: payload.tags,
  visibility: payload.visibility,
  mediaEdit: undefined,
  publishRequestFingerprint: fingerprintCreateReelRequest(payload),
};

describe('CreateReelUseCase publish idempotency', () => {
  it.each([
    'chat-videos/user-1/source.quicktime',
    'chat-videos/user-1/source.webm',
    'reels/user-1/source.mp4',
  ])('creates a Reel from an owned source key: %s', async (mediaKey) => {
    const checkFileExists = jest.fn().mockResolvedValue(true);
    const createReelWithMediaJob = jest.fn().mockResolvedValue({
      ...existingReel,
      mediaKey,
    });
    const useCase = new CreateReelUseCase(
      {
        findByPublishIntentId: jest.fn().mockResolvedValue(null),
        createReelWithMediaJob,
      } as never,
      { checkFileExists } as never,
      { trigger: jest.fn() },
      buildJob(),
    );

    await expect(
      useCase.execute('user-1', { ...payload, mediaKey }),
    ).resolves.toEqual(expect.objectContaining({ mediaKey }));

    expect(checkFileExists).toHaveBeenCalledWith(mediaKey);
    expect(createReelWithMediaJob).toHaveBeenCalledWith(
      expect.objectContaining({ mediaKey }),
      expect.any(Object),
    );
  });

  it('replays the canonical Reel without storage or a second outbox write', async () => {
    const findByPublishIntentId = jest.fn().mockResolvedValue(existingReel);
    const createReelWithMediaJob = jest.fn();
    const checkFileExists = jest.fn();
    const trigger = jest.fn();
    const useCase = new CreateReelUseCase(
      { findByPublishIntentId, createReelWithMediaJob } as never,
      { checkFileExists } as never,
      { trigger },
      buildJob(),
    );

    await expect(useCase.execute('user-1', payload)).resolves.toBe(
      existingReel,
    );
    expect(checkFileExists).not.toHaveBeenCalled();
    expect(createReelWithMediaJob).not.toHaveBeenCalled();
    expect(trigger).not.toHaveBeenCalled();
  });

  it('rejects reuse of an intent with a different payload', async () => {
    const useCase = new CreateReelUseCase(
      {
        findByPublishIntentId: jest.fn().mockResolvedValue(existingReel),
      } as never,
      {} as never,
      { trigger: jest.fn() },
      buildJob(),
    );

    await expect(
      useCase.execute('user-1', {
        ...payload,
        mediaKey: 'reels/user-1/other.mp4',
      }),
    ).rejects.toBeInstanceOf(ReelPublishIntentConflictError);
  });

  it('replays the current canonical Reel after mutable content edits', async () => {
    const edited = {
      ...existingReel,
      title: 'Edited after publishing',
      visibility: 'public' as const,
    };
    const useCase = new CreateReelUseCase(
      {
        findByPublishIntentId: jest.fn().mockResolvedValue(edited),
      } as never,
      { checkFileExists: jest.fn() } as never,
      { trigger: jest.fn() },
      buildJob(),
    );

    await expect(useCase.execute('user-1', payload)).resolves.toBe(edited);
  });

  it('reconciles a unique conflict after the winning transaction commits', async () => {
    const createReelWithMediaJob = jest
      .fn()
      .mockRejectedValue(Object.assign(new Error('unique'), { code: 'P2002' }));
    const findByPublishIntentId = jest
      .fn()
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(existingReel);
    const useCase = new CreateReelUseCase(
      { findByPublishIntentId, createReelWithMediaJob } as never,
      { checkFileExists: jest.fn().mockResolvedValue(true) } as never,
      { trigger: jest.fn() },
      buildJob(),
    );

    await expect(useCase.execute('user-1', payload)).resolves.toBe(
      existingReel,
    );
    expect(findByPublishIntentId).toHaveBeenCalledTimes(2);
  });

  it("does not let a user publish another user's media key", async () => {
    const useCase = new CreateReelUseCase(
      { findByPublishIntentId: jest.fn().mockResolvedValue(null) } as never,
      { checkFileExists: jest.fn() } as never,
      { trigger: jest.fn() },
      buildJob(),
    );

    await expect(
      useCase.execute('user-1', {
        ...payload,
        mediaKey: 'reels/user-2/source.mp4',
      }),
    ).rejects.toBeInstanceOf(InvalidMediaFileError);
  });

  it('rejects traversal-like media keys at the ownership boundary', async () => {
    const useCase = new CreateReelUseCase(
      { findByPublishIntentId: jest.fn().mockResolvedValue(null) } as never,
      { checkFileExists: jest.fn() } as never,
      { trigger: jest.fn() },
      buildJob(),
    );

    await expect(
      useCase.execute('user-1', {
        ...payload,
        mediaKey: 'reels/user-1/../user-2/source.mp4',
      }),
    ).rejects.toBeInstanceOf(InvalidMediaFileError);
  });
});
