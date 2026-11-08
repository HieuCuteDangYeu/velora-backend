import { RateLimitGuard } from '@common/rate-limit/rate-limit.guard';
import { RateLimitService } from '@common/rate-limit/rate-limit.service';
import { AuthController } from '@gateway/auth/auth.controller';
import { JwtAuthGuard } from '@gateway/auth/guards/jwt-auth.guard';
import { RolesGuard } from '@gateway/auth/guards/roles.guard';
import { FriendController } from '@gateway/friends/friend.controller';
import { MediaController } from '@gateway/media/media.controller';
import {
  CanActivate,
  ExecutionContext,
  INestApplication,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import { of } from 'rxjs';
import type { Express } from 'express';
import request from 'supertest';

/** Stands in for JwtAuthGuard: the user comes from a header, and we count calls. */
const authCalls = { count: 0 };
const fakeJwt: CanActivate = {
  canActivate(context: ExecutionContext) {
    authCalls.count += 1;
    const req = context.switchToHttp().getRequest<{
      headers: Record<string, string>;
      user?: { id: string };
    }>();
    const id = req.headers['x-test-user'];
    if (!id) return false;
    req.user = { id };
    return true;
  },
};

async function createApp(env: Record<string, string>) {
  const authClient = {
    send: jest.fn(() => of({ accessToken: 'a', refreshToken: 'r' })),
  };
  const friendClient = { send: jest.fn(() => of({})) };
  const mediaClient = {
    send: jest.fn(() => of({ uploadUrl: 'u', key: 'k', expiresIn: 60 })),
  };
  const config = new ConfigService(env);
  const moduleRef = await Test.createTestingModule({
    controllers: [AuthController, FriendController, MediaController],
    providers: [
      { provide: ConfigService, useValue: config },
      { provide: 'AUTH_SERVICE', useValue: authClient },
      { provide: 'FRIEND_SERVICE', useValue: friendClient },
      { provide: 'MEDIA_SERVICE', useValue: mediaClient },
      RateLimitService,
      RateLimitGuard,
    ],
  })
    .overrideGuard(JwtAuthGuard)
    .useValue(fakeJwt)
    .overrideGuard(RolesGuard)
    .useValue({ canActivate: () => true })
    .compile();
  const app: INestApplication = moduleRef.createNestApplication();
  (app.getHttpAdapter().getInstance() as Express).set('trust proxy', 1);
  await app.init();
  return { app, authClient, friendClient, mediaClient };
}

describe('rate limiting through the real gateway HTTP pipeline', () => {
  let app: INestApplication;
  let authClient: { send: jest.Mock };
  let friendClient: { send: jest.Mock };
  let mediaClient: { send: jest.Mock };

  beforeEach(async () => {
    authCalls.count = 0;
    ({ app, authClient, friendClient, mediaClient } = await createApp({
      RATE_LIMIT_AUTH_LOGIN_IP_LIMIT: '3',
      RATE_LIMIT_AUTH_LOGIN_ACCOUNT_LIMIT: '2',
      RATE_LIMIT_FRIEND_REQUEST_USER_LIMIT: '2',
      RATE_LIMIT_MEDIA_UPLOAD_URL_USER_LIMIT: '2',
      RATE_LIMIT_FRIEND_WRITE_USER_LIMIT: '2',
    }));
  });
  afterEach(async () => {
    await app.close();
  });

  const login = (ip: string, email: string) =>
    request(app.getHttpServer())
      .post('/auth/login')
      .set('X-Forwarded-For', ip)
      .send({ email, password: 'secret12' });

  it('blocks a public login flood per IP, before the auth service is called', async () => {
    for (let i = 0; i < 3; i += 1) {
      expect((await login('203.0.113.1', `user${i}@example.com`)).status).toBe(
        201,
      );
    }
    const blocked = await login('203.0.113.1', 'another@example.com');
    expect(blocked.status).toBe(429);
    expect(Number(blocked.headers['retry-after'])).toBeGreaterThan(0);
    expect(blocked.headers['ratelimit-remaining']).toBe('0');
    expect(authClient.send).toHaveBeenCalledTimes(3);
    // A public route never needs the (RPC-backed) JwtAuthGuard.
    expect(authCalls.count).toBe(0);
  });

  it('gives each client IP its own bucket behind the proxy', async () => {
    for (let i = 0; i < 3; i += 1) {
      await login('203.0.113.1', `u${i}@example.com`);
    }
    expect((await login('203.0.113.1', 'x@example.com')).status).toBe(429);
    expect((await login('203.0.113.2', 'y@example.com')).status).toBe(201);
  });

  it('stops credential stuffing of one account across rotating IPs', async () => {
    expect((await login('198.51.100.1', 'Victim@Example.com')).status).toBe(
      201,
    );
    expect((await login('198.51.100.2', ' victim@example.com')).status).toBe(
      201,
    );
    expect((await login('198.51.100.3', 'victim@example.com')).status).toBe(
      429,
    );
    expect(authClient.send).toHaveBeenCalledTimes(2);
  });

  it('limits friend requests per user, not globally', async () => {
    const send = (user: string) =>
      request(app.getHttpServer())
        .post('/friends/requests')
        .set('x-test-user', user)
        .send({ recipientId: '11111111-1111-4111-8111-111111111111' });
    expect((await send('user-a')).status).toBe(201);
    expect((await send('user-a')).status).toBe(201);
    const blocked = await send('user-a');
    expect(blocked.status).toBe(429);
    expect(friendClient.send).toHaveBeenCalledTimes(2);
    expect((await send('user-b')).status).toBe(201);
  });

  it('limits upload-url per user', async () => {
    const send = () =>
      request(app.getHttpServer())
        .post('/media/upload-url')
        .set('x-test-user', 'user-a')
        .send({ fileType: 'video/mp4', purpose: 'reel' });
    expect((await send()).status).toBe(201);
    expect((await send()).status).toBe(201);
    expect((await send()).status).toBe(429);
    expect(mediaClient.send).toHaveBeenCalledTimes(2);
  });

  it('does not limit reads or unrelated routes', async () => {
    for (let i = 0; i < 20; i += 1) {
      const res = await request(app.getHttpServer())
        .get('/friends')
        .set('x-test-user', 'user-a');
      expect(res.status).not.toBe(429);
    }
  });

  it('rejects unauthenticated calls to protected routes without consuming a user bucket', async () => {
    const res = await request(app.getHttpServer())
      .post('/friends/requests')
      .send({ recipientId: '11111111-1111-4111-8111-111111111111' });
    expect(res.status).toBe(403);
    expect(friendClient.send).not.toHaveBeenCalled();
  });
});
