import { InvalidTokenError } from '@auth/domain/errors/invalid-token.error';
import { RefreshToken } from '@auth/domain/entities/refresh-token.entity';

import { RefreshTokenUseCase } from './refresh-token.use-case';

const payload = {
  sub: 'user-1',
  email: 'user@example.com',
  fullName: 'User One',
  username: 'user-one',
  isVerified: true,
};

const user = {
  id: 'user-1',
  email: 'user@example.com',
  fullName: 'User One',
  username: 'user-one',
  isVerified: true,
  picture: null,
};

const createUseCase = () => {
  const authRepository = {
    findRefreshToken: jest.fn(),
    updateRefreshToken: jest.fn(),
    revokeAllUserTokens: jest.fn(),
    getUserRole: jest.fn(),
    createRefreshToken: jest.fn(),
  };
  const userService = {
    findById: jest.fn(),
  };
  const roleCache = {
    setUserRoles: jest.fn(),
  };
  const jwtService = {
    verifyAsync: jest.fn(),
    signAsync: jest.fn(),
  };

  return {
    authRepository,
    jwtService,
    roleCache,
    userService,
    useCase: new RefreshTokenUseCase(
      authRepository as never,
      userService as never,
      roleCache as never,
      jwtService as never,
    ),
  };
};

describe('RefreshTokenUseCase', () => {
  it('rotates a valid refresh token and persists the replacement', async () => {
    const { authRepository, jwtService, roleCache, userService, useCase } =
      createUseCase();
    const incomingRefreshToken = 'incoming-refresh-token';
    const storedToken = new RefreshToken(
      'stored-token-1',
      'user-1',
      incomingRefreshToken,
      new Date(Date.now() + 60_000),
      false,
      new Date(),
    );

    jwtService.verifyAsync.mockResolvedValue(payload);
    authRepository.findRefreshToken.mockResolvedValue(storedToken);
    authRepository.getUserRole.mockResolvedValue(['USER']);
    authRepository.updateRefreshToken.mockResolvedValue(undefined);
    authRepository.createRefreshToken.mockResolvedValue(undefined);
    roleCache.setUserRoles.mockResolvedValue(undefined);
    userService.findById.mockResolvedValue(user);
    jwtService.signAsync
      .mockResolvedValueOnce('new-access-token')
      .mockResolvedValueOnce('new-refresh-token');

    await expect(useCase.execute(incomingRefreshToken)).resolves.toEqual({
      accessToken: 'new-access-token',
      refreshToken: 'new-refresh-token',
    });

    expect(jwtService.verifyAsync).toHaveBeenCalledWith(incomingRefreshToken);
    expect(authRepository.findRefreshToken).toHaveBeenCalledWith(
      incomingRefreshToken,
    );
    expect(authRepository.updateRefreshToken).toHaveBeenCalledWith(
      'stored-token-1',
      { revoked: true },
    );
    expect(authRepository.createRefreshToken).toHaveBeenCalledWith(
      'user-1',
      'new-refresh-token',
      expect.any(Date),
    );
  });

  it('revokes all user tokens when the presented token was already revoked', async () => {
    const { authRepository, jwtService, useCase } = createUseCase();
    const storedToken = new RefreshToken(
      'stored-token-1',
      'user-1',
      'revoked-refresh-token',
      new Date(Date.now() + 60_000),
      true,
      new Date(),
    );
    jwtService.verifyAsync.mockResolvedValue(payload);
    authRepository.findRefreshToken.mockResolvedValue(storedToken);
    authRepository.revokeAllUserTokens.mockResolvedValue(undefined);

    await expect(
      useCase.execute('revoked-refresh-token'),
    ).rejects.toBeInstanceOf(InvalidTokenError);

    expect(authRepository.revokeAllUserTokens).toHaveBeenCalledWith('user-1');
    expect(authRepository.updateRefreshToken).not.toHaveBeenCalled();
    expect(authRepository.createRefreshToken).not.toHaveBeenCalled();
  });

  it('rejects an expired persisted token without rotating it', async () => {
    const { authRepository, jwtService, useCase } = createUseCase();
    const storedToken = new RefreshToken(
      'stored-token-1',
      'user-1',
      'expired-refresh-token',
      new Date(Date.now() - 60_000),
      false,
      new Date(),
    );
    jwtService.verifyAsync.mockResolvedValue(payload);
    authRepository.findRefreshToken.mockResolvedValue(storedToken);

    await expect(
      useCase.execute('expired-refresh-token'),
    ).rejects.toBeInstanceOf(InvalidTokenError);

    expect(authRepository.updateRefreshToken).not.toHaveBeenCalled();
    expect(authRepository.createRefreshToken).not.toHaveBeenCalled();
  });

  it('rejects a token that fails JWT verification', async () => {
    const { authRepository, jwtService, useCase } = createUseCase();
    jwtService.verifyAsync.mockRejectedValue(new Error('invalid signature'));

    await expect(
      useCase.execute('invalid-refresh-token'),
    ).rejects.toBeInstanceOf(InvalidTokenError);

    expect(authRepository.findRefreshToken).not.toHaveBeenCalled();
    expect(authRepository.revokeAllUserTokens).not.toHaveBeenCalled();
  });
});
