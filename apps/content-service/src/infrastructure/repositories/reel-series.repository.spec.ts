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

  it('pages completed episodes in series order and returns stable previous and next cursors', async () => {
    const count = jest.fn().mockResolvedValue(20);
    const findMany = jest.fn().mockResolvedValue([
      {
        id: 'reel-4',
        userId: 'user-1',
        mediaKey: 'reel-4.mp4',
        tags: [],
        status: 'COMPLETED',
        mediaStatus: 'COMPLETED',
        indexStatus: 'COMPLETED',
        visibility: 'friends',
        viewCount: 3n,
        series: { id: 'series-1', title: 'Series' },
        episodeNumber: 4,
      },
      {
        id: 'reel-3',
        userId: 'user-1',
        mediaKey: 'reel-3.mp4',
        tags: [],
        status: 'COMPLETED',
        mediaStatus: 'COMPLETED',
        indexStatus: 'COMPLETED',
        visibility: 'friends',
        viewCount: 2n,
        series: { id: 'series-1', title: 'Series' },
        episodeNumber: 3,
      },
      {
        id: 'reel-2',
        userId: 'user-1',
        mediaKey: 'reel-2.mp4',
        tags: [],
        status: 'COMPLETED',
        mediaStatus: 'COMPLETED',
        indexStatus: 'COMPLETED',
        visibility: 'friends',
        viewCount: 1n,
        series: { id: 'series-1', title: 'Series' },
        episodeNumber: 2,
      },
    ]);
    const repository = new ReelSeriesRepository({
      reel: { count, findMany },
    } as never);

    const page = await repository.listReelSeriesEpisodes({
      seriesId: 'series-1',
      onlyCompleted: true,
      limit: 2,
      cursor: { episodeNumber: 5, id: 'reel-5' },
      direction: 'previous',
    });

    expect(findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          seriesId: 'series-1',
          episodeNumber: { not: null },
          mediaStatus: 'COMPLETED',
        }),
        orderBy: [{ episodeNumber: 'desc' }, { id: 'desc' }],
        take: 3,
      }),
    );
    const episodeNumbers = page.items.map((reel) => reel.series?.episodeNumber);
    expect(episodeNumbers).toEqual([3, 4]);
    expect(page.previousCursor).toEqual({ episodeNumber: 3, id: 'reel-3' });
    expect(page.nextCursor).toEqual({ episodeNumber: 4, id: 'reel-4' });
    expect(page.episodeCount).toBe(20);
    expect(count).toHaveBeenCalledWith({
      where: {
        seriesId: 'series-1',
        episodeNumber: { not: null },
        mediaStatus: 'COMPLETED',
      },
    });
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
