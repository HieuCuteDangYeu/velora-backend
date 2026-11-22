import { Logger } from '@nestjs/common';
import { NEVER, of, throwError } from 'rxjs';
import { InvalidTokenError } from '../../domain/errors/invalid-token.error';
import { AccessTokenService } from '../../infrastructure/security/access-token.service';
import { UserServiceAdapter } from '../../infrastructure/adapters/user-service.adapter';
import { AuthController } from '../../infrastructure/controllers/auth.controller';
import { VerifyTokenUseCase } from './verify-token.use-case';

describe('Token verification failure classification', () => {
  afterEach(() => {
    jest.useRealTimers();
    jest.restoreAllMocks();
  });
  const SECRET = 'unit-test-secret-with-at-least-32-chars';
  const fixture = () => {
    const jwt = {
      verifyAsync: jest
        .fn()
        .mockResolvedValue({ sub: 'user-1', tokenType: 'access' }),
    };
    const users = {
      findByIdForAuth: jest.fn().mockResolvedValue({ id: 'user-1' }),
    };
    const banList = { isBanned: jest.fn().mockResolvedValue(false) };
    const accessTokens = new AccessTokenService({
      getOrThrow: () => SECRET,
    } as never);
    const repository = { getUserRole: jest.fn().mockResolvedValue(['ADMIN']) };
    const verify = new VerifyTokenUseCase(
      jwt as never,
      accessTokens,
      repository as never,
      users as never,
      banList as never,
    );
    const metrics = { recordRequest: jest.fn() };
    const controller = new AuthController(
      ...(Array(9).fill(undefined) as [
        never,
        never,
        never,
        never,
        never,
        never,
        never,
        never,
        never,
      ]),
      verify,
      undefined as never,
      metrics as never,
      accessTokens,
    );
    const es256 = () =>
      accessTokens.sign({ sub: 'user-1', email: 'u@e.c', roles: ['USER'] });
    return {
      jwt,
      users,
      banList,
      repository,
      verify,
      controller,
      metrics,
      es256,
    };
  };
  it.each(['JsonWebTokenError', 'TokenExpiredError', 'NotBeforeError'])(
    'rejects %s without querying user data',
    async (name) => {
      const f = fixture();
      f.jwt.verifyAsync.mockRejectedValue(
        Object.assign(new Error('private token'), { name }),
      );
      await expect(
        f.controller.verifyToken({ token: 'private token' }),
      ).rejects.toMatchObject({
        error: { statusCode: 401, message: 'Invalid or expired token' },
      });
      expect(f.users.findByIdForAuth).not.toHaveBeenCalled();
      expect(f.metrics.recordRequest).toHaveBeenCalledWith(
        'verify_token',
        'rejected',
        expect.any(Number),
      );
    },
  );
  it('accepts an access token and returns the authenticated user', async () => {
    const f = fixture();
    f.users.findByIdForAuth.mockResolvedValue({
      id: 'user-1',
      email: 'user@example.com',
      fullName: 'User One',
      username: 'user-one',
      isVerified: true,
      picture: null,
    });

    await expect(f.verify.execute('access-token')).resolves.toMatchObject({
      id: 'user-1',
      email: 'user@example.com',
      roles: ['ADMIN'],
    });
  });
  it('rejects a verified token whose user no longer exists', async () => {
    const f = fixture();
    f.users.findByIdForAuth.mockResolvedValue(null);
    await expect(f.verify.execute('token')).rejects.toBeInstanceOf(
      InvalidTokenError,
    );
  });
  it.each([
    ['refresh', { sub: 'user-1', tokenType: 'refresh', jti: 'refresh-id' }],
    ['legacy untyped', { sub: 'user-1', jti: 'legacy-refresh-id' }],
    ['untyped', { sub: 'user-1' }],
  ])(
    'rejects %s tokens before loading protected user data',
    async (_type, payload) => {
      const f = fixture();
      f.jwt.verifyAsync.mockResolvedValue(payload);
      await expect(f.verify.execute('token')).rejects.toBeInstanceOf(
        InvalidTokenError,
      );
      expect(f.repository.getUserRole).not.toHaveBeenCalled();
      expect(f.users.findByIdForAuth).not.toHaveBeenCalled();
    },
  );
  it.each(['user', 'roles', 'jwt'])(
    'returns sanitized 503 for %s infrastructure failure',
    async (step) => {
      const f = fixture();
      const error = new Error('private database credentials');
      if (step === 'user') f.users.findByIdForAuth.mockRejectedValue(error);
      if (step === 'roles') f.repository.getUserRole.mockRejectedValue(error);
      if (step === 'jwt') f.jwt.verifyAsync.mockRejectedValue(error);
      await expect(
        f.controller.verifyToken({ token: 'private token' }),
      ).rejects.toMatchObject({
        error: {
          statusCode: 503,
          message: 'Authentication service unavailable',
        },
      });
      expect(f.metrics.recordRequest).toHaveBeenCalledWith(
        'verify_token',
        'error',
        expect.any(Number),
      );
    },
  );
  it('verifies an ES256 access token without the legacy HS256 path', async () => {
    const f = fixture();
    f.users.findByIdForAuth.mockResolvedValue({ id: 'user-1', email: 'u@e.c' });
    await expect(f.verify.execute(f.es256())).resolves.toMatchObject({
      id: 'user-1',
      roles: ['ADMIN'],
    });
    expect(f.jwt.verifyAsync).not.toHaveBeenCalled();
  });
  it('rejects a token whose ES256 signature is wrong without trying HS256', async () => {
    const f = fixture();
    const [h, p] = f.es256().split('.');
    await expect(f.verify.execute(`${h}.${p}.AAAA`)).rejects.toBeInstanceOf(
      InvalidTokenError,
    );
    expect(f.jwt.verifyAsync).not.toHaveBeenCalled();
  });
  it('refuses a denylisted user before any lookup', async () => {
    const f = fixture();
    f.banList.isBanned.mockResolvedValue(true);
    await expect(f.verify.execute(f.es256())).rejects.toBeInstanceOf(
      InvalidTokenError,
    );
    expect(f.repository.getUserRole).not.toHaveBeenCalled();
    expect(f.users.findByIdForAuth).not.toHaveBeenCalled();
  });
  it('still refuses a banned user when the ban list is down', async () => {
    jest.spyOn(Logger.prototype, 'warn').mockImplementation();
    const f = fixture();
    f.banList.isBanned.mockRejectedValue(new Error('redis down'));
    f.users.findByIdForAuth.mockResolvedValue({
      id: 'user-1',
      status: 'BANNED',
    });
    await expect(f.verify.execute(f.es256())).rejects.toBeInstanceOf(
      InvalidTokenError,
    );
  });
  it('preserves real not-found responses but propagates user RPC outage', async () => {
    const send = jest.fn().mockReturnValue(of(null));
    const adapter = new UserServiceAdapter({ send } as never);
    await expect(adapter.findById('user-1')).resolves.toBeNull();
    const error = new Error('unavailable');
    send.mockReturnValue(throwError(() => error));
    await expect(adapter.findById('user-1')).rejects.toBe(error);
  });
  it('bounds stalled user lookup without converting it to invalid credentials', async () => {
    jest.useFakeTimers();
    jest.spyOn(Logger.prototype, 'warn').mockImplementation();
    const adapter = new UserServiceAdapter({ send: () => NEVER } as never);
    const result = expect(adapter.findById('user-1')).rejects.toMatchObject({
      name: 'TimeoutError',
    });
    await jest.advanceTimersByTimeAsync(5000);
    await result;
  });
});
