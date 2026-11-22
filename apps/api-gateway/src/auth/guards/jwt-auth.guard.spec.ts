import {
  ExecutionContext,
  Logger,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import { NEVER, of, throwError } from 'rxjs';
import { JwtAuthGuard } from './jwt-auth.guard';

describe('Gateway credential and infrastructure failures', () => {
  afterEach(() => {
    jest.useRealTimers();
    jest.restoreAllMocks();
  });
  const fixture = (response = of({ id: 'user-1' })) => {
    const send = jest.fn(() => response);
    const request = {
      headers: { authorization: 'Bearer private-token' },
      cookies: {},
      user: undefined,
    };
    const context = {
      switchToHttp: () => ({ getRequest: () => request }),
    } as ExecutionContext;
    return {
      request,
      context,
      guard: new JwtAuthGuard({ send } as never),
      send,
    };
  };
  it('sets identity only after successful verification', async () => {
    const f = fixture();
    await expect(f.guard.canActivate(f.context)).resolves.toBe(true);
    expect(f.request.user).toEqual({ id: 'user-1' });
  });
  it('keeps an explicit invalid-token response as 401', async () => {
    const f = fixture(
      throwError(() => ({ statusCode: 401, message: 'private-token' })),
    );
    await expect(f.guard.canActivate(f.context)).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
    expect(f.request.user).toBeUndefined();
  });
  it('returns 503 for unavailable upstream without logging credentials', async () => {
    const log = jest.spyOn(Logger.prototype, 'warn').mockImplementation();
    const f = fixture(throwError(() => new Error('private-token')));
    await expect(f.guard.canActivate(f.context)).rejects.toBeInstanceOf(
      ServiceUnavailableException,
    );
    expect(f.request.user).toBeUndefined();
    expect(JSON.stringify(log.mock.calls)).not.toContain('private-token');
  });
  it('keeps the 5-second RPC deadline and classifies timeout as 503', async () => {
    jest.useFakeTimers();
    jest.spyOn(Logger.prototype, 'warn').mockImplementation();
    const f = fixture(NEVER);
    const result = expect(
      f.guard.canActivate(f.context),
    ).rejects.toBeInstanceOf(ServiceUnavailableException);
    await jest.advanceTimersByTimeAsync(5000);
    await result;
    expect(f.request.user).toBeUndefined();
  });
});

describe('JwtAuthGuard token cache (opt-in)', () => {
  const b64 = (o: object) =>
    Buffer.from(JSON.stringify(o)).toString('base64url');
  const tokenFor = (sub: string, expInSeconds = 900) =>
    `${b64({ alg: 'HS256' })}.${b64({ sub, exp: Math.floor(Date.now() / 1000) + expInSeconds })}.sig`;
  const make = (ttl: number | undefined, responses: Array<unknown>) => {
    const send = jest.fn(() => {
      const next = responses.shift();
      return next instanceof Error ||
        (next as { statusCode?: number })?.statusCode === 401
        ? throwError(() => next)
        : of(next);
    });
    const config = { get: () => ttl } as never;
    const guard = new JwtAuthGuard({ send } as never, config);
    const ctx = (token: string, method = 'GET') => {
      const request: Record<string, unknown> = {
        method,
        headers: { authorization: `Bearer ${token}` },
        cookies: {},
      };
      return {
        request,
        context: {
          switchToHttp: () => ({ getRequest: () => request }),
        } as ExecutionContext,
      };
    };
    return { guard, send, ctx };
  };
  const user = { id: 'u1', email: 'a@b.c', roles: ['USER'] };
  afterEach(() => {
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  it('is off by default: every request is verified', async () => {
    const f = make(undefined, [user, user]);
    const t = tokenFor('u1');
    await f.guard.canActivate(f.ctx(t).context);
    await f.guard.canActivate(f.ctx(t).context);
    expect(f.send).toHaveBeenCalledTimes(2);
  });

  it('serves a repeat GET from the cache, then re-verifies after the TTL', async () => {
    jest.useFakeTimers();
    const f = make(5000, [user, { ...user, roles: ['USER'] }]);
    const t = tokenFor('u1');
    await f.guard.canActivate(f.ctx(t).context);
    const hit = f.ctx(t);
    await expect(f.guard.canActivate(hit.context)).resolves.toBe(true);
    expect(hit.request.user).toEqual(user);
    expect(f.send).toHaveBeenCalledTimes(1);
    await jest.advanceTimersByTimeAsync(5001);
    await f.guard.canActivate(f.ctx(t).context);
    expect(f.send).toHaveBeenCalledTimes(2);
  });

  it('rejects a deleted user once the entry expires', async () => {
    jest.useFakeTimers();
    const f = make(5000, [user, { statusCode: 401, message: 'invalid' }]);
    const t = tokenFor('u1');
    await f.guard.canActivate(f.ctx(t).context);
    await jest.advanceTimersByTimeAsync(5001);
    await expect(f.guard.canActivate(f.ctx(t).context)).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
  });

  it('never caches a failure', async () => {
    const f = make(5000, [{ statusCode: 401, message: 'invalid' }]);
    const t = tokenFor('u1');
    await expect(f.guard.canActivate(f.ctx(t).context)).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
    (f.send as jest.Mock).mockReturnValueOnce(of(user));
    await expect(f.guard.canActivate(f.ctx(t).context)).resolves.toBe(true);
    expect(f.send).toHaveBeenCalledTimes(2);
  });

  it("does not let one token be served from another token's entry", async () => {
    const other = { ...user, id: 'u2' };
    const f = make(5000, [user, other]);
    const a = f.ctx(tokenFor('u1'));
    const b = f.ctx(tokenFor('u2'));
    await f.guard.canActivate(a.context);
    await f.guard.canActivate(b.context);
    expect(b.request.user).toEqual(other);
    expect(f.send).toHaveBeenCalledTimes(2);
  });

  it('always re-verifies writes', async () => {
    const f = make(5000, [user, user, user]);
    const t = tokenFor('u1');
    await f.guard.canActivate(f.ctx(t, 'GET').context);
    await f.guard.canActivate(f.ctx(t, 'POST').context);
    await f.guard.canActivate(f.ctx(t, 'DELETE').context);
    expect(f.send).toHaveBeenCalledTimes(3);
  });

  it('never caches admins', async () => {
    const admin = { ...user, roles: ['USER', 'ADMIN'] };
    const f = make(5000, [admin, admin]);
    const t = tokenFor('u1');
    await f.guard.canActivate(f.ctx(t).context);
    await f.guard.canActivate(f.ctx(t).context);
    expect(f.send).toHaveBeenCalledTimes(2);
  });

  it('never keeps an entry past the token expiry', async () => {
    const f = make(5000, [user, user]);
    const t = tokenFor('u1', 0);
    await f.guard.canActivate(f.ctx(t).context);
    await f.guard.canActivate(f.ctx(t).context);
    expect(f.send).toHaveBeenCalledTimes(2);
  });

  it('caps the configured TTL at 30 seconds', async () => {
    jest.useFakeTimers();
    const f = make(10 * 60_000, [user, user]);
    const t = tokenFor('u1');
    await f.guard.canActivate(f.ctx(t).context);
    await jest.advanceTimersByTimeAsync(30_001);
    await f.guard.canActivate(f.ctx(t).context);
    expect(f.send).toHaveBeenCalledTimes(2);
  });
});
