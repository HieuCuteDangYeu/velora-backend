import 'reflect-metadata';
import {
  BadRequestException,
  ForbiddenException,
  HttpException,
} from '@nestjs/common';
import { GUARDS_METADATA } from '@nestjs/common/constants';
import { CallStressController } from './call-stress.controller';
import { CallStressRunnerService } from './call-stress-runner.service';
import { JwtAuthGuard } from '@gateway/auth/guards/jwt-auth.guard';
import { RolesGuard } from '@gateway/auth/guards/roles.guard';
const id = 'a622491c-a471-4e78-9a9c-90d4b3ef4e60';
const request = (origin?: string, cookie = true) =>
  ({
    headers: {
      ...(origin ? { origin } : {}),
      ...(!cookie ? { authorization: 'Bearer session' } : {}),
    },
    cookies: cookie ? { access_token: 'session' } : {},
  }) as never;
describe('Call stress boundary', () => {
  const proxy = { request: jest.fn() };
  const controller = new CallStressController(proxy as never);
  beforeEach(() => proxy.request.mockReset());
  it('requires verified JWT and ADMIN role on every route', () => {
    expect(Reflect.getMetadata(GUARDS_METADATA, CallStressController)).toEqual([
      JwtAuthGuard,
      RolesGuard,
    ]);
    expect(Reflect.getMetadata('roles', CallStressController)).toEqual([
      'ADMIN',
    ]);
  });
  it.each([
    undefined,
    'https://foreign.test',
    'https://dashboard.velora-app.me.foreign.test',
  ])('rejects cookie mutation origin %s', (origin) => {
    expect(
      () =>
        void controller.start(request(origin), {
          preset: 'smoke',
          requestId: id,
        }),
    ).toThrow(ForbiddenException);
    expect(proxy.request).not.toHaveBeenCalled();
  });
  it('permits a fixed preset from the real dashboard and bearer-only automation', () => {
    void controller.start(request('https://dashboard.velora-app.me'), {
      preset: 'demo',
      requestId: id,
    });
    expect(proxy.request).toHaveBeenCalledWith('POST', '/runs', 'session', {
      preset: 'demo',
      requestId: id,
    });
    void controller.stop(request(undefined, false), id);
    expect(proxy.request).toHaveBeenCalledWith(
      'POST',
      `/runs/${id}/stop`,
      'session',
      {},
    );
  });
  it('rejects arbitrary targets, durations and route injection', () => {
    for (const body of [
      { preset: 'large', requestId: id },
      { preset: 'smoke', requestId: id, command: 'exec' },
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
describe('Call stress proxy', () => {
  const service = new CallStressRunnerService();
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
      'Call runner is offline',
    );
    jest
      .spyOn(global, 'fetch')
      .mockResolvedValue(response(JSON.stringify({ token: 'private' })));
    await expect(service.request('GET', '/runs', 'session')).rejects.toThrow(
      'Call runner is offline',
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
      'Call runner is offline',
    );
  });
  it('returns safe state and strips private fields', async () => {
    jest.spyOn(global, 'fetch').mockResolvedValue(
      response(
        JSON.stringify({
          available: true,
          busy: false,
          source: 'host-local',
          active: null,
          recent: [],
          fixtureParticipants: 10,
          fixtureRooms: 5,
          token: 'private',
        }),
      ),
    );
    expect(await service.request('GET', '/runs', 'session')).not.toHaveProperty(
      'token',
    );
  });
});
