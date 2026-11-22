import { UserNotFoundError } from '../../domain/errors/user-not-found.error';
import { BanUserUseCase } from './ban-user.use-case';
import { UnbanUserUseCase } from './unban-user.use-case';

describe('Banning and unbanning users', () => {
  const fixture = (found = true) => {
    const repository = {
      findById: jest.fn().mockResolvedValue(found ? { id: 'user-1' } : null),
      ban: jest.fn(),
      unban: jest.fn(),
    };
    const auth = { banUser: jest.fn(), unbanUser: jest.fn() };
    return {
      repository,
      auth,
      ban: new BanUserUseCase(repository as never, auth as never),
      unban: new UnbanUserUseCase(repository as never, auth as never),
    };
  };

  it('locks the user out in auth-service before recording the ban', async () => {
    const f = fixture();
    const order: string[] = [];
    f.auth.banUser.mockImplementation(() => order.push('auth'));
    f.repository.ban.mockImplementation(() => order.push('database'));
    await expect(
      f.ban.execute({ id: 'user-1', bannedBy: 'admin-1', reason: 'spam' }),
    ).resolves.toMatchObject({ id: 'user-1', status: 'BANNED' });
    expect(order).toEqual(['auth', 'database']);
    expect(f.repository.ban).toHaveBeenCalledWith('user-1', {
      reason: 'spam',
      bannedBy: 'admin-1',
    });
  });

  it('records nothing when auth-service refuses, for example for an admin', async () => {
    const f = fixture();
    f.auth.banUser.mockRejectedValue({ statusCode: 409, message: 'admin' });
    await expect(
      f.ban.execute({ id: 'user-1', bannedBy: 'admin-1', reason: 'spam' }),
    ).rejects.toMatchObject({ statusCode: 409 });
    expect(f.repository.ban).not.toHaveBeenCalled();
  });

  it('404s for a user that does not exist', async () => {
    const f = fixture(false);
    await expect(
      f.ban.execute({ id: 'missing', bannedBy: 'admin-1', reason: 'spam' }),
    ).rejects.toBeInstanceOf(UserNotFoundError);
    expect(f.auth.banUser).not.toHaveBeenCalled();
  });

  it('unban restores the database record first and then lifts the denylist', async () => {
    const f = fixture();
    const order: string[] = [];
    f.repository.unban.mockImplementation(() => order.push('database'));
    f.auth.unbanUser.mockImplementation(() => order.push('auth'));
    await expect(f.unban.execute({ id: 'user-1' })).resolves.toMatchObject({
      status: 'ACTIVE',
    });
    expect(order).toEqual(['database', 'auth']);
  });
});
