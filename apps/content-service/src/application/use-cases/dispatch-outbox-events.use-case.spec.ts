import { DispatchOutboxEventsUseCase } from './dispatch-outbox-events.use-case';
import { REEL_HLS_CACHE_EVENT_TYPE } from '@common/content/reel-hls-replacement';

describe('DispatchOutboxEventsUseCase', () => {
  it('claims events against the same app clock used for outbox scheduling', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-09-24T10:00:00.000Z'));
    const claimPending = jest.fn().mockResolvedValue([]);
    const useCase = new DispatchOutboxEventsUseCase(
      { claimPending } as never,
      {} as never,
      {} as never,
      {} as never,
    );

    await useCase.execute({ batchSize: 25, staleClaimMs: 60_000 });

    expect(claimPending).toHaveBeenCalledWith({
      limit: 25,
      claimToken: expect.any(String),
      dueBefore: new Date('2026-09-24T10:00:00.000Z'),
      staleBefore: new Date('2026-09-24T09:59:00.000Z'),
    });

    jest.useRealTimers();
  });
  it('durably retries playback cache invalidation without sending a media or index job', async () => {
    const invalidateReels = jest
      .fn()
      .mockRejectedValueOnce(new Error('cache unavailable'))
      .mockResolvedValue(undefined);
    const event = {
      id: 'event',
      aggregateId: 'reel',
      eventType: REEL_HLS_CACHE_EVENT_TYPE,
      payload: { reelId: 'reel' },
      attemptCount: 1,
    };
    const outbox = {
      claimPending: jest.fn().mockResolvedValue([event]),
      markFailed: jest.fn(),
      markPublished: jest.fn().mockResolvedValue(true),
    };
    const media = { publish: jest.fn() };
    const index = { publish: jest.fn() };
    const useCase = new DispatchOutboxEventsUseCase(outbox, media, index, {
      invalidateReels,
    } as never);
    expect(
      await useCase.execute({ batchSize: 1, staleClaimMs: 60000 }),
    ).toMatchObject({ failed: 1, published: 0 });
    expect(outbox.markFailed).toHaveBeenCalledWith(
      expect.objectContaining({ eventId: 'event' }),
    );
    expect(
      await useCase.execute({ batchSize: 1, staleClaimMs: 60000 }),
    ).toMatchObject({ published: 1 });
    expect(invalidateReels).toHaveBeenCalledWith(['reel']);
    expect(media.publish).not.toHaveBeenCalled();
    expect(index.publish).not.toHaveBeenCalled();
  });
});
