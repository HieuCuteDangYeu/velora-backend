import { ContentRepository } from './content.repository';

describe('ContentRepository reel deletion', () => {
  it('renumbers remaining series episodes after deleting a reel', async () => {
    const transaction = {
      reel: {
        findFirst: jest
          .fn()
          .mockResolvedValue({ id: 'reel-2', seriesId: 'series-1' }),
        delete: jest.fn().mockResolvedValue({}),
        findMany: jest
          .fn()
          .mockResolvedValue([{ id: 'reel-1' }, { id: 'reel-3' }]),
        updateMany: jest.fn().mockResolvedValue({ count: 2 }),
        update: jest.fn().mockResolvedValue({}),
      },
    };
    const repository = {
      $transaction: jest.fn((callback: (tx: typeof transaction) => unknown) =>
        callback(transaction),
      ),
      recommendationFeedCacheRepository: {
        invalidateReels: jest.fn().mockResolvedValue(undefined),
      },
    } as unknown as ContentRepository;

    await expect(
      ContentRepository.prototype.deleteReel.call(
        repository,
        'reel-2',
        'user-1',
      ),
    ).resolves.toBe(true);

    expect(transaction.reel.update).toHaveBeenCalledWith({
      where: { id: 'reel-1' },
      data: { episodeNumber: 1 },
    });
    expect(transaction.reel.update).toHaveBeenCalledWith({
      where: { id: 'reel-3' },
      data: { episodeNumber: 2 },
    });
    expect(
      (repository as any).recommendationFeedCacheRepository.invalidateReels,
    ).toHaveBeenCalledWith(['reel-2']);
  });
});
