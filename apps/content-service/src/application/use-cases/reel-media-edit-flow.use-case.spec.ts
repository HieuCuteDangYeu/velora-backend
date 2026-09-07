import type { ReelMediaEdit } from '@common/content/schemas/reel-edit.schema';
import { ClassifyReelJobLengthUseCase } from './classify-reel-job-length.use-case';
import { CreateReelUseCase } from './create-reel.use-case';
import { BuildReelMediaJobUseCase } from './build-reel-media-job.use-case';
import { ReprocessReelUseCase } from './reprocess-reel.use-case';

const edit: ReelMediaEdit = {
  framing: 'crop',
  trim: {
    version: 1,
    startMs: 5000,
    endMs: 35_000,
  },
  crop: {
    version: 1,
    x: 0.25,
    y: 0,
    width: 0.5,
    height: 1,
    aspectRatio: '9:16',
  },
};

const buildJob = () =>
  new BuildReelMediaJobUseCase(
    new ClassifyReelJobLengthUseCase({
      get: jest.fn(() => undefined),
    } as never),
  );

describe('Reel media edit flow', () => {
  it('persists the edit and writes the same edit into the atomic outbox payload', async () => {
    const createReelWithMediaJob = jest.fn().mockResolvedValue({});
    const useCase = new CreateReelUseCase(
      { createReelWithMediaJob } as never,
      { checkFileExists: jest.fn().mockResolvedValue(true) } as never,
      { trigger: jest.fn() },
      buildJob(),
    );

    await useCase.execute('user-1', {
      mediaKey: 'uploads/source.mp4',
      visibility: 'private',
      edit,
    });

    const [reel, outboxEvent] = createReelWithMediaJob.mock.calls[0];
    expect(reel.mediaEdit).toEqual(edit);
    expect(outboxEvent.payload.edit).toEqual(edit);
  });

  it('rebuilds a reprocess job with the persisted edit', async () => {
    const queueReelProcessingAttemptWithMediaJob = jest
      .fn()
      .mockResolvedValue({});
    const useCase = new ReprocessReelUseCase(
      {
        findById: jest.fn().mockResolvedValue({
          id: 'reel-1',
          userId: 'user-1',
          mediaKey: 'uploads/source.mp4',
          status: 'FAILED',
          mediaEdit: edit,
          tags: [],
          sourceDurationMs: 60_000,
          createdAt: new Date(),
          updatedAt: new Date(),
        }),
        queueReelProcessingAttemptWithMediaJob,
      } as never,
      { checkFileExists: jest.fn().mockResolvedValue(true) } as never,
      { trigger: jest.fn() },
      buildJob(),
    );

    await useCase.execute('reel-1', 'user-1');

    expect(
      queueReelProcessingAttemptWithMediaJob.mock.calls[0][3].payload.edit,
    ).toEqual(edit);
  });
});
