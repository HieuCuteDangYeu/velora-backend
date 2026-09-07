import type { IFriendGraphRepository } from '@friend/domain/interfaces/friend-graph.repository.interface';
import type { IUserBlockRepository } from '@friend/domain/interfaces/user-block.repository.interface';
import { GetGraphFriendRecommendationsUseCase } from './get-graph-friend-recommendations.use-case';

const createGraphRepository = (
  overrides: Partial<IFriendGraphRepository> = {},
): IFriendGraphRepository => ({
  findTwoHopCandidates: jest.fn().mockResolvedValue([]),
  listRelationshipUserIds: jest.fn().mockResolvedValue([]),
  ...overrides,
});

const createBlockRepository = (
  excludedUserIds: string[] = [],
): IUserBlockRepository => ({
  blockAndRemoveRelationship: jest.fn(),
  unblock: jest.fn(),
  isBlockedBetween: jest.fn(),
  listExcludedUserIds: jest.fn().mockResolvedValue(excludedUserIds),
  listBlocked: jest.fn(),
});

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
    const graphRepository = createGraphRepository({
      findTwoHopCandidates,
      listRelationshipUserIds: jest.fn().mockResolvedValue(['pending-user']),
    });
    const blockRepository = createBlockRepository(['blocked-user']);

    const useCase = new GetGraphFriendRecommendationsUseCase(
      graphRepository,
      blockRepository,
    );

    const result = await useCase.execute('viewer', 2);

    expect(findTwoHopCandidates).toHaveBeenCalledWith('viewer');
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
    const graphRepository = createGraphRepository({
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
    });

    const useCase = new GetGraphFriendRecommendationsUseCase(
      graphRepository,
      createBlockRepository(),
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

  it('sorts using full precision before rounding serialized scores', async () => {
    const graphRepository = createGraphRepository({
      findTwoHopCandidates: jest.fn().mockResolvedValue([
        {
          userId: 'a-weaker',
          mutualFriendCount: 2,
          adamicAdarScore: 0.9999995,
        },
        {
          userId: 'z-stronger',
          mutualFriendCount: 2,
          adamicAdarScore: 1,
        },
      ]),
    });

    const useCase = new GetGraphFriendRecommendationsUseCase(
      graphRepository,
      createBlockRepository(),
    );

    const result = await useCase.execute('viewer', 2);

    expect(result.candidates.map((candidate) => candidate.userId)).toEqual([
      'z-stronger',
      'a-weaker',
    ]);
    expect(result.candidates[0].graphScore).toBe(1);
    expect(result.candidates[1].graphScore).toBe(1);
  });
});
