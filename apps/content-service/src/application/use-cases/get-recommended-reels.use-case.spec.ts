import type { Reel } from '@content/domain/entities/reel.entity';
import type { IFriendContentAccessService } from '@content/domain/interfaces/friend-content-access.service.interface';
import type { IRecommendationConfig } from '@content/domain/interfaces/recommendation-config.interface';
import type {
  IRecommendationFeedSessionRepository,
  RecommendationFeedSession,
} from '@content/domain/interfaces/recommendation-feed-session.repository.interface';
import type { IRecommendationRankingConfig } from '@content/domain/interfaces/recommendation-ranking-config.interface';
import type { IRecommendationTelemetryService } from '@content/domain/interfaces/recommendation-telemetry-service.interface';
import type { IRecommendationRepository } from '@content/domain/interfaces/recommendation.repository.interface';
import type { ISemanticRecommendationService } from '@content/domain/interfaces/semantic-recommendation.service.interface';
import { GetRecommendedReelsUseCase } from './get-recommended-reels.use-case';

const emptySnapshot = {
  tagAffinityByTag: {},
  creatorAffinityByCreatorId: {},
  sessionTagIntentByTag: {},
  sessionCreatorIntentByCreatorId: {},
  recentCreatorImpressionsByCreatorId: {},
  recentTagImpressionsByTag: {},
  recentlySeenReelIds: [],
  engagementByReelId: {},
};

function reel(id: string, createdAt: string): Reel {
  return {
    id,
    userId: `creator-${id}`,
    mediaKey: `reels/${id}.mp4`,
    tags: [`tag-${id}`],
    status: 'COMPLETED',
    mediaStatus: 'COMPLETED',
    indexStatus: 'COMPLETED',
    visibility: 'public',
    viewCount: 1n,
    createdAt: new Date(createdAt),
    updatedAt: new Date(createdAt),
  };
}

function createHarness(options?: {
  cachedSession?: RecommendationFeedSession;
  reels?: Reel[];
}) {
  const reels = options?.reels ?? [
    reel('reel-1', '2026-09-11T10:00:00.000Z'),
    reel('reel-2', '2026-09-10T10:00:00.000Z'),
    reel('reel-3', '2026-09-09T10:00:00.000Z'),
  ];
  const evidence = reels.map((item, index) => ({
    reelId: item.id,
    source: 'RECENT_QUALITY' as const,
    sourceScore: 0.9 - index * 0.1,
    reasons: ['test evidence'],
  }));
  const recommendationRepository: jest.Mocked<IRecommendationRepository> = {
    findRecentQualityCandidates: jest.fn().mockResolvedValue(evidence),
    findTrendingCandidates: jest.fn().mockResolvedValue([]),
    findTagAffinityCandidates: jest.fn().mockResolvedValue([]),
    findCreatorAffinityCandidates: jest.fn().mockResolvedValue([]),
    findContentSimilarityCandidates: jest.fn().mockResolvedValue([]),
    findViewerInterestTags: jest.fn().mockResolvedValue([]),
    findSocialCandidates: jest.fn().mockResolvedValue([]),
    findExplorationCandidates: jest.fn().mockResolvedValue([]),
    findRecentlySeenReelIds: jest.fn().mockResolvedValue(new Set<string>()),
    findEligibleReelsByIds: jest
      .fn()
      .mockImplementation((ids: string[]) =>
        Promise.resolve(reels.filter((item) => ids.includes(item.id))),
      ),
    loadRankingSnapshot: jest.fn().mockResolvedValue(emptySnapshot),
  };
  const feedSessionRepository: jest.Mocked<IRecommendationFeedSessionRepository> =
    {
      get: jest.fn().mockResolvedValue(options?.cachedSession ?? null),
      save: jest.fn().mockResolvedValue(undefined),
    };
  const rankingConfig: IRecommendationRankingConfig = {
    getWeights: () => ({
      candidateScore: 1,
      tagAffinity: 0,
      creatorAffinity: 0,
      contentSimilarity: 0,
      trending: 0,
      freshness: 0,
      quality: 0,
      completionRate: 0,
      replayRate: 0,
      sessionIntent: 0,
      skipRate: 0,
    }),
    getFatigueConfig: () => ({
      recentlySeenPenalty: 0,
      creatorThreshold: 100,
      creatorStep: 0,
      creatorMaximum: 0,
      topicThreshold: 100,
      topicStep: 0,
      topicMaximum: 0,
    }),
    getDiversityConfig: () => ({
      maxConsecutiveCreator: 10,
      topicWindowSize: 10,
      maxTopicPerWindow: 10,
      sourceWindowSize: 10,
      maxSourcePerWindow: 10,
      nearDuplicateLookback: 4,
      nearDuplicateJaccardThreshold: 1,
      explorationRatio: 0,
    }),
  };
  const recommendationConfig: IRecommendationConfig = {
    getAlgorithmVersion: () => 'personalized-ranker-v2',
    getCandidateSource: () => 'PERSONALIZED_MULTI_SOURCE_PHASE8',
    getFeatureFlags: () => ({
      recentQualityPool: true,
      trendingPool: true,
      tagAffinityPool: true,
      creatorAffinityPool: true,
      metadataSimilarityPool: true,
      semanticPool: true,
      socialPool: true,
      explorationPool: true,
    }),
    getFeedSessionTtlSeconds: () => 900,
    getFeedSlateSize: () => 3,
    isTelemetryEnabled: () => true,
  };
  const telemetry: jest.Mocked<IRecommendationTelemetryService> = {
    publish: jest.fn(),
  };
  const friends: jest.Mocked<IFriendContentAccessService> = {
    getFeedAudience: jest.fn().mockResolvedValue({
      friendUserIds: [],
      excludedUserIds: [],
    }),
    canView: jest.fn().mockResolvedValue(true),
  };
  const semantic: jest.Mocked<ISemanticRecommendationService> = {
    findCandidates: jest.fn().mockResolvedValue([]),
  };
  const useCase = new GetRecommendedReelsUseCase(
    recommendationRepository,
    feedSessionRepository,
    rankingConfig,
    recommendationConfig,
    telemetry,
    friends,
    semantic,
  );

  return {
    useCase,
    reels,
    recommendationRepository,
    feedSessionRepository,
    telemetry,
  };
}

describe('GetRecommendedReelsUseCase feed sessions', () => {
  it('builds and caches a ranked slate while returning a cursor for the next ranked item', async () => {
    const harness = createHarness();

    const result = await harness.useCase.execute({
      viewerId: 'viewer-1',
      limit: 2,
    });

    expect(result.items.map((item) => item.id)).toEqual(['reel-1', 'reel-2']);
    expect(result.items.map((item) => item.recommendation?.rank)).toEqual([
      1, 2,
    ]);
    expect(result.nextCursor?.id).toBe('reel-2');
    expect(harness.feedSessionRepository.save).toHaveBeenCalledTimes(1);

    const savedSession = harness.feedSessionRepository.save.mock.calls[0][0];
    expect(savedSession.items.map((item) => item.reelId)).toEqual([
      'reel-1',
      'reel-2',
      'reel-3',
    ]);
  });

  it('serves the next page from the cached ranked slate without rerunning candidate generation', async () => {
    const cachedSession: RecommendationFeedSession = {
      feedSessionId: '2f628c36-e32d-4b0c-8df5-c1f91087a001',
      viewerId: 'viewer-1',
      algorithmVersion: 'personalized-ranker-v2',
      generatedAt: '2026-09-11T10:00:00.000Z',
      items: [
        {
          reelId: 'reel-1',
          primarySource: 'RECENT_QUALITY',
          sources: ['RECENT_QUALITY'],
        },
        {
          reelId: 'reel-2',
          primarySource: 'TRENDING',
          sources: ['TRENDING'],
        },
        {
          reelId: 'reel-3',
          primarySource: 'EXPLORATION',
          sources: ['EXPLORATION'],
        },
      ],
    };
    const harness = createHarness({ cachedSession });

    const result = await harness.useCase.execute({
      viewerId: 'viewer-1',
      feedSessionId: cachedSession.feedSessionId,
      cursor: {
        createdAt: harness.reels[0].createdAt,
        id: 'reel-1',
      },
      limit: 1,
    });

    expect(result.items.map((item) => item.id)).toEqual(['reel-2']);
    expect(result.items[0].recommendation?.rank).toBe(2);
    expect(result.nextCursor?.id).toBe('reel-2');
    expect(
      harness.recommendationRepository.findRecentQualityCandidates,
    ).not.toHaveBeenCalled();
    expect(
      harness.recommendationRepository.loadRankingSnapshot,
    ).not.toHaveBeenCalled();
    expect(harness.feedSessionRepository.save).not.toHaveBeenCalled();
  });

  it('does not use the chronological cursor to filter candidate generation when rebuilding a session', async () => {
    const harness = createHarness();
    const feedSessionId = '2f628c36-e32d-4b0c-8df5-c1f91087a002';

    const result = await harness.useCase.execute({
      viewerId: 'viewer-1',
      feedSessionId,
      cursor: {
        createdAt: harness.reels[0].createdAt,
        id: 'reel-1',
      },
      limit: 1,
    });

    expect(result.items.map((item) => item.id)).toEqual(['reel-2']);
    const query =
      harness.recommendationRepository.findRecentQualityCandidates.mock
        .calls[0][0];
    expect(query.cursor).toBeUndefined();
  });
});
