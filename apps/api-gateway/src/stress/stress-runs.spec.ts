import 'reflect-metadata';
import {
  BadRequestException,
  ForbiddenException,
  HttpException,
} from '@nestjs/common';
import { GUARDS_METADATA } from '@nestjs/common/constants';
import { StressRunsController } from './stress-runs.controller';
import { StressRunsService } from './stress-runs.service';
import { JwtAuthGuard } from '@gateway/auth/guards/jwt-auth.guard';
import { RolesGuard } from '@gateway/auth/guards/roles.guard';
const id = 'a622491c-a471-4e78-9a9c-90d4b3ef4e60';
const start = (scenario: string) => ({
  scenario,
  params: { rps: 10, seconds: 30, storm: true },
  requestId: id,
});
const request = (origin?: string, cookie = true) =>
  ({
    headers: {
      ...(origin ? { origin } : {}),
      ...(!cookie ? { authorization: 'Bearer session' } : {}),
    },
    cookies: cookie ? { access_token: 'session' } : {},
  }) as never;
describe('Stress runs boundary', () => {
  const proxy = { request: jest.fn() };
  const controller = new StressRunsController(proxy as never);
  beforeEach(() => proxy.request.mockReset());
  it('requires verified JWT and ADMIN role on every route', () => {
    expect(Reflect.getMetadata(GUARDS_METADATA, StressRunsController)).toEqual([
      JwtAuthGuard,
      RolesGuard,
    ]);
    expect(Reflect.getMetadata('roles', StressRunsController)).toEqual([
      'ADMIN',
    ]);
  });
  it.each([
    undefined,
    'https://foreign.test',
    'https://dashboard.velora-app.me.foreign.test',
  ])('rejects cookie mutation origin %s', (origin) => {
    expect(() => void controller.start(request(origin), start('chat'))).toThrow(
      ForbiddenException,
    );
    expect(proxy.request).not.toHaveBeenCalled();
  });
  it('permits a named scenario from the real dashboard and bearer-only automation', () => {
    void controller.start(
      request('https://dashboard.velora-app.me'),
      start('mixed'),
    );
    expect(proxy.request).toHaveBeenCalledWith(
      'POST',
      '/runs',
      'session',
      start('mixed'),
    );
    void controller.stop(request(undefined, false), id);
    expect(proxy.request).toHaveBeenCalledWith(
      'POST',
      `/runs/${id}/stop`,
      'session',
      {},
    );
  });
  it('rejects unknown scenarios, extra fields, non-numeric settings and route injection', () => {
    for (const body of [
      { ...start('chat'), scenario: 'shell' },
      { ...start('chat'), command: 'exec' },
      { ...start('chat'), params: { rps: 'ten' } },
      { ...start('chat'), requestId: 'not-a-uuid' },
    ])
      expect(
        () =>
          void controller.start(
            request('https://dashboard.velora-app.me'),
            body,
          ),
      ).toThrow(BadRequestException);
    expect(
      () => void controller.stop(request(undefined, false), '../../exec'),
    ).toThrow(BadRequestException);
    expect(proxy.request).not.toHaveBeenCalled();
  });
});
const response = (text: string, status = 200) => {
  let read = false;
  return {
    ok: status >= 200 && status < 300,
    status,
    body: {
      getReader: () => ({
        read: () => {
          const result = read
            ? { done: true }
            : { done: false, value: Buffer.from(text) };
          read = true;
          return Promise.resolve(result);
        },
        cancel: () => Promise.resolve(undefined),
      }),
    },
  } as unknown as Response;
};
describe('Stress runs proxy', () => {
  const service = new StressRunsService();
  const originalFetch = global.fetch;
  beforeEach(() => {
    global.fetch = jest.fn();
  });
  afterAll(() => {
    global.fetch = originalFetch;
  });
  it('redacts host errors and malformed upstream bodies', async () => {
    jest
      .spyOn(global, 'fetch')
      .mockRejectedValue(new Error('fixture password /private/path'));
    await expect(service.request('GET', '/runs', 'session')).rejects.toThrow(
      'Stress agent is offline',
    );
    jest
      .spyOn(global, 'fetch')
      .mockResolvedValue(response(JSON.stringify({ token: 'private' })));
    await expect(service.request('GET', '/runs', 'session')).rejects.toThrow(
      'Stress agent is offline',
    );
  });
  it('keeps conflict status without exposing its body', async () => {
    jest.spyOn(global, 'fetch').mockResolvedValue(response('private', 409));
    try {
      await service.request('POST', '/runs', 'session');
      throw new Error('expected conflict');
    } catch (e) {
      expect((e as HttpException).getStatus()).toBe(409);
      expect(String(e)).not.toContain('private');
    }
  });
  it('bounds response bytes', async () => {
    jest.spyOn(global, 'fetch').mockResolvedValue(response('x'.repeat(512001)));
    await expect(service.request('GET', '/runs', 'session')).rejects.toThrow(
      'Stress agent is offline',
    );
  });
  it('returns safe state and strips private fields', async () => {
    jest.spyOn(global, 'fetch').mockResolvedValue(
      response(
        JSON.stringify({
          available: true,
          busy: false,
          scenarios: [],
          active: null,
          recent: [],
          token: 'private',
        }),
      ),
    );
    expect(await service.request('GET', '/runs', 'session')).not.toHaveProperty(
      'token',
    );
  });
});
