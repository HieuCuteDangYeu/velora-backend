import { ConfigService } from '@nestjs/config';
import { ReelMediaJobPublisherAdapter } from './reel-media-job-publisher.adapter';

const job = {
  jobId: 'job-1',
  reelId: 'reel-1',
  userId: 'user-1',
  mediaKey: 'reels/user-1/source.mp4',
  mediaAttemptId: 'attempt-1',
  expectedLengthClass: 'SHORT' as const,
  tags: [],
  createdAt: '2026-11-17T00:00:00.000Z',
  schemaVersion: 1 as const,
};

function publisher(config: Record<string, string> = {}) {
  const adapter = new ReelMediaJobPublisherAdapter(new ConfigService(config));
  const publish = jest.fn().mockResolvedValue(undefined);
  (adapter as unknown as { channel: unknown }).channel = { publish };
  return { adapter, publish };
}

describe('ReelMediaJobPublisherAdapter routing', () => {
  it('sends encode jobs to the lane queue', async () => {
    const { adapter, publish } = publisher();

    await adapter.publish(job);

    expect((publish.mock.calls as unknown[][])[0][1]).toBe('reel.media.short');
  });

  it('sends evidence jobs to the evidence queue of their lane', async () => {
    const { adapter, publish } = publisher();

    await adapter.publish({ ...job, sourceMode: 'EXISTING_HLS' });
    await adapter.publish({
      ...job,
      expectedLengthClass: 'LONG',
      sourceMode: 'EXISTING_HLS',
    });

    expect((publish.mock.calls as unknown[][]).map((call) => call[1])).toEqual([
      'reel.media.short.evidence',
      'reel.media.long.evidence',
    ]);
  });

  it('can send evidence jobs down the encode queue again', async () => {
    const { adapter, publish } = publisher({
      REEL_MEDIA_EVIDENCE_QUEUE_ENABLED: 'false',
    });

    await adapter.publish({ ...job, sourceMode: 'EXISTING_HLS' });

    expect((publish.mock.calls as unknown[][])[0][1]).toBe('reel.media.short');
  });
});
