import { RecommendationRepository } from './recommendation.repository';

const event = {
  eventType: 'COMPLETE',
  percentageWatched: 100,
  completed: true,
  replayed: false,
  skipped: false,
  reel: { userId: 'creator-1', tags: ['pets'] },
};

function createRepository(findMany: jest.Mock) {
  return new RecommendationRepository({
    reelViewEvent: { findMany },
    reel: { findMany: jest.fn().mockResolvedValue([]) },
  } as never);
}

describe('RecommendationRepository positive profile sharing', () => {
  it('reads the viewer profile once for tag, creator and interest-tag lookups in one refill', async () => {
    const findMany = jest.fn().mockResolvedValue([event]);
    const repository = createRepository(findMany);
    const query = {
      viewerId: 'viewer-1',
      limit: 20,
      excludedUserIds: [],
      excludedReelIds: [],
      friendUserIds: [],
    };

    const [, , tags] = await Promise.all([
      repository.findTagAffinityCandidates(query),
      repository.findCreatorAffinityCandidates(query),
      repository.findViewerInterestTags('viewer-1', 20),
    ]);

    expect(tags).toEqual(['pets']);
    expect(findMany).toHaveBeenCalledTimes(1);
  });

  it('keeps profiles of different viewers apart', async () => {
    const findMany = jest.fn().mockResolvedValue([event]);
    const repository = createRepository(findMany);

    await repository.findViewerInterestTags('viewer-1', 20);
    await repository.findViewerInterestTags('viewer-2', 20);

    expect(findMany).toHaveBeenCalledTimes(2);
  });

  it('does not cache a failed read', async () => {
    const findMany = jest
      .fn()
      .mockRejectedValueOnce(new Error('pool timeout'))
      .mockResolvedValue([event]);
    const repository = createRepository(findMany);

    await expect(
      repository.findViewerInterestTags('viewer-1', 20),
    ).rejects.toThrow('pool timeout');
    await expect(
      repository.findViewerInterestTags('viewer-1', 20),
    ).resolves.toEqual(['pets']);
    expect(findMany).toHaveBeenCalledTimes(2);
  });
});

describe('RecommendationRepository trending scan sharing', () => {
  const trendingEvent = (reelId: string, count: number) =>
    Array.from({ length: count }, () => ({
      reelId,
      eventType: 'WATCH_END',
      watchMs: 5000,
      percentageWatched: 100,
      completed: true,
      replayed: false,
      skipped: false,
    }));
  const query = (excludedReelIds: string[]) => ({
    viewerId: 'viewer-1',
    limit: 20,
    excludedUserIds: [],
    excludedReelIds,
    friendUserIds: [],
  });

  function trendingRepository() {
    const eventFindMany = jest
      .fn()
      .mockResolvedValue([
        ...trendingEvent('reel-a', 3),
        ...trendingEvent('reel-b', 2),
      ]);
    const reelFindMany = jest
      .fn()
      .mockImplementation(
        ({ where }: { where: { AND: Array<{ id?: { in: string[] } }> } }) =>
          Promise.resolve((where.AND[1].id?.in ?? []).map((id) => ({ id }))),
      );
    const repository = new RecommendationRepository({
      reelViewEvent: { findMany: eventFindMany },
      reel: { findMany: reelFindMany },
    } as never);
    return { repository, eventFindMany };
  }

  it('reads the view events once for back-to-back refills of different viewers', async () => {
    const { repository, eventFindMany } = trendingRepository();

    await Promise.all([
      repository.findTrendingCandidates(query([])),
      repository.findTrendingCandidates({ ...query([]), viewerId: 'viewer-2' }),
    ]);
    await repository.findTrendingCandidates(query([]));

    expect(eventFindMany).toHaveBeenCalledTimes(1);
  });

  it('still removes the reels already in the caller session after the shared scan', async () => {
    const { repository } = trendingRepository();

    const fresh = await repository.findTrendingCandidates(query([]));
    const withSession = await repository.findTrendingCandidates(
      query(['reel-a']),
    );

    expect(fresh.map((candidate) => candidate.reelId).sort()).toEqual([
      'reel-a',
      'reel-b',
    ]);
    expect(withSession.map((candidate) => candidate.reelId)).toEqual([
      'reel-b',
    ]);
  });
});

describe('RecommendationRepository engagement sharing', () => {
  function snapshotRepository() {
    const findMany = jest.fn().mockResolvedValue([]);
    const repository = new RecommendationRepository({
      reelViewEvent: { findMany },
      reel: { findMany: jest.fn().mockResolvedValue([]) },
    } as never);
    const engagementCalls = () =>
      findMany.mock.calls.filter(
        ([args]) =>
          args.where.reelId !== undefined && args.where.userId === undefined,
      ).length;
    return { repository, engagementCalls };
  }
  const request = (viewerId: string, reelIds: string[]) => ({
    viewerId,
    reelIds,
    feedSessionId: '2f628c36-e32d-4b0c-8df5-c1f91087a001',
  });

  it('reads one week of engagement once for viewers whose candidates are the same reels', async () => {
    const { repository, engagementCalls } = snapshotRepository();

    await Promise.all([
      repository.loadRankingSnapshot(request('viewer-1', ['a', 'b', 'c'])),
      repository.loadRankingSnapshot(request('viewer-2', ['c', 'b', 'a'])),
    ]);
    await repository.loadRankingSnapshot(request('viewer-3', ['a', 'b', 'c']));

    expect(engagementCalls()).toBe(1);
  });

  it('reads engagement again for a different set of reels', async () => {
    const { repository, engagementCalls } = snapshotRepository();

    await repository.loadRankingSnapshot(request('viewer-1', ['a', 'b']));
    await repository.loadRankingSnapshot(request('viewer-1', ['a', 'b', 'c']));

    expect(engagementCalls()).toBe(2);
  });
});

describe('RecommendationRepository relation loading', () => {
  it('loads the series of eligible reels in the same statement, not a second round trip', async () => {
    const findMany = jest.fn().mockResolvedValue([]);
    const repository = new RecommendationRepository({
      reel: { findMany },
    } as never);

    await repository.findEligibleReelsByIds(['a', 'b'], []);

    expect(findMany).toHaveBeenCalledWith(
      expect.objectContaining({ relationLoadStrategy: 'join' }),
    );
  });
});
