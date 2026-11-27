import { SearchPublicUsersUseCase } from './search-public-users.use-case';

describe('SearchPublicUsersUseCase', () => {
  const build = () => {
    const userRepository = {
      searchPublicUsers: jest.fn().mockResolvedValue([]),
    };
    const friendDiscoveryService = {
      getAudience: jest
        .fn()
        .mockResolvedValue({ excludedUserIds: ['blocked-1'] }),
    };
    const useCase = new SearchPublicUsersUseCase(
      userRepository as never,
      friendDiscoveryService as never,
    );
    return { useCase, userRepository };
  };

  it('passes the username cursor through as a keyset bound', async () => {
    const { useCase, userRepository } = build();

    await useCase.execute('@an', 20, 'viewer-1', 'amy');

    expect(userRepository.searchPublicUsers).toHaveBeenCalledWith({
      query: 'an',
      limit: 20,
      excludedUserIds: ['viewer-1', 'blocked-1'],
      afterUsername: 'amy',
    });
  });

  it('starts from the first page without a cursor', async () => {
    const { useCase, userRepository } = build();

    await useCase.execute('an', 20, 'viewer-1');

    expect(userRepository.searchPublicUsers).toHaveBeenCalledWith(
      expect.not.objectContaining({ afterUsername: expect.anything() }),
    );
  });
});
