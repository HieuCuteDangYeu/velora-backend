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
    recoverRotatedRefreshToken: jest.fn(),
    updateRefreshToken: jest.fn(),
    rotateRefreshToken: jest.fn(),
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
    authRepository.rotateRefreshToken.mockResolvedValue({
      token: new RefreshToken(
        'new-token-1',
        'user-1',
        'new-token-hash',
        new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
        false,
        new Date(),
      ),
      refreshToken: 'new-refresh-token',
    });
    roleCache.setUserRoles.mockResolvedValue(undefined);
    userService.findById.mockResolvedValue(user);
    jwtService.signAsync
      .mockResolvedValueOnce('new-access-token')
      .mockResolvedValueOnce('new-refresh-token');

    await expect(
      useCase.execute(incomingRefreshToken, 'request-1'),
    ).resolves.toEqual({
      accessToken: 'new-access-token',
      refreshToken: 'new-refresh-token',
    });

    expect(jwtService.verifyAsync).toHaveBeenCalledWith(incomingRefreshToken);
    expect(authRepository.findRefreshToken).toHaveBeenCalledWith(
      incomingRefreshToken,
    );
    expect(authRepository.updateRefreshToken).not.toHaveBeenCalled();
    expect(authRepository.rotateRefreshToken).toHaveBeenCalledWith(
      'stored-token-1',
      'new-refresh-token',
      expect.any(Date),
      expect.any(Date),
      'request-1',
    );
  });

  it('caps refresh-token lifetime at the absolute session expiry', async () => {
    const { authRepository, jwtService, roleCache, userService, useCase } =
      createUseCase();
    const absoluteExpiresAt = new Date(Date.now() + 120_000);
    const storedToken = new RefreshToken(
      'stored-token-1',
      'user-1',
      'incoming-refresh-token',
      new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
      false,
      new Date(),
      null,
      null,
      null,
      absoluteExpiresAt,
    );

    jwtService.verifyAsync.mockResolvedValue(payload);
    authRepository.findRefreshToken.mockResolvedValue(storedToken);
    authRepository.getUserRole.mockResolvedValue(['USER']);
    authRepository.rotateRefreshToken.mockResolvedValue({
      token: storedToken,
      refreshToken: 'new-refresh-token',
    });
    roleCache.setUserRoles.mockResolvedValue(undefined);
    userService.findById.mockResolvedValue(user);
    jwtService.signAsync
      .mockResolvedValueOnce('new-access-token')
      .mockResolvedValueOnce('new-refresh-token');

    await useCase.execute('incoming-refresh-token', 'request-1');

    const refreshSignOptions = jwtService.signAsync.mock.calls[1][1];
    expect(refreshSignOptions.expiresIn).toBeGreaterThanOrEqual(119);
    expect(refreshSignOptions.expiresIn).toBeLessThanOrEqual(120);
  });

  it('recovers a rotated token when the request ID is retried', async () => {
    const { authRepository, jwtService, userService, useCase } =
      createUseCase();
    const incomingRefreshToken = 'stale-refresh-token';
    const storedToken = new RefreshToken(
      'stored-token-1',
      'user-1',
      incomingRefreshToken,
      new Date(Date.now() + 60_000),
      true,
      new Date(),
      'replacement-token-1',
      'request-1',
      new Date(),
    );

    jwtService.verifyAsync.mockResolvedValue(payload);
    authRepository.findRefreshToken.mockResolvedValue(storedToken);
    authRepository.recoverRotatedRefreshToken.mockResolvedValue(
      'replacement-refresh-token',
    );
    userService.findById.mockResolvedValue(user);
    jwtService.signAsync.mockResolvedValue('recovered-access-token');

    await expect(
      useCase.execute(incomingRefreshToken, 'request-1'),
    ).resolves.toEqual({
      accessToken: 'recovered-access-token',
      refreshToken: 'replacement-refresh-token',
    });

    expect(authRepository.revokeAllUserTokens).not.toHaveBeenCalled();
    expect(authRepository.rotateRefreshToken).not.toHaveBeenCalled();
    expect(authRepository.recoverRotatedRefreshToken).toHaveBeenCalledWith(
      'stored-token-1',
      'request-1',
    );
  });

  it('revokes all user tokens when a replay uses a different request ID', async () => {
    const { authRepository, jwtService, useCase } = createUseCase();
    const storedToken = new RefreshToken(
      'stored-token-1',
      'user-1',
      'stale-refresh-token',
      new Date(Date.now() + 60_000),
      true,
      new Date(),
      'replacement-token-1',
      'request-1',
      new Date(),
    );

    jwtService.verifyAsync.mockResolvedValue(payload);
    authRepository.findRefreshToken.mockResolvedValue(storedToken);
    authRepository.recoverRotatedRefreshToken.mockResolvedValue(null);
    authRepository.revokeAllUserTokens.mockResolvedValue(undefined);

    await expect(
      useCase.execute('stale-refresh-token', 'request-2'),
    ).rejects.toBeInstanceOf(InvalidTokenError);

    expect(authRepository.revokeAllUserTokens).toHaveBeenCalledWith('user-1');
    expect(authRepository.rotateRefreshToken).not.toHaveBeenCalled();
  });

  it('revokes all user tokens when the presented token was already revoked without a replacement', async () => {
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
    expect(authRepository.rotateRefreshToken).not.toHaveBeenCalled();
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
    expect(authRepository.rotateRefreshToken).not.toHaveBeenCalled();
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
