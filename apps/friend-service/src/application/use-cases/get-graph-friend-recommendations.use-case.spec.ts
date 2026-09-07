import { GetGraphFriendRecommendationsUseCase } from './get-graph-friend-recommendations.use-case';

describe('GetGraphFriendRecommendationsUseCase', () => {
  it('filters existing relationships and blocks before ranking two-hop candidates', async () => {
    const findTwoHopCandidates = jest.fn().mockResolvedValue([
      {
        userId: 'candidate-a',
        mutualFriendCount: 3,
        adamicAdarScore: 1.2,
      },
      {
        userId: 'candidate-b',
        mutualFriendCount: 1,
        adamicAdarScore: 0.8,
      },
      {
        userId: 'pending-user',
        mutualFriendCount: 5,
        adamicAdarScore: 2,
      },
      {
        userId: 'blocked-user',
        mutualFriendCount: 6,
        adamicAdarScore: 3,
      },
    ]);
    const listRelationshipUserIds = jest
      .fn()
      .mockResolvedValue(['pending-user']);
    const listExcludedUserIds = jest.fn().mockResolvedValue(['blocked-user']);

    const useCase = new GetGraphFriendRecommendationsUseCase(
      {
        findTwoHopCandidates,
        listRelationshipUserIds,
      } as any,
      { listExcludedUserIds } as any,
    );

    const result = await useCase.execute('viewer', 2);

    expect(findTwoHopCandidates).toHaveBeenCalledWith('viewer', 50);
    expect(result.excludedUserIds).toEqual([
      'viewer',
      'pending-user',
      'blocked-user',
    ]);
    expect(result.candidates.map((candidate) => candidate.userId)).toEqual([
      'candidate-a',
      'candidate-b',
    ]);
    expect(result.candidates[0]).toMatchObject({
      mutualFriendCount: 3,
      candidateSources: ['MUTUAL_FRIENDS', 'ADAMIC_ADAR'],
    });
    expect(result.candidates[0].graphScore).toBeGreaterThan(
      result.candidates[1].graphScore,
    );
  });

  it('uses Adamic-Adar to penalize candidates connected through high-degree mutuals', async () => {
    const useCase = new GetGraphFriendRecommendationsUseCase(
      {
        findTwoHopCandidates: jest.fn().mockResolvedValue([
          {
            userId: 'strong-neighborhood',
            mutualFriendCount: 2,
            adamicAdarScore: 1,
          },
          {
            userId: 'weak-neighborhood',
            mutualFriendCount: 2,
            adamicAdarScore: 0.2,
          },
        ]),
        listRelationshipUserIds: jest.fn().mockResolvedValue([]),
      } as any,
      { listExcludedUserIds: jest.fn().mockResolvedValue([]) } as any,
    );

    const result = await useCase.execute('viewer', 20);

    expect(result.candidates.map((candidate) => candidate.userId)).toEqual([
      'strong-neighborhood',
      'weak-neighborhood',
    ]);
    expect(result.candidates[0].graphScore).toBeGreaterThan(
      result.candidates[1].graphScore,
    );
  });
});
