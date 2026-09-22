import { GUARDS_METADATA } from '@nestjs/common/constants';
import { of, throwError } from 'rxjs';

import { AuthController } from './auth.controller';

const tokens = {
  accessToken: 'access-token',
  refreshToken: 'refresh-token',
};

const createResponse = () => ({
  clearCookie: jest.fn(),
  cookie: jest.fn(),
  setHeader: jest.fn(),
});

const createController = (notificationGatewaySecret = 'gateway-secret') => {
  const authClient = {
    send: jest.fn(),
  };
  const configService = {
    get: jest.fn((key: string) => {
      if (key === 'NOTIFICATION_SERVICE_URL') {
        return 'http://notification-service:3015';
      }

      if (key === 'NOTIFICATION_GATEWAY_SECRET') {
        return notificationGatewaySecret;
      }

      return undefined;
    }),
  };

  return {
    authClient,
    controller: new AuthController(authClient as never, configService as never),
  };
};

describe('AuthController mobile authentication', () => {
  it('returns tokens for mobile password login without setting cookies', async () => {
    const { authClient, controller } = createController();
    const response = createResponse();
    const dto = { email: 'user@example.com', password: 'password123' };
    authClient.send.mockReturnValueOnce(of(tokens));

    await expect(
      controller.mobileLogin(dto as never, response as never),
    ).resolves.toEqual(tokens);

    expect(authClient.send).toHaveBeenCalledWith('auth.login', dto);
    expect(response.setHeader).toHaveBeenCalledWith(
      'Cache-Control',
      'no-store',
    );
    expect(response.cookie).not.toHaveBeenCalled();
  });

  it('returns tokens for mobile Google verification without setting cookies', async () => {
    const { authClient, controller } = createController();
    const response = createResponse();
    const dto = { idToken: 'google-id-token' };
    authClient.send.mockReturnValueOnce(of(tokens));

    await expect(
      controller.mobileVerifyGoogleToken(dto as never, response as never),
    ).resolves.toEqual(tokens);

    expect(authClient.send).toHaveBeenCalledWith(
      'auth.verify_google_token',
      dto,
    );
    expect(response.setHeader).toHaveBeenCalledWith(
      'Cache-Control',
      'no-store',
    );
    expect(response.cookie).not.toHaveBeenCalled();
  });

  it('forwards the mobile refresh token and returns the rotated tokens', async () => {
    const { authClient, controller } = createController();
    const response = createResponse();
    const dto = { refreshToken: 'mobile-refresh-token' };
    authClient.send.mockReturnValueOnce(of(tokens));

    await expect(
      controller.mobileRefresh(dto as never, response as never),
    ).resolves.toEqual(tokens);

    expect(authClient.send).toHaveBeenCalledWith('auth.refresh', dto);
    expect(response.setHeader).toHaveBeenCalledWith(
      'Cache-Control',
      'no-store',
    );
    expect(response.cookie).not.toHaveBeenCalled();
  });

  it('translates invalid mobile refresh RPC errors without exposing the token', async () => {
    const { authClient, controller } = createController();
    const response = createResponse();
    const dto = { refreshToken: 'mobile-refresh-token' };
    authClient.send.mockReturnValueOnce(
      throwError(() => ({
        statusCode: 401,
        message: 'Invalid or expired refresh token',
      })),
    );

    await expect(
      controller.mobileRefresh(dto as never, response as never),
    ).rejects.toMatchObject({
      message: 'Invalid or expired refresh token',
      status: 401,
    });
    expect(response.cookie).not.toHaveBeenCalled();
  });

  it('forwards mobile logout and omits the auth service userId', async () => {
    const { authClient, controller } = createController();
    const dto = { refreshToken: 'mobile-refresh-token' };
    authClient.send.mockReturnValueOnce(
      of({ message: 'Logged out successfully', userId: 'user-1' }),
    );

    await expect(controller.mobileLogout(dto as never)).resolves.toEqual({
      message: 'Logged out successfully',
    });

    expect(authClient.send).toHaveBeenCalledWith('auth.logout', dto);
  });

  it('deactivates mobile FCM and APNs tokens with the auth userId', async () => {
    const { authClient, controller } = createController();
    const dto = {
      refreshToken: 'mobile-refresh-token',
      pushTokens: [
        { provider: 'fcm', token: 'fcm-token-that-is-long-enough' },
        { provider: 'apns_voip', token: 'voip-token-that-is-long-enough' },
      ],
    };
    const originalFetch = global.fetch;
    const fetchMock = jest.fn(() =>
      Promise.resolve(
        new Response(JSON.stringify({ count: 1 }), {
          headers: { 'Content-Type': 'application/json' },
        }),
      ),
    );
    authClient.send.mockReturnValueOnce(
      of({ message: 'Logged out successfully', userId: 'user-1' }),
    );
    global.fetch = fetchMock;

    try {
      await expect(controller.mobileLogout(dto as never)).resolves.toEqual({
        message: 'Logged out successfully',
      });

      expect(authClient.send).toHaveBeenCalledWith('auth.logout', dto);
      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect(fetchMock).toHaveBeenCalledWith(
        'http://notification-service:3015/notifications/push-tokens/deactivate',
        expect.objectContaining({
          headers: expect.objectContaining({
            'x-user-id': 'user-1',
            'x-notification-gateway-secret': 'gateway-secret',
          }),
        }),
      );
      expect(authClient.send.mock.invocationCallOrder[0]).toBeLessThan(
        fetchMock.mock.invocationCallOrder[0],
      );
    } finally {
      global.fetch = originalFetch;
    }
  });

  it('does not block mobile logout when push-token cleanup fails', async () => {
    const { authClient, controller } = createController();
    const dto = {
      refreshToken: 'mobile-refresh-token',
      pushTokens: [{ provider: 'fcm', token: 'fcm-token-that-is-long-enough' }],
    };
    const originalFetch = global.fetch;
    const fetchMock = jest.fn(() =>
      Promise.resolve(
        new Response('notification service unavailable', { status: 503 }),
      ),
    );
    authClient.send.mockReturnValueOnce(
      of({ message: 'Logged out successfully', userId: 'user-1' }),
    );
    global.fetch = fetchMock;

    try {
      await expect(controller.mobileLogout(dto as never)).resolves.toEqual({
        message: 'Logged out successfully',
      });
      expect(authClient.send).toHaveBeenCalledWith('auth.logout', dto);
      expect(fetchMock).toHaveBeenCalledTimes(1);
    } finally {
      global.fetch = originalFetch;
    }
  });

  it('skips mobile push-token cleanup when auth logout has no userId', async () => {
    const { authClient, controller } = createController();
    const dto = {
      refreshToken: 'unknown-mobile-refresh-token',
      pushTokens: [{ provider: 'fcm', token: 'fcm-token-that-is-long-enough' }],
    };
    const originalFetch = global.fetch;
    const fetchMock = jest.fn();
    authClient.send.mockReturnValueOnce(
      of({ message: 'Logged out successfully' }),
    );
    global.fetch = fetchMock;

    try {
      await expect(controller.mobileLogout(dto as never)).resolves.toEqual({
        message: 'Logged out successfully',
      });
      expect(fetchMock).not.toHaveBeenCalled();
    } finally {
      global.fetch = originalFetch;
    }
  });

  it('does not apply JwtAuthGuard to mobile authentication routes', () => {
    for (const method of [
      'mobileLogin',
      'mobileVerifyGoogleToken',
      'mobileRefresh',
      'mobileLogout',
    ] as const) {
      expect(
        Reflect.getMetadata(GUARDS_METADATA, AuthController.prototype[method]),
      ).toBeUndefined();
    }
  });
});

describe('AuthController socket token', () => {
  it('returns the cookie token for browser-authenticated requests', () => {
    const { controller } = createController();

    expect(
      controller.getSocketToken({
        cookies: { access_token: 'cookie-access-token' },
        headers: { authorization: 'Bearer bearer-access-token' },
      } as never),
    ).toEqual({ accessToken: 'cookie-access-token' });
  });

  it('returns the bearer token for mobile-authenticated requests', () => {
    const { controller } = createController();

    expect(
      controller.getSocketToken({
        cookies: {},
        headers: { authorization: 'Bearer bearer-access-token' },
      } as never),
    ).toEqual({ accessToken: 'bearer-access-token' });
  });

  it('rejects a socket-token request without a cookie or bearer token', () => {
    const { controller } = createController();

    expect(() =>
      controller.getSocketToken({ cookies: {}, headers: {} } as never),
    ).toThrow('No access token found');
  });
});

describe('AuthController browser authentication regression coverage', () => {
  const expectedCookieOptions = (maxAge?: number) => ({
    ...(maxAge === undefined ? {} : { maxAge }),
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    path: '/',
  });

  it('keeps browser login cookie behavior unchanged', async () => {
    const { authClient, controller } = createController();
    const response = createResponse();
    const dto = { email: 'user@example.com', password: 'password123' };
    authClient.send.mockReturnValueOnce(of(tokens));

    await expect(
      controller.login(dto as never, response as never),
    ).resolves.toEqual({
      message: 'Login successful',
    });

    expect(response.cookie).toHaveBeenNthCalledWith(
      1,
      'access_token',
      tokens.accessToken,
      expectedCookieOptions(15 * 60 * 1000),
    );
    expect(response.cookie).toHaveBeenNthCalledWith(
      2,
      'refresh_token',
      tokens.refreshToken,
      expectedCookieOptions(7 * 24 * 60 * 60 * 1000),
    );
  });

  it('keeps browser refresh cookie rotation behavior unchanged', async () => {
    const { authClient, controller } = createController();
    const response = createResponse();
    authClient.send.mockReturnValueOnce(of(tokens));

    await expect(
      controller.refresh(
        { cookies: { refresh_token: 'browser-refresh-token' } } as never,
        response as never,
      ),
    ).resolves.toEqual({ message: 'Token refreshed successfully' });

    expect(authClient.send).toHaveBeenCalledWith('auth.refresh', {
      refreshToken: 'browser-refresh-token',
    });
    expect(response.setHeader).toHaveBeenCalledWith(
      'Cache-Control',
      'no-store',
    );
    expect(response.cookie).toHaveBeenCalledTimes(2);
    expect(response.clearCookie).not.toHaveBeenCalled();
  });

  it('keeps browser invalid-refresh cookie clearing behavior unchanged', async () => {
    const { authClient, controller } = createController();
    const response = createResponse();
    authClient.send.mockReturnValueOnce(
      throwError(() => ({
        statusCode: 401,
        message: 'Invalid or expired refresh token',
      })),
    );

    await expect(
      controller.refresh(
        { cookies: { refresh_token: 'browser-refresh-token' } } as never,
        response as never,
      ),
    ).rejects.toMatchObject({
      message: 'Invalid or expired refresh token',
      status: 401,
    });

    expect(response.clearCookie).toHaveBeenNthCalledWith(1, 'access_token');
    expect(response.clearCookie).toHaveBeenNthCalledWith(2, 'refresh_token');
  });

  it('preserves browser cookies when refresh fails for an infrastructure reason', async () => {
    const { authClient, controller } = createController();
    const response = createResponse();
    authClient.send.mockReturnValueOnce(
      throwError(() => ({
        statusCode: 500,
        message: 'Failed to refresh session',
      })),
    );

    await expect(
      controller.refresh(
        { cookies: { refresh_token: 'browser-refresh-token' } } as never,
        response as never,
      ),
    ).rejects.toMatchObject({
      message: 'Failed to refresh session',
      status: 500,
    });

    expect(response.clearCookie).not.toHaveBeenCalled();
  });

  it('keeps browser logout cookie clearing behavior unchanged', async () => {
    const { authClient, controller } = createController();
    const response = createResponse();
    authClient.send.mockReturnValueOnce(
      of({ message: 'Logged out successfully', userId: 'user-1' }),
    );

    await expect(
      controller.logout(
        undefined,
        { cookies: { refresh_token: 'browser-refresh-token' } } as never,
        response as never,
      ),
    ).resolves.toEqual({ message: 'Logged out successfully' });

    expect(authClient.send).toHaveBeenCalledWith('auth.logout', {
      refreshToken: 'browser-refresh-token',
    });
    expect(response.clearCookie).toHaveBeenNthCalledWith(
      1,
      'access_token',
      expectedCookieOptions(),
    );
    expect(response.clearCookie).toHaveBeenNthCalledWith(
      2,
      'refresh_token',
      expectedCookieOptions(),
    );
    expect(response.cookie).not.toHaveBeenCalled();
  });
});
