import {
  ReelSeriesConflictError,
  ReelSeriesNotFoundError,
} from '@content/domain/errors/content.error';
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
    const cursor = {
      createdAt: new Date('2026-09-18T00:00:00.000Z'),
      id: 'series-0',
    };
    const repository = {
      listReelSeries: jest
        .fn()
        .mockResolvedValue({ items: [series], nextCursor: cursor }),
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

  it('returns a full episode page to the series owner without checking friend access', async () => {
    const metadata = {
      id: 'series-1',
      ownerId: 'user-1',
      title: 'Series',
      visibility: 'private' as const,
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    const page = {
      items: [],
      episodeCount: 20,
      previousCursor: { episodeNumber: 3, id: 'reel-3' },
      nextCursor: { episodeNumber: 17, id: 'reel-17' },
    };
    const repository = {
      findReelSeriesMetadataById: jest.fn().mockResolvedValue(metadata),
      listReelSeriesEpisodes: jest.fn().mockResolvedValue(page),
    };
    const friendAccess = { canView: jest.fn() };
    const useCase = new ReelSeriesUseCase(
      repository as never,
      friendAccess as never,
    );

    const result = await useCase.getEpisodePage('series-1', 'user-1', false, {
      limit: 15,
      aroundReelId: 'reel-10',
    });

    expect(friendAccess.canView).not.toHaveBeenCalled();
    expect(repository.listReelSeriesEpisodes).toHaveBeenCalledWith({
      seriesId: 'series-1',
      onlyCompleted: false,
      limit: 15,
      aroundReelId: 'reel-10',
    });
    expect(result.series).toEqual({ ...metadata, episodeCount: 20 });
    expect(result.previousCursor).toEqual(page.previousCursor);
    expect(result.nextCursor).toEqual(page.nextCursor);
  });

  it('limits visible episode pages to completed reels and denies viewers without series access', async () => {
    const metadata = {
      id: 'series-1',
      ownerId: 'owner-1',
      title: 'Series',
      visibility: 'friends' as const,
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    const repository = {
      findReelSeriesMetadataById: jest.fn().mockResolvedValue(metadata),
      listReelSeriesEpisodes: jest.fn().mockResolvedValue({
        items: [],
        episodeCount: 0,
        previousCursor: null,
        nextCursor: null,
      }),
    };
    const friendAccess = { canView: jest.fn().mockResolvedValue(true) };
    const useCase = new ReelSeriesUseCase(
      repository as never,
      friendAccess as never,
    );

    await useCase.getEpisodePage('series-1', 'friend-1', false, { limit: 15 });

    expect(friendAccess.canView).toHaveBeenCalledWith({
      viewerId: 'friend-1',
      ownerId: 'owner-1',
      visibility: 'friends',
    });
    expect(repository.listReelSeriesEpisodes).toHaveBeenCalledWith({
      seriesId: 'series-1',
      onlyCompleted: true,
      limit: 15,
    });

    friendAccess.canView.mockResolvedValue(false);
    repository.listReelSeriesEpisodes.mockClear();
    await expect(
      useCase.getEpisodePage('series-1', 'stranger-1', false, { limit: 15 }),
    ).rejects.toBeInstanceOf(ReelSeriesNotFoundError);
    expect(repository.listReelSeriesEpisodes).not.toHaveBeenCalled();
  });

  it('lists only candidate reels matching the owned series visibility', async () => {
    const cursor = {
      createdAt: new Date('2026-09-18T00:00:00.000Z'),
      id: 'reel-0',
    };
    const repository = {
      findReelSeriesById: jest.fn().mockResolvedValue(series),
      listReelSeriesCandidates: jest
        .fn()
        .mockResolvedValue({ items: [], nextCursor: cursor }),
    };
    const useCase = new ReelSeriesUseCase(repository as never, {} as never);

    await useCase.listCandidates('series-1', 'user-1', {
      limit: 12,
      cursor,
    });

    expect(repository.listReelSeriesCandidates).toHaveBeenCalledWith({
      ownerId: 'user-1',
      visibility: 'public',
      limit: 12,
      cursor,
    });
  });

  it('adds selected reels as one ordered batch', async () => {
    const repository = {
      findReelSeriesById: jest.fn().mockResolvedValue(series),
      addReelsToSeries: jest.fn().mockResolvedValue(true),
    };
    const useCase = new ReelSeriesUseCase(repository as never, {} as never);

    await useCase.addReels('series-1', 'user-1', {
      reelIds: ['reel-3', 'reel-4'],
    });

    expect(repository.addReelsToSeries).toHaveBeenCalledWith({
      seriesId: 'series-1',
      reelIds: ['reel-3', 'reel-4'],
      ownerId: 'user-1',
    });
  });

  it('rejects the whole batch when any selected reel is ineligible', async () => {
    const repository = {
      findReelSeriesById: jest.fn().mockResolvedValue(series),
      addReelsToSeries: jest.fn().mockResolvedValue(false),
    };
    const useCase = new ReelSeriesUseCase(repository as never, {} as never);

    await expect(
      useCase.addReels('series-1', 'user-1', {
        reelIds: ['reel-3', 'reel-4'],
      }),
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
