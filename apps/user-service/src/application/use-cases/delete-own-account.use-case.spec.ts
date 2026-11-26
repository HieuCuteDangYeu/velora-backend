import { UserNotFoundError } from '../../domain/errors/user-not-found.error';
import { DeleteOwnAccountUseCase } from './delete-own-account.use-case';

describe('DeleteOwnAccountUseCase', () => {
  const setup = (user: object | null = { id: 'user-1' }) => {
    const calls: string[] = [];
    const repository = {
      findById: jest.fn().mockResolvedValue(user),
      eraseDeletedAccount: jest.fn().mockImplementation(() => {
        calls.push('erase');
        return Promise.resolve(user);
      }),
    };
    const authService = {
      banUser: jest.fn().mockImplementation(() => {
        calls.push('ban');
        return Promise.resolve();
      }),
    };
    const useCase = new DeleteOwnAccountUseCase(
      repository as never,
      authService as never,
    );
    return { calls, repository, authService, useCase };
  };

  it('ends the sessions first, then erases the profile', async () => {
    const { calls, repository, authService, useCase } = setup();

    await expect(useCase.execute({ userId: 'user-1' })).resolves.toEqual({
      id: 'user-1',
      message: 'Account deleted',
    });
    expect(authService.banUser).toHaveBeenCalledWith('user-1');
    expect(repository.eraseDeletedAccount).toHaveBeenCalledWith('user-1');
    expect(calls).toEqual(['ban', 'erase']);
  });

  it('leaves the profile untouched when sessions cannot be ended', async () => {
    const { authService, repository, useCase } = setup();
    authService.banUser.mockRejectedValue(new Error('auth down'));

    await expect(useCase.execute({ userId: 'user-1' })).rejects.toThrow(
      'auth down',
    );
    expect(repository.eraseDeletedAccount).not.toHaveBeenCalled();
  });

  it('rejects an unknown account', async () => {
    const { useCase } = setup(null);

    await expect(useCase.execute({ userId: 'missing' })).rejects.toBeInstanceOf(
      UserNotFoundError,
    );
  });
});
