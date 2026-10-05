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
