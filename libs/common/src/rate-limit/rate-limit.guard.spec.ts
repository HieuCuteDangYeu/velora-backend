import { HttpException, type ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { RATE_LIMIT_RULES, type RateLimitRule } from './rate-limit.decorator';
import { RateLimitGuard } from './rate-limit.guard';
import { RateLimitService } from './rate-limit.service';

const configService = (values: Record<string, string> = {}) =>
  ({ get: (key: string) => values[key] }) as never;

function buildContext(
  rules: RateLimitRule[] | undefined,
  request: Record<string, unknown>,
) {
  const headers: Record<string, string> = {};
  const response = {
    setHeader: (name: string, value: string) => {
      headers[name] = value;
    },
  };
  class Controller {}
  const handler = () => undefined;
  if (rules) Reflect.defineMetadata(RATE_LIMIT_RULES, rules, handler);
  const context = {
    getHandler: () => handler,
    getClass: () => Controller,
    switchToHttp: () => ({
      getRequest: () => request,
      getResponse: () => response,
    }),
  } as unknown as ExecutionContext;
  return { context, headers };
}

const guardWith = (service: RateLimitService, values = {}) =>
  new RateLimitGuard(new Reflector(), service, configService(values));

describe('RateLimitGuard', () => {
  it('passes routes without rules and never touches the store', async () => {
    const service = { check: jest.fn() } as unknown as RateLimitService;
    const { context } = buildContext(undefined, { ip: '1.1.1.1' });
    expect(await guardWith(service).canActivate(context)).toBe(true);
    expect(service.check).not.toHaveBeenCalled();
  });

  it('answers 429 with Retry-After and rate-limit headers on denial', async () => {
    const service = new RateLimitService(undefined, configService());
    const guard = guardWith(service);
    const rules: RateLimitRule[] = [{ policy: 'auth_reset_ip', by: 'ip' }];
    let error: HttpException | undefined;
    let headers: Record<string, string> = {};
    for (let i = 0; i < 11; i += 1) {
      const built = buildContext(rules, { ip: '203.0.113.7' });
      try {
        await guard.canActivate(built.context);
      } catch (e) {
        error = e as HttpException;
        headers = built.headers;
      }
    }
    expect(error?.getStatus()).toBe(429);
    expect(Number(headers['Retry-After'])).toBeGreaterThan(0);
    expect(headers['RateLimit-Limit']).toBe('10');
    expect(headers['RateLimit-Remaining']).toBe('0');
  });

  it('keys on a hash of the body field, case-insensitively, never the raw email', async () => {
    const check = jest.fn().mockResolvedValue({
      allowed: true,
      limit: 5,
      remaining: 4,
      retryAfterSeconds: 0,
      source: 'local',
    });
    const service = {
      check,
      logDenied: jest.fn(),
    } as unknown as RateLimitService;
    const rules: RateLimitRule[] = [
      { policy: 'auth_login_account', by: { body: 'email' } },
    ];
    await guardWith(service).canActivate(
      buildContext(rules, {
        ip: '1.1.1.1',
        body: { email: ' Victim@Example.com ' },
      }).context,
    );
    await guardWith(service).canActivate(
      buildContext(rules, {
        ip: '2.2.2.2',
        body: { email: 'victim@example.com' },
      }).context,
    );
    const [first, second] = check.mock.calls.map((c) => c[1] as string);
    expect(first).toBe(second);
    expect(first).not.toContain('victim');
  });

  it('skips a body rule when the field is missing', async () => {
    const service = { check: jest.fn() } as unknown as RateLimitService;
    const rules: RateLimitRule[] = [
      { policy: 'auth_login_account', by: { body: 'email' } },
    ];
    expect(
      await guardWith(service).canActivate(
        buildContext(rules, { ip: '1.1.1.1', body: {} }).context,
      ),
    ).toBe(true);
    expect(service.check).not.toHaveBeenCalled();
  });

  it('keys user rules on the user id and falls back to IP without one', async () => {
    const check = jest.fn().mockResolvedValue({
      allowed: true,
      limit: 1,
      remaining: 1,
      retryAfterSeconds: 0,
      source: 'local',
    });
    const service = { check } as unknown as RateLimitService;
    const rules: RateLimitRule[] = [{ policy: 'ai_chat_user', by: 'user' }];
    await guardWith(service).canActivate(
      buildContext(rules, { ip: '1.1.1.1', user: { id: 'user-1' } }).context,
    );
    await guardWith(service).canActivate(
      buildContext(rules, { ip: '1.1.1.1' }).context,
    );
    expect(check.mock.calls.map((c) => c[1] as string)).toEqual([
      'u:user-1',
      'ip:1.1.1.1',
    ]);
  });
});
