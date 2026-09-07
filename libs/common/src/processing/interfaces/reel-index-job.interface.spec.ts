import { isReelIndexJob, type ReelIndexJob } from './reel-index-job.interface';

const baseJob: ReelIndexJob = {
  jobId: 'job-1',
  reelId: 'reel-1',
  userId: 'user-1',
  mediaAttemptId: 'media-1',
  indexAttemptId: 'index-1',
  indexVersion: 'reel-index-v2',
  mediaKey: 'uploads/reel.mp4',
  sourceDurationMs: 10_000,
  sourceOrientation: 'LANDSCAPE',
  sourceLengthClass: 'SHORT',
  tags: [],
  createdAt: '2026-09-07T00:00:00.000Z',
  schemaVersion: 1,
};

describe('isReelIndexJob output duration compatibility', () => {
  it('accepts legacy jobs without outputDurationMs', () => {
    expect(isReelIndexJob(baseJob)).toBe(true);
  });

  it('accepts an output duration bounded by the original source duration', () => {
    expect(isReelIndexJob({ ...baseJob, outputDurationMs: 4000 })).toBe(true);
  });

  it('rejects an output duration longer than the original source', () => {
    expect(isReelIndexJob({ ...baseJob, outputDurationMs: 10_001 })).toBe(
      false,
    );
  });
});
