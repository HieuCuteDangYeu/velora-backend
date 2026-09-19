import type { Reel } from '@content/domain/entities/reel.entity';
import type { IFriendContentAccessService } from '@content/domain/interfaces/friend-content-access.service.interface';
import type { IRecommendationConfig } from '@content/domain/interfaces/recommendation-config.interface';
import type {
  IRecommendationFeedCacheRepository,
  RecommendationGlobalSlate,
} from '@content/domain/interfaces/recommendation-feed-cache.repository.interface';
import type {
  IRecommendationFeedSessionRepository,
  RecommendationFeedSession,
} from '@content/domain/interfaces/recommendation-feed-session.repository.interface';
import type { IRecommendationRankingConfig } from '@content/domain/interfaces/recommendation-ranking-config.interface';
import type { IRecommendationTelemetryService } from '@content/domain/interfaces/recommendation-telemetry-service.interface';
import type { RecommendationCandidateEvidence } from '@content/domain/interfaces/recommendation.interface';
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

function sessionFor(reels: Reel[]): RecommendationFeedSession {
  return {
    feedSessionId: '2f628c36-e32d-4b0c-8df5-c1f91087a001',
    viewerId: 'viewer-1',
    algorithmVersion: 'personalized-ranker-v2',
    generatedAt: '2026-09-11T10:00:00.000Z',
    excludedUserIds: [],
    items: reels.map((item, index) => ({
      reelId: item.id,
      primarySource: index % 2 === 0 ? 'RECENT_QUALITY' : 'TRENDING',
      sources: [index % 2 === 0 ? 'RECENT_QUALITY' : 'TRENDING'],
    })),
  };
}

function createHarness(options?: {
  cachedSession?: RecommendationFeedSession | null;
  reels?: Reel[];
  cachedReels?: Reel[];
  globalSlate?: RecommendationGlobalSlate | null;
  refillLock?: string | null;
}) {
  const reels =
    options?.reels ??
    Array.from({ length: 15 }, (_, index) =>
      reel(
        `reel-${index + 1}`,
        new Date(Date.UTC(2026, 8, 15 - index, 10)).toISOString(),
      ),
    );
  const evidence: RecommendationCandidateEvidence[] = reels.map(
    (item, index) => ({
      reelId: item.id,
      source: 'RECENT_QUALITY',
      sourceScore: Math.max(0.1, 0.9 - index * 0.03),
      reasons: ['test evidence'],
    }),
  );
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

  let storedSession = options?.cachedSession ?? null;
  const feedSessionRepository: jest.Mocked<IRecommendationFeedSessionRepository> =
    {
      get: jest.fn().mockImplementation(() => Promise.resolve(storedSession)),
      save: jest.fn().mockImplementation((session) => {
        storedSession = session;
        return Promise.resolve();
      }),
      tryAcquireRefillLock: jest
        .fn()
        .mockResolvedValue(options?.refillLock ?? null),
      releaseRefillLock: jest.fn().mockResolvedValue(undefined),
    };

  const globalSlate =
    options?.globalSlate === null
      ? null
      : (options?.globalSlate ?? {
          generatedAt: '2026-09-11T10:00:00.000Z',
          items: reels.map((item, index) => ({
            reelId: item.id,
            primarySource: index % 2 === 0 ? 'RECENT_QUALITY' : 'TRENDING',
            sources: [index % 2 === 0 ? 'RECENT_QUALITY' : 'TRENDING'],
          })),
        });
  const cachedReels = options?.cachedReels ?? reels;
  const feedCacheRepository: jest.Mocked<IRecommendationFeedCacheRepository> = {
    getGlobalSlate: jest.fn().mockResolvedValue(globalSlate),
    saveGlobalSlate: jest.fn().mockResolvedValue(undefined),
    getReels: jest
      .fn()
      .mockImplementation((ids: string[]) =>
        Promise.resolve(cachedReels.filter((item) => ids.includes(item.id))),
      ),
    saveReels: jest.fn().mockResolvedValue(undefined),
    invalidateReels: jest.fn().mockResolvedValue(undefined),
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
    getFeedSlateSize: () => 100,
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
    feedCacheRepository,
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
    feedCacheRepository,
    telemetry,
    friends,
  };
}

describe('GetRecommendedReelsUseCase Redis-first delivery', () => {
  it('serves anonymous no-session requests from the global slate without audience or heavy candidate generation', async () => {
    const harness = createHarness();

    const result = await harness.useCase.execute({
      viewerId: 'anonymous',
      limit: 2,
    });

    expect(result.items.map((item) => item.id)).toEqual(['reel-1', 'reel-2']);
    expect(result.items.map((item) => item.recommendation?.rank)).toEqual([
      1, 2,
    ]);
    expect(harness.feedCacheRepository.getGlobalSlate).toHaveBeenCalledTimes(1);
    expect(harness.friends.getFeedAudience).not.toHaveBeenCalled();
    expect(
      harness.recommendationRepository.findRecentQualityCandidates,
    ).not.toHaveBeenCalled();
    expect(
      harness.recommendationRepository.findTrendingCandidates,
    ).not.toHaveBeenCalled();
    expect(
      harness.feedSessionRepository.tryAcquireRefillLock,
    ).not.toHaveBeenCalled();
  });

  it('serves session pages entirely from cached reel entities when every entity is present', async () => {
    const reels = Array.from({ length: 15 }, (_, index) =>
      reel(
        `reel-${index + 1}`,
        new Date(Date.UTC(2026, 8, 15 - index, 10)).toISOString(),
      ),
    );
    const cachedSession = sessionFor(reels);
    const harness = createHarness({ cachedSession, reels });

    const result = await harness.useCase.execute({
      viewerId: 'viewer-1',
      feedSessionId: cachedSession.feedSessionId,
      limit: 2,
    });

    expect(result.items.map((item) => item.id)).toEqual(['reel-1', 'reel-2']);
    expect(result.nextCursor?.id).toBe('reel-2');
    expect(
      harness.recommendationRepository.findEligibleReelsByIds,
    ).not.toHaveBeenCalled();
    expect(
      harness.recommendationRepository.findRecentQualityCandidates,
    ).not.toHaveBeenCalled();
    expect(harness.friends.getFeedAudience).not.toHaveBeenCalled();
  });

  it('fills entity-cache misses from eligible DB reels and caches the misses', async () => {
    const reels = [
      reel('reel-1', '2026-09-11T10:00:00.000Z'),
      reel('reel-2', '2026-09-10T10:00:00.000Z'),
      reel('reel-3', '2026-09-09T10:00:00.000Z'),
    ];
    const cachedSession = sessionFor(reels);
    const harness = createHarness({
      cachedSession,
      reels,
      cachedReels: [reels[0]],
    });

    const result = await harness.useCase.execute({
      viewerId: 'viewer-1',
      feedSessionId: cachedSession.feedSessionId,
      limit: 2,
    });

    expect(result.items.map((item) => item.id)).toEqual(['reel-1', 'reel-2']);
    expect(
      harness.recommendationRepository.findEligibleReelsByIds,
    ).toHaveBeenCalledWith(['reel-2', 'reel-3'], []);
    expect(harness.feedCacheRepository.saveReels).toHaveBeenCalledWith(
      [reels[1], reels[2]],
      3 * 60 * 60,
    );
  });

  it('serves the global fallback before authenticated audience warm finishes', async () => {
    let resolveCandidates!: (value: RecommendationCandidateEvidence[]) => void;
    const pendingCandidates = new Promise<RecommendationCandidateEvidence[]>(
      (resolve) => {
        resolveCandidates = resolve;
      },
    );
    const harness = createHarness({ refillLock: 'lock-token' });
    harness.recommendationRepository.findRecentQualityCandidates.mockReturnValue(
      pendingCandidates,
    );

    const result = await harness.useCase.execute({
      viewerId: 'viewer-1',
      limit: 2,
    });

    expect(result.items.map((item) => item.id)).toEqual(['reel-1', 'reel-2']);
    expect(
      harness.feedSessionRepository.tryAcquireRefillLock,
    ).toHaveBeenCalledTimes(1);

    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(harness.friends.getFeedAudience).toHaveBeenCalledTimes(1);
    expect(
      harness.recommendationRepository.findRecentQualityCandidates,
    ).toHaveBeenCalledTimes(1);

    resolveCandidates([]);
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(
      harness.feedSessionRepository.releaseRefillLock,
    ).toHaveBeenCalledWith(result.feedSessionId, 'lock-token');
  });

  it('serves a recent-quality fallback when the global slate is unavailable', async () => {
    const harness = createHarness({ globalSlate: null, refillLock: null });

    const result = await harness.useCase.execute({
      viewerId: 'viewer-1',
      limit: 2,
    });

    expect(result.items.map((item) => item.id)).toEqual(['reel-1', 'reel-2']);
    expect(
      harness.recommendationRepository.findRecentQualityCandidates,
    ).toHaveBeenCalledTimes(1);
    expect(harness.friends.getFeedAudience).not.toHaveBeenCalled();
    expect(
      harness.recommendationRepository.findTrendingCandidates,
    ).not.toHaveBeenCalled();
  });

  it('filters excluded creators from authenticated cached session pages without a synchronous audience lookup', async () => {
    const reels = [
      reel('reel-1', '2026-09-11T10:00:00.000Z'),
      reel('reel-2', '2026-09-10T10:00:00.000Z'),
      reel('reel-3', '2026-09-09T10:00:00.000Z'),
    ];
    const cachedSession = {
      ...sessionFor(reels),
      excludedUserIds: [reels[0].userId],
    };
    const harness = createHarness({ cachedSession, reels });

    const result = await harness.useCase.execute({
      viewerId: 'viewer-1',
      feedSessionId: cachedSession.feedSessionId,
      limit: 2,
    });

    expect(result.items.map((item) => item.id)).toEqual(['reel-2', 'reel-3']);
    expect(harness.friends.getFeedAudience).not.toHaveBeenCalled();
    expect(
      harness.recommendationRepository.findEligibleReelsByIds,
    ).not.toHaveBeenCalled();
  });

  it('filters newly requested exclusions from an existing authenticated session', async () => {
    const reels = [
      reel('reel-1', '2026-09-11T10:00:00.000Z'),
      reel('reel-2', '2026-09-10T10:00:00.000Z'),
    ];
    const cachedSession = sessionFor(reels);
    const harness = createHarness({ cachedSession, reels });

    const result = await harness.useCase.execute({
      viewerId: 'viewer-1',
      feedSessionId: cachedSession.feedSessionId,
      excludedUserIds: [reels[0].userId],
      limit: 2,
    });

    expect(result.items.map((item) => item.id)).toEqual(['reel-2']);
  });

  it('fails closed for authenticated legacy sessions until the background audience snapshot is available', async () => {
    const reels = [
      reel('reel-1', '2026-09-11T10:00:00.000Z'),
      reel('reel-2', '2026-09-10T10:00:00.000Z'),
    ];
    const legacySession = { ...sessionFor(reels) };
    delete legacySession.excludedUserIds;
    const harness = createHarness({
      cachedSession: legacySession,
      reels,
      refillLock: null,
    });

    const result = await harness.useCase.execute({
      viewerId: 'viewer-1',
      feedSessionId: legacySession.feedSessionId,
      limit: 2,
    });

    expect(result.items).toEqual([]);
    expect(harness.feedCacheRepository.getReels).not.toHaveBeenCalled();
    expect(
      harness.feedSessionRepository.tryAcquireRefillLock,
    ).toHaveBeenCalledTimes(1);
  });

  it('fails closed when the background audience refresh cannot load exclusions', async () => {
    const reels = [
      reel('reel-1', '2026-09-11T10:00:00.000Z'),
      reel('reel-2', '2026-09-10T10:00:00.000Z'),
    ];
    const legacySession = { ...sessionFor(reels) };
    delete legacySession.excludedUserIds;
    const harness = createHarness({
      cachedSession: legacySession,
      reels,
      refillLock: 'lock-token',
    });
    harness.friends.getFeedAudience.mockRejectedValue(
      new Error('friend-service down'),
    );

    const result = await harness.useCase.execute({
      viewerId: 'viewer-1',
      feedSessionId: legacySession.feedSessionId,
      limit: 2,
    });

    expect(result.items).toEqual([]);
    expect(harness.feedCacheRepository.getReels).not.toHaveBeenCalled();

    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(
      harness.feedSessionRepository.releaseRefillLock,
    ).toHaveBeenCalledWith(legacySession.feedSessionId, 'lock-token');
  });

  it('triggers a non-blocking personalized refill when a session buffer has ten or fewer eligible items left', async () => {
    const reels = Array.from({ length: 12 }, (_, index) =>
      reel(
        `reel-${index + 1}`,
        new Date(Date.UTC(2026, 8, 15 - index, 10)).toISOString(),
      ),
    );
    const cachedSession = sessionFor(reels);
    const harness = createHarness({ cachedSession, reels });
    let resolveLock!: (value: string | null) => void;
    harness.feedSessionRepository.tryAcquireRefillLock.mockReturnValue(
      new Promise<string | null>((resolve) => {
        resolveLock = resolve;
      }),
    );

    const result = await harness.useCase.execute({
      viewerId: 'viewer-1',
      feedSessionId: cachedSession.feedSessionId,
      limit: 2,
    });

    expect(result.items).toHaveLength(2);
    expect(result.nextCursor?.id).toBe('reel-2');
    expect(
      harness.feedSessionRepository.tryAcquireRefillLock,
    ).toHaveBeenCalledTimes(1);
    expect(harness.friends.getFeedAudience).not.toHaveBeenCalled();

    resolveLock(null);
    await Promise.resolve();
  });

  it('preserves session rank and opaque cursor order on later pages', async () => {
    const reels = [
      reel('reel-1', '2026-09-11T10:00:00.000Z'),
      reel('reel-2', '2026-09-10T10:00:00.000Z'),
      reel('reel-3', '2026-09-09T10:00:00.000Z'),
    ];
    const cachedSession = sessionFor(reels);
    const harness = createHarness({ cachedSession, reels });

    const result = await harness.useCase.execute({
      viewerId: 'viewer-1',
      feedSessionId: cachedSession.feedSessionId,
      cursor: { createdAt: reels[0].createdAt, id: 'reel-1' },
      limit: 1,
    });

    expect(result.items.map((item) => item.id)).toEqual(['reel-2']);
    expect(result.items[0].recommendation?.rank).toBe(2);
    expect(result.nextCursor?.id).toBe('reel-2');
  });
});
