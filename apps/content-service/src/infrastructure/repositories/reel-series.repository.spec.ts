import { ReelSeriesRepository } from './reel-series.repository';

describe('ReelSeriesRepository', () => {
  it('filters picker candidates to completed standalone reels with matching visibility', async () => {
    const findMany = jest.fn().mockResolvedValue([]);
    const repository = new ReelSeriesRepository({
      reel: { findMany },
    } as never);

    await repository.listReelSeriesCandidates({
      ownerId: 'user-1',
      visibility: 'private',
      limit: 30,
    });

    expect(findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          userId: 'user-1',
          visibility: 'private',
          seriesId: null,
          mediaStatus: 'COMPLETED',
        }),
      }),
    );
  });

  it('appends selected reels atomically in request order', async () => {
    const transaction = {
      reelSeries: {
        findFirst: jest.fn().mockResolvedValue({ visibility: 'public' }),
      },
      reel: {
        findMany: jest.fn().mockResolvedValue([
          {
            id: 'reel-3',
            seriesId: null,
            visibility: 'public',
            mediaStatus: 'COMPLETED',
          },
          {
            id: 'reel-4',
            seriesId: null,
            visibility: 'public',
            mediaStatus: 'COMPLETED',
          },
        ]),
        aggregate: jest.fn().mockResolvedValue({ _max: { episodeNumber: 2 } }),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
    };
    const prisma = {
      $transaction: jest.fn((callback: (tx: typeof transaction) => unknown) =>
        callback(transaction),
      ),
    };
    const repository = new ReelSeriesRepository(prisma as never);

    await expect(
      repository.addReelsToSeries({
        seriesId: 'series-1',
        ownerId: 'user-1',
        reelIds: ['reel-4', 'reel-3'],
      }),
    ).resolves.toBe(true);

    expect(transaction.reel.updateMany).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        where: expect.objectContaining({ id: 'reel-4' }),
        data: { seriesId: 'series-1', episodeNumber: 3 },
      }),
    );
    expect(transaction.reel.updateMany).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        where: expect.objectContaining({ id: 'reel-3' }),
        data: { seriesId: 'series-1', episodeNumber: 4 },
      }),
    );
  });

  it('renumbers remaining episodes after removing one from a series', async () => {
    const transaction = {
      reel: {
        findFirst: jest.fn().mockResolvedValue({ id: 'reel-2' }),
        update: jest.fn().mockResolvedValue({}),
        findMany: jest
          .fn()
          .mockResolvedValueOnce([{ id: 'reel-1' }, { id: 'reel-3' }]),
        updateMany: jest.fn().mockResolvedValue({ count: 2 }),
      },
    };
    const prisma = {
      $transaction: jest.fn((callback: (tx: typeof transaction) => unknown) =>
        callback(transaction),
      ),
    };
    const repository = new ReelSeriesRepository(prisma as never);

    await expect(
      repository.removeReelFromSeries({
        seriesId: 'series-1',
        ownerId: 'user-1',
        reelId: 'reel-2',
      }),
    ).resolves.toBe(true);

    expect(transaction.reel.update).toHaveBeenCalledWith({
      where: { id: 'reel-1' },
      data: { episodeNumber: 1 },
    });
    expect(transaction.reel.update).toHaveBeenCalledWith({
      where: { id: 'reel-3' },
      data: { episodeNumber: 2 },
    });
  });
});
