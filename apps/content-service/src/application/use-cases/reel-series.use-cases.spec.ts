import { CreateReelSeriesUseCase } from './create-reel-series.use-case';
import { GetReelSeriesUseCase } from './get-reel-series.use-case';
import { UpdateReelSeriesUseCase } from './update-reel-series.use-case';
import { DeleteReelSeriesUseCase } from './delete-reel-series.use-case';
import { RemoveReelFromSeriesUseCase } from './remove-reel-from-series.use-case';
import {
  ReelSeriesConflictError,
  ReelSeriesNotFoundError,
  ReelSeriesForbiddenError,
  ReelNotFoundError,
} from '@content/domain/errors/content.error';
import { ListOwnedReelSeriesUseCase } from './list-owned-reel-series.use-case';
import { GetReelSeriesEpisodesUseCase } from './get-reel-series-episodes.use-case';
import { ListReelSeriesCandidatesUseCase } from './list-reel-series-candidates.use-case';
import { AddReelsToSeriesUseCase } from './add-reels-to-series.use-case';
import { ReorderReelSeriesUseCase } from './reorder-reel-series.use-case';

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

describe('reel series use cases', () => {
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
    const useCase = new ListOwnedReelSeriesUseCase(repository as never);

    const result = await useCase.execute('user-1', {
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
    const useCase = new GetReelSeriesEpisodesUseCase(
      repository as never,
      friendAccess as never,
    );

    const result = await useCase.execute('series-1', 'user-1', false, {
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
    const useCase = new GetReelSeriesEpisodesUseCase(
      repository as never,
      friendAccess as never,
    );

    await useCase.execute('series-1', 'friend-1', false, { limit: 15 });

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
      useCase.execute('series-1', 'stranger-1', false, { limit: 15 }),
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
    const useCase = new ListReelSeriesCandidatesUseCase(repository as never);

    await useCase.execute('series-1', 'user-1', {
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
    const useCase = new AddReelsToSeriesUseCase(repository as never);

    await useCase.execute('series-1', 'user-1', {
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
    const useCase = new AddReelsToSeriesUseCase(repository as never);

    await expect(
      useCase.execute('series-1', 'user-1', {
        reelIds: ['reel-3', 'reel-4'],
      }),
    ).rejects.toBeInstanceOf(ReelSeriesConflictError);
  });

  it('requires reorder requests to contain every member exactly once', async () => {
    const repository = {
      findReelSeriesById: jest.fn().mockResolvedValue(series),
      reorderReelSeries: jest.fn(),
    };
    const useCase = new ReorderReelSeriesUseCase(repository as never);

    await expect(
      useCase.execute('series-1', 'user-1', { reelIds: ['reel-2'] }),
    ).rejects.toBeInstanceOf(ReelSeriesConflictError);
    expect(repository.reorderReelSeries).not.toHaveBeenCalled();
  });
});

describe('reel series operation boundaries', () => {
  it('creates a series through the repository port', async () => {
    const repository = {
      createReelSeries: jest.fn().mockResolvedValue(series),
    };
    const useCase = new CreateReelSeriesUseCase(repository as never);
    const payload = {
      title: 'Series',
      description: 'Description',
      visibility: 'public' as const,
    };
    await expect(useCase.execute('user-1', payload)).resolves.toEqual(series);
    expect(repository.createReelSeries).toHaveBeenCalledWith({
      ownerId: 'user-1',
      ...payload,
    });
  });

  it('preserves owner/admin access and filters unfinished episodes for viewers', async () => {
    const value = {
      ...series,
      reels: [
        { id: 'ready', mediaStatus: 'COMPLETED' },
        { id: 'pending', mediaStatus: 'PENDING' },
      ],
    };
    const repository = {
      findReelSeriesById: jest.fn().mockResolvedValue(value),
    };
    const friendAccess = { canView: jest.fn().mockResolvedValue(true) };
    const useCase = new GetReelSeriesUseCase(repository as never, friendAccess);
    await expect(useCase.execute('series-1', 'user-1')).resolves.toBe(value);
    await expect(useCase.execute('series-1', 'admin', true)).resolves.toBe(
      value,
    );
    expect(friendAccess.canView).not.toHaveBeenCalled();
    expect(
      (await useCase.execute('series-1', 'viewer')).reels.map(
        (reel) => reel.id,
      ),
    ).toEqual(['ready']);
    friendAccess.canView.mockResolvedValue(false);
    await expect(useCase.execute('series-1', 'viewer')).rejects.toBeInstanceOf(
      ReelSeriesNotFoundError,
    );
  });

  it.each([
    ListReelSeriesCandidatesUseCase,
    UpdateReelSeriesUseCase,
    DeleteReelSeriesUseCase,
    AddReelsToSeriesUseCase,
    ReorderReelSeriesUseCase,
  ])(
    '%p rejects missing series and non-owners before writing',
    async (UseCase) => {
      const repository = {
        findReelSeriesById: jest.fn().mockResolvedValue(null),
      };
      const useCase = new UseCase(repository as never);
      await expect(
        useCase.execute('series-1', 'stranger', {
          reelIds: ['reel-1'],
          title: 'Updated',
        }),
      ).rejects.toBeInstanceOf(ReelSeriesNotFoundError);
      repository.findReelSeriesById.mockResolvedValue(series);
      await expect(
        useCase.execute('series-1', 'stranger', {
          reelIds: ['reel-1'],
          title: 'Updated',
        }),
      ).rejects.toBeInstanceOf(ReelSeriesForbiddenError);
    },
  );

  it('updates and deletes through the port and handles concurrent disappearance', async () => {
    const repository = {
      findReelSeriesById: jest.fn().mockResolvedValue(series),
      updateReelSeries: jest.fn().mockResolvedValue(series),
      deleteReelSeries: jest.fn().mockResolvedValue(true),
    };
    const update = new UpdateReelSeriesUseCase(repository as never);
    const remove = new DeleteReelSeriesUseCase(repository as never);
    await expect(
      update.execute('series-1', 'user-1', { title: 'Updated' }),
    ).resolves.toBe(series);
    expect(repository.updateReelSeries).toHaveBeenCalledWith(
      'series-1',
      'user-1',
      { title: 'Updated' },
    );
    await remove.execute('series-1', 'user-1');
    expect(repository.deleteReelSeries).toHaveBeenCalledWith(
      'series-1',
      'user-1',
    );
    repository.updateReelSeries.mockResolvedValue(null);
    repository.deleteReelSeries.mockResolvedValue(false);
    await expect(
      update.execute('series-1', 'user-1', { title: 'Updated' }),
    ).rejects.toBeInstanceOf(ReelSeriesNotFoundError);
    await expect(remove.execute('series-1', 'user-1')).rejects.toBeInstanceOf(
      ReelSeriesNotFoundError,
    );
  });

  it('checks ownership and membership before removing and rereads after success', async () => {
    const repository = {
      findReelSeriesById: jest.fn().mockResolvedValue(series),
      removeReelFromSeries: jest.fn().mockResolvedValue(true),
    };
    const useCase = new RemoveReelFromSeriesUseCase(repository as never);
    await expect(
      useCase.execute('series-1', 'reel-1', 'stranger'),
    ).rejects.toBeInstanceOf(ReelSeriesForbiddenError);
    await expect(
      useCase.execute('series-1', 'missing', 'user-1'),
    ).rejects.toBeInstanceOf(ReelNotFoundError);
    expect(repository.removeReelFromSeries).not.toHaveBeenCalled();
    await expect(useCase.execute('series-1', 'reel-1', 'user-1')).resolves.toBe(
      series,
    );
    expect(repository.removeReelFromSeries).toHaveBeenCalledWith({
      seriesId: 'series-1',
      reelId: 'reel-1',
      ownerId: 'user-1',
    });
    repository.removeReelFromSeries.mockResolvedValue(false);
    await expect(
      useCase.execute('series-1', 'reel-1', 'user-1'),
    ).rejects.toBeInstanceOf(ReelNotFoundError);
  });

  it('preserves requested order and reports concurrent reorder conflicts', async () => {
    const repository = {
      findReelSeriesById: jest.fn().mockResolvedValue(series),
      reorderReelSeries: jest.fn().mockResolvedValue(true),
    };
    const useCase = new ReorderReelSeriesUseCase(repository as never);
    const payload = { reelIds: ['reel-2', 'reel-1'] };
    await expect(useCase.execute('series-1', 'user-1', payload)).resolves.toBe(
      series,
    );
    expect(repository.reorderReelSeries).toHaveBeenCalledWith({
      seriesId: 'series-1',
      ownerId: 'user-1',
      ...payload,
    });
    repository.reorderReelSeries.mockResolvedValue(false);
    await expect(
      useCase.execute('series-1', 'user-1', payload),
    ).rejects.toBeInstanceOf(ReelSeriesConflictError);
  });
});
