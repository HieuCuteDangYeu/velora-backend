import { GetReelFeedAudienceUseCase } from './get-reel-feed-audience.use-case';

describe('GetReelFeedAudienceUseCase', () => {
  const create = (ids: {
    friendUserIds: string[];
    blockRelatedUserIds: string[];
  }) => {
    const friendRepository = {
      listReelFeedAudienceIds: jest.fn().mockResolvedValue(ids),
    };
    return {
      friendRepository,
      useCase: new GetReelFeedAudienceUseCase(friendRepository as never),
    };
  };

  it('returns friends and blocked users from one repository read', async () => {
    const { useCase, friendRepository } = create({
      friendUserIds: ['f1', 'f2'],
      blockRelatedUserIds: ['b1'],
    });

    await expect(useCase.execute('viewer')).resolves.toEqual({
      friendUserIds: ['f1', 'f2'],
      excludedUserIds: ['b1'],
    });
    expect(friendRepository.listReelFeedAudienceIds).toHaveBeenCalledTimes(1);
    expect(friendRepository.listReelFeedAudienceIds).toHaveBeenCalledWith(
      'viewer',
    );
  });

  it('drops a friend who is also blocked or blocking from the friend list', async () => {
    const { useCase } = create({
      friendUserIds: ['f1', 'f2', 'f3'],
      blockRelatedUserIds: ['f2'],
    });

    await expect(useCase.execute('viewer')).resolves.toEqual({
      friendUserIds: ['f1', 'f3'],
      excludedUserIds: ['f2'],
    });
  });

  it('returns empty lists for a user with no friends or blocks', async () => {
    const { useCase } = create({ friendUserIds: [], blockRelatedUserIds: [] });

    await expect(useCase.execute('viewer')).resolves.toEqual({
      friendUserIds: [],
      excludedUserIds: [],
    });
  });
});
