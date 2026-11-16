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
