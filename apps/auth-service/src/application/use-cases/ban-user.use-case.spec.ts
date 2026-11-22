import { BanUserUseCase } from './ban-user.use-case';
import { UnbanUserUseCase } from './unban-user.use-case';

describe('Banning a user', () => {
  const fixture = (roles: string[]) => {
    const repository = {
      getUserRole: jest.fn().mockResolvedValue(roles),
      revokeAllUserTokens: jest.fn(),
    };
    const banList = { ban: jest.fn(), unban: jest.fn() };
    const users = { invalidateCachedUser: jest.fn() };
    return {
      repository,
      banList,
      users,
      ban: new BanUserUseCase(
        repository as never,
        banList as never,
        users as never,
      ),
      unban: new UnbanUserUseCase(banList as never, users as never),
    };
  };

  it('denylists the user, revokes every refresh token and drops the cached identity', async () => {
    const f = fixture(['USER']);
    await f.ban.execute('user-1');
    expect(f.banList.ban).toHaveBeenCalledWith('user-1');
    expect(f.repository.revokeAllUserTokens).toHaveBeenCalledWith('user-1');
    expect(f.users.invalidateCachedUser).toHaveBeenCalledWith('user-1');
  });

  it('refuses to ban an admin and changes nothing', async () => {
    const f = fixture(['USER', 'ADMIN']);
    await expect(f.ban.execute('admin-1')).rejects.toMatchObject({
      error: { statusCode: 409 },
    });
    expect(f.banList.ban).not.toHaveBeenCalled();
    expect(f.repository.revokeAllUserTokens).not.toHaveBeenCalled();
  });

  it('stops before revoking sessions if the denylist write fails, so the admin can retry', async () => {
    const f = fixture(['USER']);
    f.banList.ban.mockRejectedValue(new Error('redis down'));
    await expect(f.ban.execute('user-1')).rejects.toThrow('redis down');
    expect(f.repository.revokeAllUserTokens).not.toHaveBeenCalled();
  });

  it('unban lifts the denylist and drops the cached identity', async () => {
    const f = fixture(['USER']);
    await f.unban.execute('user-1');
    expect(f.banList.unban).toHaveBeenCalledWith('user-1');
    expect(f.users.invalidateCachedUser).toHaveBeenCalledWith('user-1');
  });
});
