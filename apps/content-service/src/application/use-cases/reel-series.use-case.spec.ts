import { ReelSeriesConflictError } from '@content/domain/errors/content.error';
import { ReelSeriesUseCase } from './reel-series.use-case';

const series = {
  id: 'series-1',
  ownerId: 'user-1',
  title: 'Series',
  visibility: 'public' as const,
  createdAt: new Date(),
  updatedAt: new Date(),
  reels: [
    {
      id: 'reel-1',
      series: { id: 'series-1', title: 'Series', episodeNumber: 1 },
    },
    {
      id: 'reel-2',
      series: { id: 'series-1', title: 'Series', episodeNumber: 2 },
    },
  ],
};

describe('ReelSeriesUseCase', () => {
  it('lists only the current owner series with the requested cursor filters', async () => {
    const cursor = { createdAt: new Date('2026-09-18T00:00:00.000Z'), id: 'series-0' };
    const repository = {
      listReelSeries: jest.fn().mockResolvedValue({ items: [series], nextCursor: cursor }),
    };
    const useCase = new ReelSeriesUseCase(repository as never, {} as never);

    const result = await useCase.listOwned('user-1', {
      visibility: 'friends',
      limit: 12,
      cursor,
    });

    expect(repository.listReelSeries).toHaveBeenCalledWith({
      ownerId: 'user-1',
      visibility: 'friends',
      limit: 12,
      cursor,
    });
    expect(result).toEqual({ items: [series], nextCursor: cursor });
  });

  it('appends an owned reel using the next episode number', async () => {
    const repository = {
      findReelSeriesById: jest.fn().mockResolvedValue(series),
      findById: jest.fn().mockResolvedValue({
        id: 'reel-3',
        userId: 'user-1',
        visibility: 'public',
      }),
      addReelToSeries: jest.fn().mockResolvedValue(true),
    };
    const useCase = new ReelSeriesUseCase(repository as never, {} as never);

    await useCase.addReel('series-1', 'user-1', { reelId: 'reel-3' });

    expect(repository.addReelToSeries).toHaveBeenCalledWith({
      seriesId: 'series-1',
      reelId: 'reel-3',
      ownerId: 'user-1',
      episodeNumber: 3,
    });
  });

  it('rejects a reel whose visibility differs from the series', async () => {
    const repository = {
      findReelSeriesById: jest.fn().mockResolvedValue(series),
      findById: jest.fn().mockResolvedValue({
        id: 'reel-3',
        userId: 'user-1',
        visibility: 'private',
      }),
    };
    const useCase = new ReelSeriesUseCase(repository as never, {} as never);

    await expect(
      useCase.addReel('series-1', 'user-1', { reelId: 'reel-3' }),
    ).rejects.toBeInstanceOf(ReelSeriesConflictError);
  });

  it('requires reorder requests to contain every member exactly once', async () => {
    const repository = {
      findReelSeriesById: jest.fn().mockResolvedValue(series),
      reorderReelSeries: jest.fn(),
    };
    const useCase = new ReelSeriesUseCase(repository as never, {} as never);

    await expect(
      useCase.reorder('series-1', 'user-1', { reelIds: ['reel-2'] }),
    ).rejects.toBeInstanceOf(ReelSeriesConflictError);
    expect(repository.reorderReelSeries).not.toHaveBeenCalled();
  });
});
