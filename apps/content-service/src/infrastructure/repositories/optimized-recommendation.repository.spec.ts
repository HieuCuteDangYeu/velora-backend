import { OptimizedRecommendationRepository } from './optimized-recommendation.repository';

describe('OptimizedRecommendationRepository', () => {
  it('normalizes trending candidates from database-side aggregates', async () => {
    const queryRaw = jest.fn().mockResolvedValue([
      { reelId: 'reel-1', score: 4 },
      { reelId: 'reel-2', score: 2 },
    ]);
    const repository = new OptimizedRecommendationRepository({
      $queryRaw: queryRaw,
      reelViewEvent: { findMany: jest.fn() },
    } as any);

    const result = await repository.findTrendingCandidates({
      viewerId: 'viewer-1',
      limit: 20,
      excludedUserIds: [],
      friendUserIds: [],
    });

    expect(queryRaw).toHaveBeenCalledTimes(1);
    expect(result).toEqual([
      {
        reelId: 'reel-1',
        source: 'TRENDING',
        sourceScore: 1,
        reasons: ['strong recent watch and completion signals'],
      },
      {
        reelId: 'reel-2',
        source: 'TRENDING',
        sourceScore: 0.5,
        reasons: ['strong recent watch and completion signals'],
      },
    ]);
  });

  it('builds candidate engagement from a compact SQL aggregate instead of loading raw event rows', async () => {
    const findMany = jest.fn().mockResolvedValue([]);
    const queryRaw = jest.fn().mockResolvedValue([
      {
        reelId: 'reel-1',
        impressionCount: 10,
        completionCount: 5,
        replayCount: 2,
        skipCount: 1,
        averagePercentageWatched: 80,
      },
    ]);
    const repository = new OptimizedRecommendationRepository({
      $queryRaw: queryRaw,
      reelViewEvent: { findMany },
    } as any);

    const result = await repository.loadRankingSnapshot({
      viewerId: 'viewer-1',
      feedSessionId: '2f628c36-e32d-4b0c-8df5-c1f91087a004',
      reelIds: ['reel-1', 'reel-2'],
    });

    expect(queryRaw).toHaveBeenCalledTimes(1);
    expect(
      findMany.mock.calls.some(
        ([input]) => input?.take === 20_000 || input?.take === 10000,
      ),
    ).toBe(false);
    expect(result.engagementByReelId['reel-1']).toEqual({
      impressionCount: 10,
      completionCount: 5,
      replayCount: 2,
      skipCount: 1,
      averagePercentageWatched: 80,
      completionRate: 0.5,
      replayRate: 0.2,
      skipRate: 0.1,
      trendingScore: 0.45,
    });
    expect(result.engagementByReelId['reel-2']).toEqual({
      impressionCount: 0,
      completionCount: 0,
      replayCount: 0,
      skipCount: 0,
      averagePercentageWatched: 0,
      completionRate: 0,
      replayRate: 0,
      skipRate: 0,
      trendingScore: 0,
    });
  });
});
