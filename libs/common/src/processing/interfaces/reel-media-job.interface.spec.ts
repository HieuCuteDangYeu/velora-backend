import { isReelMediaJob, type ReelMediaJob } from './reel-media-job.interface';

const baseJob: ReelMediaJob = {
  jobId: 'job-1',
  reelId: 'reel-1',
  userId: 'user-1',
  mediaKey: 'uploads/source.mp4',
  mediaAttemptId: 'attempt-1',
  expectedLengthClass: 'SHORT',
  tags: [],
  createdAt: '2026-09-07T00:00:00.000Z',
  schemaVersion: 1,
};

const cropEdit = {
  framing: 'crop' as const,
  crop: {
    version: 1 as const,
    x: 0.25,
    y: 0,
    width: 0.5,
    height: 1,
    aspectRatio: '9:16' as const,
  },
};

describe('isReelMediaJob', () => {
  it('accepts legacy jobs without edit metadata', () => {
    expect(isReelMediaJob(baseJob)).toBe(true);
  });

  it('accepts a valid crop job and preserves edit through retry serialization', () => {
    const job = { ...baseJob, edit: cropEdit };
    const retriedJob = JSON.parse(JSON.stringify(job)) as unknown;

    expect(isReelMediaJob(retriedJob)).toBe(true);
    expect((retriedJob as ReelMediaJob).edit).toEqual(cropEdit);
  });

  it.each([
    { framing: 'crop', crop: { ...cropEdit.crop, version: 2 } },
    { framing: 'crop', crop: { ...cropEdit.crop, aspectRatio: '1:1' } },
    { framing: 'crop' },
    { framing: 'fit', crop: cropEdit.crop },
  ])('rejects malformed edit metadata', (edit) => {
    expect(isReelMediaJob({ ...baseJob, edit })).toBe(false);
  });
});
