import {
  deriveAccessKeyPair,
  signAccessToken,
  toPublicKeyObjects,
} from '@common/auth/access-token';
import {
  ExecutionContext,
  Logger,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import { NEVER, of, throwError } from 'rxjs';
import { JwtAuthGuard } from './jwt-auth.guard';

const keys = deriveAccessKeyPair('guard-spec-secret-with-32-characters!');
const claims = {
  sub: 'user-1',
  email: 'u@e.c',
  fullName: 'User One',
  roles: ['USER'],
};

describe('JwtAuthGuard', () => {
  afterEach(() => {
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  const fixture = (
    options: {
      token?: string;
      rpc?: ReturnType<typeof of>;
      fresh?: boolean;
      redis?: { exists: jest.Mock } | null;
    } = {},
  ) => {
    const send = jest.fn(
      () => options.rpc ?? of({ id: 'rpc-user', roles: ['USER'] }),
    );
    const accessKeys = {
      current: () => toPublicKeyObjects([keys.publicKey]),
      refreshSoon: jest.fn(),
    };
    const reflector = {
      getAllAndOverride: jest.fn(() => options.fresh ?? false),
    };
    const redis =
      options.redis === null
        ? undefined
        : (options.redis ?? { exists: jest.fn().mockResolvedValue(0) });
    const request = {
      headers: { authorization: `Bearer ${options.token ?? 'private-token'}` },
      cookies: {},
      user: undefined,
    };
    const context = {
      switchToHttp: () => ({ getRequest: () => request }),
      getHandler: () => undefined,
      getClass: () => undefined,
    } as unknown as ExecutionContext;
    return {
      request,
      context,
      send,
      redis,
      accessKeys,
      guard: new JwtAuthGuard(
        { send } as never,
        accessKeys as never,
        reflector as never,
        redis as never,
      ),
    };
  };
  const userToken = (overrides: Partial<typeof claims> = {}) =>
    signAccessToken(keys, { ...claims, ...overrides });

  describe('local verification of ordinary users', () => {
    it('accepts a valid token without asking auth-service', async () => {
      const f = fixture({ token: userToken() });
      await expect(f.guard.canActivate(f.context)).resolves.toBe(true);
      expect(f.send).not.toHaveBeenCalled();
      expect(f.request.user).toMatchObject({
        id: 'user-1',
        email: 'u@e.c',
        fullName: 'User One',
        roles: ['USER'],
      });
    });

    it('refuses a banned user immediately, without asking auth-service', async () => {
      const f = fixture({
        token: userToken(),
        redis: { exists: jest.fn().mockResolvedValue(1) },
      });
      await expect(f.guard.canActivate(f.context)).rejects.toBeInstanceOf(
        UnauthorizedException,
      );
      expect(f.send).not.toHaveBeenCalled();
      expect(f.request.user).toBeUndefined();
    });

    it('asks auth-service when the ban list is unreachable', async () => {
      const f = fixture({
        token: userToken(),
        redis: { exists: jest.fn().mockRejectedValue(new Error('down')) },
      });
      await expect(f.guard.canActivate(f.context)).resolves.toBe(true);
      expect(f.send).toHaveBeenCalledTimes(1);
      expect(f.request.user).toMatchObject({ id: 'rpc-user' });
    });

    it('asks auth-service when no ban list is configured', async () => {
      const f = fixture({ token: userToken(), redis: null });
      await f.guard.canActivate(f.context);
      expect(f.send).toHaveBeenCalledTimes(1);
    });

    it('never decides for an admin token locally', async () => {
      const f = fixture({ token: userToken({ roles: ['USER', 'ADMIN'] }) });
      await f.guard.canActivate(f.context);
      expect(f.send).toHaveBeenCalledTimes(1);
      expect(f.redis!.exists).not.toHaveBeenCalled();
    });

    it('asks auth-service on routes that need the current profile', async () => {
      const f = fixture({ token: userToken(), fresh: true });
      await f.guard.canActivate(f.context);
      expect(f.send).toHaveBeenCalledTimes(1);
    });

    it('asks auth-service for a token signed with an unknown key and refetches keys', async () => {
      const other = deriveAccessKeyPair('another-secret-with-32-characters!!');
      const f = fixture({ token: signAccessToken(other, claims) });
      await f.guard.canActivate(f.context);
      expect(f.send).toHaveBeenCalledTimes(1);
      expect(f.accessKeys.refreshSoon).toHaveBeenCalled();
    });

    it('does not trust a forged or tampered token', async () => {
      const [h, , s] = userToken().split('.');
      const forged = Buffer.from(
        JSON.stringify({
          ...claims,
          sub: 'victim',
          tokenType: 'access',
          exp: 9_999_999_999,
        }),
      ).toString('base64url');
      const f = fixture({
        token: `${h}.${forged}.${s}`,
        rpc: throwError(() => ({
          statusCode: 401,
          message: 'invalid',
        })),
      });
      await expect(f.guard.canActivate(f.context)).rejects.toBeInstanceOf(
        UnauthorizedException,
      );
      expect(f.send).toHaveBeenCalledTimes(1);
    });

    it('sends a token without a roles claim to auth-service', async () => {
      const f = fixture({ token: userToken({ roles: undefined as never }) });
      await f.guard.canActivate(f.context);
      expect(f.send).toHaveBeenCalledTimes(1);
    });
  });

  describe('authoritative path', () => {
    it('sets identity only after successful verification', async () => {
      const f = fixture();
      await expect(f.guard.canActivate(f.context)).resolves.toBe(true);
      expect(f.request.user).toEqual({ id: 'rpc-user', roles: ['USER'] });
    });

    it('keeps an explicit invalid-token response as 401', async () => {
      const f = fixture({
        rpc: throwError(() => ({
          statusCode: 401,
          message: 'private-token',
        })),
      });
      await expect(f.guard.canActivate(f.context)).rejects.toBeInstanceOf(
        UnauthorizedException,
      );
      expect(f.request.user).toBeUndefined();
    });

    it('returns 503 for unavailable upstream without logging credentials', async () => {
      const log = jest.spyOn(Logger.prototype, 'warn').mockImplementation();
      const f = fixture({
        rpc: throwError(() => new Error('private-token')),
      });
      await expect(f.guard.canActivate(f.context)).rejects.toBeInstanceOf(
        ServiceUnavailableException,
      );
      expect(JSON.stringify(log.mock.calls)).not.toContain('private-token');
    });

    it('keeps the 5-second RPC deadline and classifies timeout as 503', async () => {
      jest.useFakeTimers();
      jest.spyOn(Logger.prototype, 'warn').mockImplementation();
      const f = fixture({ rpc: NEVER });
      const result = expect(
        f.guard.canActivate(f.context),
      ).rejects.toBeInstanceOf(ServiceUnavailableException);
      await jest.advanceTimersByTimeAsync(5000);
      await result;
    });

    it('rejects a request with no token', async () => {
      const f = fixture();
      f.request.headers = {} as never;
      await expect(f.guard.canActivate(f.context)).rejects.toBeInstanceOf(
        UnauthorizedException,
      );
    });
  });
});
