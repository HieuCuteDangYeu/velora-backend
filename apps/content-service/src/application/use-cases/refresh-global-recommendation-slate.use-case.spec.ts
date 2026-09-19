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
});
