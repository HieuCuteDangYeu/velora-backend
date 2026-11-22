import { Logger } from '@nestjs/common';
import { NEVER, of, throwError } from 'rxjs';
import { InvalidTokenError } from '../../domain/errors/invalid-token.error';
import { UserServiceAdapter } from '../../infrastructure/adapters/user-service.adapter';
import { AuthController } from '../../infrastructure/controllers/auth.controller';
import { AccessTokenService } from '../../infrastructure/security/access-token.service';
import { VerifyTokenUseCase } from './verify-token.use-case';

describe('Token verification', () => {
  afterEach(() => {
    jest.useRealTimers();
    jest.restoreAllMocks();
  });
  const SECRET = 'unit-test-secret-with-at-least-32-chars';
  const fixture = () => {
    const users = {
      findByIdForAuth: jest.fn().mockResolvedValue({
        id: 'user-1',
        email: 'user@example.com',
        fullName: 'User One',
        username: 'user-one',
        isVerified: true,
        picture: null,
      }),
    };
    const banList = { isBanned: jest.fn().mockResolvedValue(false) };
    const accessTokens = new AccessTokenService({
      getOrThrow: () => SECRET,
    } as never);
    const repository = { getUserRole: jest.fn().mockResolvedValue(['ADMIN']) };
    const verify = new VerifyTokenUseCase(
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
    const token = () =>
      accessTokens.sign({ sub: 'user-1', email: 'u@e.c', roles: ['USER'] });
    return { users, banList, repository, verify, controller, metrics, token };
  };

  it('returns the authenticated user with roles read from the database', async () => {
    const f = fixture();
    await expect(f.verify.execute(f.token())).resolves.toMatchObject({
      id: 'user-1',
      email: 'user@example.com',
      roles: ['ADMIN'],
    });
    expect(f.repository.getUserRole).toHaveBeenCalledWith('user-1');
  });

  it.each([
    ['garbage', () => 'not-a-token'],
    [
      'bad signature',
      (f: ReturnType<typeof fixture>) => {
        const [h, p] = f.token().split('.');
        return `${h}.${p}.AAAA`;
      },
    ],
    [
      'HS256 token',
      () => {
        const b = (o: object) =>
          Buffer.from(JSON.stringify(o)).toString('base64url');
        return `${b({ alg: 'HS256', typ: 'JWT' })}.${b({ sub: 'user-1', tokenType: 'access', exp: 9_999_999_999 })}.sig`;
      },
    ],
  ])('rejects %s as 401 without loading user data', async (_name, make) => {
    const f = fixture();
    await expect(
      f.controller.verifyToken({ token: make(f) }),
    ).rejects.toMatchObject({
      error: { statusCode: 401, message: 'Invalid or expired token' },
    });
    expect(f.users.findByIdForAuth).not.toHaveBeenCalled();
    expect(f.repository.getUserRole).not.toHaveBeenCalled();
    expect(f.metrics.recordRequest).toHaveBeenCalledWith(
      'verify_token',
      'rejected',
      expect.any(Number),
    );
  });

  it('rejects a verified token whose user no longer exists', async () => {
    const f = fixture();
    f.users.findByIdForAuth.mockResolvedValue(null);
    await expect(f.verify.execute(f.token())).rejects.toBeInstanceOf(
      InvalidTokenError,
    );
  });

  it('refuses a denylisted user before any lookup', async () => {
    const f = fixture();
    f.banList.isBanned.mockResolvedValue(true);
    await expect(f.verify.execute(f.token())).rejects.toBeInstanceOf(
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
    await expect(f.verify.execute(f.token())).rejects.toBeInstanceOf(
      InvalidTokenError,
    );
  });

  it.each(['user', 'roles'])(
    'returns sanitized 503 for %s infrastructure failure',
    async (step) => {
      const f = fixture();
      const error = new Error('private database credentials');
      if (step === 'user') f.users.findByIdForAuth.mockRejectedValue(error);
      if (step === 'roles') f.repository.getUserRole.mockRejectedValue(error);
      await expect(
        f.controller.verifyToken({ token: f.token() }),
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
