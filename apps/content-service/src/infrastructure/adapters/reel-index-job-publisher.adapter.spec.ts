import type { ReelIndexJob } from '@common/processing/interfaces/reel-index-job.interface';
import { ConfigService } from '@nestjs/config';
import { ReelIndexJobPublisherAdapter } from './reel-index-job-publisher.adapter';

describe('ReelIndexJobPublisherAdapter skip tag', () => {
  const job = (tags: string[]): ReelIndexJob => ({
    jobId: 'job-1',
    reelId: 'reel-1',
    userId: 'user-1',
    mediaAttemptId: 'media-1',
    indexAttemptId: 'index-1',
    indexVersion: 'v1',
    mediaKey: 'reels/user-1/a.mp4',
    sourceDurationMs: 96_000,
    sourceOrientation: 'PORTRAIT',
    sourceLengthClass: 'SHORT',
    tags,
    createdAt: '2026-11-18T00:00:00.000Z',
    schemaVersion: 1,
  });

  const build = (config: Record<string, string>) => {
    const adapter = new ReelIndexJobPublisherAdapter(new ConfigService(config));
    const publish = jest.fn().mockResolvedValue(true);
    (adapter as unknown as { channel: { publish: jest.Mock } }).channel = {
      publish,
    };
    return { adapter, publish };
  };

  it('indexes every job when no skip tag is configured', async () => {
    const { adapter, publish } = build({});
    await adapter.publish(job(['integration-test']));
    expect(publish).toHaveBeenCalledTimes(1);
  });

  it('skips only jobs carrying the configured tag', async () => {
    const { adapter, publish } = build({
      REEL_INDEX_SKIP_TAG: 'integration-test',
    });
    await adapter.publish(job(['integration-test', 'run-1']));
    expect(publish).not.toHaveBeenCalled();
    await adapter.publish(job(['cooking']));
    expect(publish).toHaveBeenCalledTimes(1);
  });
});
