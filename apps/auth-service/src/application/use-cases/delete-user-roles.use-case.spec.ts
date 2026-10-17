import { DeleteUserRolesUseCase } from './delete-user-roles.use-case';

describe('DeleteUserRolesUseCase', () => {
  it('evicts the cached user so a deleted user stops authenticating, then removes roles', async () => {
    const calls: string[] = [];
    const repository = {
      rollbackRoles: jest.fn(() => {
        calls.push('roles');
        return Promise.resolve();
      }),
    };
    const users = {
      invalidateCachedUser: jest.fn(() => {
        calls.push('cache');
        return Promise.resolve();
      }),
    };

    await new DeleteUserRolesUseCase(
      repository as never,
      users as never,
    ).execute('u1');

    expect(users.invalidateCachedUser).toHaveBeenCalledWith('u1');
    expect(repository.rollbackRoles).toHaveBeenCalledWith('u1');
    expect(calls).toEqual(['cache', 'roles']);
  });
});
