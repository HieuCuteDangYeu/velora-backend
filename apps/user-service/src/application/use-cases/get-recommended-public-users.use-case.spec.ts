import type { FriendGraphRecommendationCandidate } from '@common/friend/interfaces/friend-recommendation.interface';
import { User } from '@user/domain/entities/user.entity';
import type { IFriendDiscoveryService } from '@user/domain/interfaces/friend-discovery.service.interface';
import type { IRecommendationConfig } from '@user/domain/interfaces/recommendation-config.interface';
import type { IRecommendationTelemetryService } from '@user/domain/interfaces/recommendation-telemetry-service.interface';
import type { IUserRepository } from '@user/domain/interfaces/user.repository.interface';
import { GetRecommendedPublicUsersUseCase } from './get-recommended-public-users.use-case';

const graphCandidate = (
  userId: string,
  mutualFriendCount: number,
  graphScore: number,
): FriendGraphRecommendationCandidate => ({
  userId,
  mutualFriendCount,
  adamicAdarScore: graphScore,
  graphScore,
  candidateSources: ['MUTUAL_FRIENDS', 'ADAMIC_ADAR'],
});

const user = (id: string, username = id): User =>
  new User(
    id,
    `${id}@example.com`,
    `User ${id}`,
    username,
    null,
    false,
    new Date('2026-09-01T00:00:00.000Z'),
    null,
    null,
    null,
  );

const createUserRepository = (
  overrides: Partial<IUserRepository> = {},
): IUserRepository => ({
  save: jest.fn(),
  findByEmail: jest.fn(),
  findById: jest.fn(),
  findByUsername: jest.fn(),
  findByIds: jest.fn().mockResolvedValue([]),
  findAll: jest.fn(),
  searchPublicUsers: jest.fn(),
  findRecommendedPublicUsers: jest.fn().mockResolvedValue([]),
  isUsernameAvailable: jest.fn(),
  update: jest.fn(),
  delete: jest.fn(),
  countUsersByIds: jest.fn(),
  ...overrides,
});

const createFriendDiscoveryService = (
  overrides: Partial<IFriendDiscoveryService> = {},
): IFriendDiscoveryService => ({
  getAudience: jest.fn(),
  getGraphRecommendations: jest.fn().mockResolvedValue({
    candidates: [],
    excludedUserIds: ['viewer'],
  }),
  ...overrides,
});

const config: IRecommendationConfig = {
  getAlgorithmVersion: jest
    .fn()
    .mockReturnValue('graph-friend-recommendation-v2'),
  getCandidateSource: jest.fn().mockReturnValue('GRAPH_TWO_HOP'),
  getFeatureFlags: jest.fn().mockReturnValue({ graphCandidates: true }),
  isTelemetryEnabled: jest.fn().mockReturnValue(true),
};

const createTelemetryService = (
  publish: jest.Mock = jest.fn(),
): IRecommendationTelemetryService => ({ publish });

describe('GetRecommendedPublicUsersUseCase', () => {
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
      createUserRepository({ findByIds, findRecommendedPublicUsers }),
      createFriendDiscoveryService({ getGraphRecommendations }),
      config,
      createTelemetryService(publish),
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

  it('fails closed before fallback when graph recommendation validation fails', async () => {
    const findByIds = jest.fn();
    const findRecommendedPublicUsers = jest.fn();
    const getGraphRecommendations = jest
      .fn()
      .mockRejectedValue(new Error('Invalid graph friend recommendation response'));

    const useCase = new GetRecommendedPublicUsersUseCase(
      createUserRepository({ findByIds, findRecommendedPublicUsers }),
      createFriendDiscoveryService({ getGraphRecommendations }),
      config,
      createTelemetryService(),
    );

    await expect(
      useCase.execute({ viewerId: 'viewer', limit: 20 }),
    ).rejects.toThrow('Invalid graph friend recommendation response');

    expect(findByIds).not.toHaveBeenCalled();
    expect(findRecommendedPublicUsers).not.toHaveBeenCalled();
  });

  it('uses only the public fallback when the viewer has no two-hop candidates', async () => {
    const publish = jest.fn();
    const findByIds = jest.fn();
    const findRecommendedPublicUsers = jest
      .fn()
      .mockResolvedValue([user('fallback-a'), user('fallback-b')]);

    const useCase = new GetRecommendedPublicUsersUseCase(
      createUserRepository({ findByIds, findRecommendedPublicUsers }),
      createFriendDiscoveryService({
        getGraphRecommendations: jest.fn().mockResolvedValue({
          candidates: [],
          excludedUserIds: ['viewer', 'blocked-z'],
        }),
      }),
      config,
      createTelemetryService(publish),
    );

    const result = await useCase.execute({ viewerId: 'viewer', limit: 2 });

    expect(findByIds).not.toHaveBeenCalled();
    expect(result.map((item) => item.id)).toEqual(['fallback-a', 'fallback-b']);
    expect(result.every((item) => item.mutualFriendCount === undefined)).toBe(
      true,
    );
    expect(publish).toHaveBeenCalledWith(
      expect.objectContaining({ candidateSource: 'PUBLIC_USER_FALLBACK' }),
    );
  });

  it('skips missing graph profiles and backfills the remaining slot', async () => {
    const findRecommendedPublicUsers = jest
      .fn()
      .mockResolvedValue([user('fallback-a')]);

    const useCase = new GetRecommendedPublicUsersUseCase(
      createUserRepository({
        findByIds: jest.fn().mockResolvedValue([user('graph-a')]),
        findRecommendedPublicUsers,
      }),
      createFriendDiscoveryService({
        getGraphRecommendations: jest.fn().mockResolvedValue({
          candidates: [
            graphCandidate('graph-a', 3, 0.9),
            graphCandidate('deleted-user', 2, 0.8),
          ],
          excludedUserIds: ['viewer'],
        }),
      }),
      config,
      createTelemetryService(),
    );

    const result = await useCase.execute({ viewerId: 'viewer', limit: 2 });

    expect(result.map((item) => item.id)).toEqual(['graph-a', 'fallback-a']);
    expect(findRecommendedPublicUsers).toHaveBeenCalledWith({
      limit: 1,
      excludedUserIds: ['viewer', 'graph-a', 'deleted-user'],
    });
  });

  it('clamps the public endpoint limit to 30', async () => {
    const getGraphRecommendations = jest.fn().mockResolvedValue({
      candidates: [],
      excludedUserIds: ['viewer'],
    });
    const findRecommendedPublicUsers = jest.fn().mockResolvedValue([]);

    const useCase = new GetRecommendedPublicUsersUseCase(
      createUserRepository({ findRecommendedPublicUsers }),
      createFriendDiscoveryService({ getGraphRecommendations }),
      config,
      createTelemetryService(),
    );

    await useCase.execute({ viewerId: 'viewer', limit: 100 });

    expect(getGraphRecommendations).toHaveBeenCalledWith('viewer', 100);
    expect(findRecommendedPublicUsers).toHaveBeenCalledWith({
      limit: 30,
      excludedUserIds: ['viewer'],
    });
  });
});
