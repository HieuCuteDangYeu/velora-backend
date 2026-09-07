import { GetRecommendedPublicUsersUseCase } from './get-recommended-public-users.use-case';

describe('GetRecommendedPublicUsersUseCase', () => {
  const graphCandidate = (
    userId: string,
    mutualFriendCount: number,
    graphScore: number,
  ) => ({
    userId,
    mutualFriendCount,
    adamicAdarScore: graphScore,
    graphScore,
    candidateSources: ['MUTUAL_FRIENDS', 'ADAMIC_ADAR'] as const,
  });

  const user = (id: string, username = id) => ({
    id,
    email: `${id}@example.com`,
    fullName: `User ${id}`,
    username,
    password: null,
    isVerified: false,
    createdAt: new Date('2026-09-01T00:00:00.000Z'),
    picture: null,
    provider: null,
    providerId: null,
  });

  const config = {
    getAlgorithmVersion: jest.fn().mockReturnValue('graph-friend-recommendation-v2'),
    getCandidateSource: jest.fn().mockReturnValue('GRAPH_TWO_HOP'),
    getFeatureFlags: jest.fn().mockReturnValue({ graphCandidates: true }),
    isTelemetryEnabled: jest.fn().mockReturnValue(true),
  };

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('preserves graph ranking after profile hydration and backfills sparse results', async () => {
    const publish = jest.fn();
    const findByIds = jest
      .fn()
      .mockResolvedValue([user('graph-a'), user('graph-b')]);
    const findRecommendedPublicUsers = jest
      .fn()
      .mockResolvedValue([user('fallback-c')]);
    const getGraphRecommendations = jest.fn().mockResolvedValue({
      candidates: [
        graphCandidate('graph-b', 5, 0.95),
        graphCandidate('graph-a', 2, 0.7),
      ],
      excludedUserIds: ['viewer', 'friend-x', 'pending-y', 'blocked-z'],
    });

    const useCase = new GetRecommendedPublicUsersUseCase(
      { findByIds, findRecommendedPublicUsers } as any,
      { getGraphRecommendations } as any,
      config as any,
      { publish } as any,
    );

    const result = await useCase.execute({
      viewerId: 'viewer',
      limit: 3,
      feedSessionId: '11111111-1111-4111-8111-111111111111',
    });

    expect(getGraphRecommendations).toHaveBeenCalledWith('viewer', 12);
    expect(findByIds).toHaveBeenCalledWith(['graph-b', 'graph-a']);
    expect(findRecommendedPublicUsers).toHaveBeenCalledWith({
      limit: 1,
      excludedUserIds: [
        'viewer',
        'friend-x',
        'pending-y',
        'blocked-z',
        'graph-b',
        'graph-a',
      ],
    });

    expect(result.map((item) => item.id)).toEqual([
      'graph-b',
      'graph-a',
      'fallback-c',
    ]);
    expect(result[0]).toMatchObject({
      id: 'graph-b',
      mutualFriendCount: 5,
      recommendation: {
        candidateSource: 'GRAPH_TWO_HOP',
        candidateSources: ['MUTUAL_FRIENDS', 'ADAMIC_ADAR'],
        rank: 1,
      },
    });
    expect(result[2]).toMatchObject({
      id: 'fallback-c',
      recommendation: {
        candidateSource: 'PUBLIC_USER_FALLBACK',
        candidateSources: ['PUBLIC_USER_FALLBACK'],
        rank: 3,
      },
    });

    expect(publish).toHaveBeenCalledWith(
      expect.objectContaining({
        recommendationType: 'USER',
        algorithmVersion: 'graph-friend-recommendation-v2',
        candidateSource: 'GRAPH_TWO_HOP_WITH_PUBLIC_FALLBACK',
        returnedItems: 3,
        outcome: 'SUCCEEDED',
      }),
    );
  });

  it('uses only the public fallback when the viewer has no two-hop candidates', async () => {
    const publish = jest.fn();
    const findByIds = jest.fn();
    const findRecommendedPublicUsers = jest
      .fn()
      .mockResolvedValue([user('fallback-a'), user('fallback-b')]);

    const useCase = new GetRecommendedPublicUsersUseCase(
      { findByIds, findRecommendedPublicUsers } as any,
      {
        getGraphRecommendations: jest.fn().mockResolvedValue({
          candidates: [],
          excludedUserIds: ['viewer', 'blocked-z'],
        }),
      } as any,
      config as any,
      { publish } as any,
    );

    const result = await useCase.execute({ viewerId: 'viewer', limit: 2 });

    expect(findByIds).not.toHaveBeenCalled();
    expect(result.map((item) => item.id)).toEqual([
      'fallback-a',
      'fallback-b',
    ]);
    expect(result.every((item) => item.mutualFriendCount === undefined)).toBe(
      true,
    );
    expect(publish).toHaveBeenCalledWith(
      expect.objectContaining({ candidateSource: 'PUBLIC_USER_FALLBACK' }),
    );
  });
});
