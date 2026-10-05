import { Logger } from '@nestjs/common';
import { NEVER, of, throwError } from 'rxjs';
import { InvalidTokenError } from '../../domain/errors/invalid-token.error';
import { UserServiceAdapter } from '../../infrastructure/adapters/user-service.adapter';
import { AuthController } from '../../infrastructure/controllers/auth.controller';
import { VerifyTokenUseCase } from './verify-token.use-case';

describe('Token verification failure classification', () => {
  afterEach(() => {
    jest.useRealTimers();
    jest.restoreAllMocks();
  });
  const fixture = () => {
    const jwt = { verifyAsync: jest.fn().mockResolvedValue({ sub: 'user-1' }) };
    const users = { findById: jest.fn().mockResolvedValue({ id: 'user-1' }) };
    const roles = {
      getUserRoles: jest.fn().mockResolvedValue(['ADMIN']),
      setUserRoles: jest.fn(),
    };
    const repository = { getUserRole: jest.fn() };
    const verify = new VerifyTokenUseCase(
      jwt as never,
      repository as never,
      users as never,
      roles as never,
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
    );
    return { jwt, users, roles, repository, verify, controller, metrics };
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
      expect(f.users.findById).not.toHaveBeenCalled();
      expect(f.metrics.recordRequest).toHaveBeenCalledWith(
        'verify_token',
        'rejected',
        expect.any(Number),
      );
    },
  );
  it('rejects a verified token whose user no longer exists', async () => {
    const f = fixture();
    f.users.findById.mockResolvedValue(null);
    await expect(f.verify.execute('token')).rejects.toBeInstanceOf(
      InvalidTokenError,
    );
  });
  it.each(['user', 'roles', 'jwt'])(
    'returns sanitized 503 for %s infrastructure failure',
    async (step) => {
      const f = fixture();
      const error = new Error('private database credentials');
      if (step === 'user') f.users.findById.mockRejectedValue(error);
      if (step === 'roles') {
        f.roles.getUserRoles.mockResolvedValue(null);
        f.repository.getUserRole.mockRejectedValue(error);
      }
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
