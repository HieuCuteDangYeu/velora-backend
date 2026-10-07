import { JwtService } from '@nestjs/jwt';
import { LoginUseCase } from './login.use-case';
import { GoogleLoginUseCase } from './google-login.use-case';
import { LogoutUseCase } from './logout.use-case';
import { RefreshToken } from '../../domain/entities/refresh-token.entity';

const user = {
  id: 'user-1',
  email: 'user@example.com',
  fullName: 'User One',
  username: 'user-one',
  isVerified: true,
  picture: null,
  providerId: 'google-1',
};

describe('Login rolling refresh policy', () => {
  afterEach(() => jest.useRealTimers());

  it.each(['password', 'google'])(
    '%s login issues a unique 90-day refresh JWT and a 15-minute access JWT',
    async (provider) => {
      jest.useFakeTimers({ doNotFake: ['nextTick'] });
      const now = new Date('2026-10-07T00:00:00Z');
      jest.setSystemTime(now);
      const repository = {
        getUserRole: jest.fn().mockResolvedValue(['USER']),
        createRefreshToken: jest.fn(),
      };
      const users = {
        validateUser: jest.fn().mockResolvedValue(user),
        findByEmail: jest.fn().mockResolvedValue(user),
      };
      const cache = { setUserRoles: jest.fn() };
      const jwt = new JwtService({ secret: 'unit-test-secret' });
      const tokens =
        provider === 'password'
          ? await new LoginUseCase(
              users as never,
              repository as never,
              cache as never,
              jwt,
            ).execute({ email: user.email, password: 'password' })
          : await new GoogleLoginUseCase(
              users as never,
              repository as never,
              cache as never,
              jwt,
            ).execute({
              email: user.email,
              fullName: user.fullName,
              providerId: user.providerId,
              picture: '',
            });
      const access = jwt.verify<{ exp: number; iat: number }>(
        tokens.accessToken,
      );
      const refresh = jwt.verify<{ exp: number; iat: number; jti: string }>(
        tokens.refreshToken,
      );
      expect(access.exp - access.iat).toBe(15 * 60);
      expect(refresh.exp - refresh.iat).toBe(90 * 86400);
      expect(refresh.jti).toEqual(expect.any(String));
      expect(repository.createRefreshToken).toHaveBeenCalledWith(
        user.id,
        tokens.refreshToken,
        new Date(now.getTime() + 90 * 86400000),
      );
      expect(cache.setUserRoles).toHaveBeenCalledWith(user.id, ['USER']);
    },
  );

  it('logout revokes the presented refresh token and invalidates roles', async () => {
    const repository = {
      findRefreshToken: jest
        .fn()
        .mockResolvedValue(
          new RefreshToken(
            'token-id',
            user.id,
            'refresh',
            new Date(Date.now() + 90 * 86400000),
            false,
            new Date(),
          ),
        ),
      updateRefreshToken: jest.fn(),
    };
    const cache = { invalidateUserRoles: jest.fn() };
    await expect(
      new LogoutUseCase(repository as never, cache as never).execute('refresh'),
    ).resolves.toEqual({ message: 'Logged out successfully', userId: user.id });
    expect(repository.updateRefreshToken).toHaveBeenCalledWith('token-id', {
      revoked: true,
    });
    expect(cache.invalidateUserRoles).toHaveBeenCalledWith(user.id);
  });
});
