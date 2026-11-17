import type { Reel } from '@content/domain/entities/reel.entity';
import type { IRecommendationFeedCacheRepository } from '@content/domain/interfaces/recommendation-feed-cache.repository.interface';
import type { IRecommendationRepository } from '@content/domain/interfaces/recommendation.repository.interface';
import { RefreshGlobalRecommendationSlateUseCase } from './refresh-global-recommendation-slate.use-case';

function reel(id: string): Reel {
  return {
    id,
    userId: `creator-${id}`,
    mediaKey: `reels/${id}.mp4`,
    tags: [],
    status: 'COMPLETED',
    mediaStatus: 'COMPLETED',
    indexStatus: 'COMPLETED',
    visibility: 'public',
    viewCount: 1n,
    createdAt: new Date('2026-09-19T10:00:00.000Z'),
    updatedAt: new Date('2026-09-19T10:00:00.000Z'),
  };
}

describe('RefreshGlobalRecommendationSlateUseCase', () => {
  it('stores an eligible top quality+trending slate and primes reel entities', async () => {
    const reels = [reel('quality'), reel('both'), reel('trending')];
    const recommendationRepository = {
      findRecentQualityCandidates: jest.fn().mockResolvedValue([
        {
          reelId: 'quality',
          source: 'RECENT_QUALITY',
          sourceScore: 0.9,
          reasons: [],
        },
        {
          reelId: 'both',
          source: 'RECENT_QUALITY',
          sourceScore: 0.8,
          reasons: [],
        },
      ]),
      findTrendingCandidates: jest.fn().mockResolvedValue([
        {
          reelId: 'both',
          source: 'TRENDING',
          sourceScore: 0.95,
          reasons: [],
        },
        {
          reelId: 'trending',
          source: 'TRENDING',
          sourceScore: 0.7,
          reasons: [],
        },
      ]),
      findExplorationCandidates: jest.fn().mockResolvedValue([]),
      findEligibleReelsByIds: jest.fn().mockResolvedValue(reels),
    } as unknown as jest.Mocked<IRecommendationRepository>;
    const feedCacheRepository: jest.Mocked<IRecommendationFeedCacheRepository> =
      {
        getGlobalSlate: jest.fn(),
        saveGlobalSlate: jest.fn().mockResolvedValue(undefined),
        getReels: jest.fn(),
        saveReels: jest.fn().mockResolvedValue(undefined),
        invalidateReels: jest.fn(),
      };
    const useCase = new RefreshGlobalRecommendationSlateUseCase(
      recommendationRepository,
      feedCacheRepository,
    );

    const slate = await useCase.execute();

    expect(slate.items.map((item) => item.reelId)).toEqual([
      'both',
      'quality',
      'trending',
    ]);
    expect(slate.items[0]).toMatchObject({
      primarySource: 'TRENDING',
      sources: ['TRENDING', 'RECENT_QUALITY'],
    });
    expect(
      recommendationRepository.findEligibleReelsByIds,
    ).toHaveBeenCalledWith(['both', 'quality', 'trending'], []);
    expect(feedCacheRepository.saveReels).toHaveBeenCalledWith(
      reels,
      3 * 60 * 60,
    );
    expect(feedCacheRepository.saveGlobalSlate).toHaveBeenCalledWith(
      slate,
      10 * 60,
    );
  });
  function slateHarness(options: {
    exploration: () => Promise<unknown>;
    reels: Reel[];
  }) {
    const recommendationRepository = {
      findRecentQualityCandidates: jest.fn().mockResolvedValue([]),
      findTrendingCandidates: jest.fn().mockResolvedValue([
        {
          reelId: 'trending',
          source: 'TRENDING',
          sourceScore: 0.9,
          reasons: [],
        },
      ]),
      findExplorationCandidates: jest
        .fn()
        .mockImplementation(options.exploration),
      findEligibleReelsByIds: jest.fn().mockResolvedValue(options.reels),
    } as unknown as jest.Mocked<IRecommendationRepository>;
    const feedCacheRepository: jest.Mocked<IRecommendationFeedCacheRepository> =
      {
        getGlobalSlate: jest.fn(),
        saveGlobalSlate: jest.fn().mockResolvedValue(undefined),
        getReels: jest.fn(),
        saveReels: jest.fn().mockResolvedValue(undefined),
        invalidateReels: jest.fn(),
      };
    return new RefreshGlobalRecommendationSlateUseCase(
      recommendationRepository,
      feedCacheRepository,
    );
  }

  it('backfills the slate with exploration reels when there are no recent uploads', async () => {
    const useCase = slateHarness({
      reels: [reel('trending'), reel('old-1'), reel('old-2')],
      exploration: () =>
        Promise.resolve([
          {
            reelId: 'old-1',
            source: 'EXPLORATION',
            sourceScore: 0.4,
            reasons: [],
          },
          {
            reelId: 'old-2',
            source: 'EXPLORATION',
            sourceScore: 0.3,
            reasons: [],
          },
        ]),
    });

    const slate = await useCase.execute();

    expect(slate.items.map((item) => item.reelId)).toEqual([
      'trending',
      'old-1',
      'old-2',
    ]);
    expect(slate.items[1].primarySource).toBe('EXPLORATION');
  });

  it('still builds the slate when the exploration backfill fails', async () => {
    const useCase = slateHarness({
      reels: [reel('trending')],
      exploration: () => Promise.reject(new Error('pool timeout')),
    });

    const slate = await useCase.execute();

    expect(slate.items.map((item) => item.reelId)).toEqual(['trending']);
  });
});
