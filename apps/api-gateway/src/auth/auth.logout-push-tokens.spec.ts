import { of } from 'rxjs';

import { AuthController } from './auth.controller';

describe('AuthController logout push token cleanup', () => {
  const createController = () => {
    const authClient = {
      send: jest.fn((pattern: string) =>
        of(
          pattern === 'auth.verify_token'
            ? { id: 'user-1' }
            : { message: 'Logged out successfully', userId: 'user-1' },
        ),
      ),
    };
    const configService = {
      get: jest.fn((key: string) => {
        if (key === 'NOTIFICATION_SERVICE_URL') {
          return 'http://notification-service:3015';
        }

        if (key === 'NOTIFICATION_GATEWAY_SECRET') {
          return 'gateway-secret';
        }

        return undefined;
      }),
    };

    return {
      authClient,
      controller: new AuthController(
        authClient as never,
        configService as never,
      ),
    };
  };

  const createResponse = () => ({
    clearCookie: jest.fn(),
  });

  const withFetchMock = async (run: () => Promise<void>) => {
    const originalFetch = global.fetch;
    const fetchMock = jest.fn(() =>
      Promise.resolve(
        new Response(JSON.stringify({ count: 1 }), {
          headers: { 'Content-Type': 'application/json' },
        }),
      ),
    );
    global.fetch = fetchMock;

    try {
      await run();
      return fetchMock;
    } finally {
      global.fetch = originalFetch;
    }
  };

  it('deactivates both FCM and APNs VoIP tokens for the logged-out user', async () => {
    const { controller, authClient } = createController();
    const response = createResponse();

    let fetchCalls: unknown[][] = [];
    await withFetchMock(async () => {
      await controller.logout(
        {
          pushToken: 'fcm-token-that-is-long-enough',
          pushTokens: [
            { provider: 'fcm', token: 'fcm-token-that-is-long-enough' },
            { provider: 'apns_voip', token: 'voip-token-that-is-long-enough' },
          ],
        } as never,
        {
          cookies: {
            access_token: 'access-token',
            refresh_token: 'refresh-token',
          },
        } as never,
        response as never,
      );

      fetchCalls = fetchMockCalls(global.fetch);
    });

    expect(fetchCalls).toHaveLength(2);
    expect(fetchCalls).toEqual(
      expect.arrayContaining([
        [
          'http://notification-service:3015/notifications/push-tokens/deactivate',
          expect.objectContaining({
            headers: expect.objectContaining({
              'x-user-id': 'user-1',
              'x-notification-gateway-secret': 'gateway-secret',
            }),
            body: JSON.stringify({
              provider: 'fcm',
              token: 'fcm-token-that-is-long-enough',
            }),
          }),
        ],
        [
          'http://notification-service:3015/notifications/push-tokens/deactivate',
          expect.objectContaining({
            body: JSON.stringify({
              provider: 'apns_voip',
              token: 'voip-token-that-is-long-enough',
            }),
          }),
        ],
      ]),
    );
    expect(authClient.send).toHaveBeenNthCalledWith(1, 'auth.verify_token', {
      token: 'access-token',
    });
    expect(authClient.send).toHaveBeenNthCalledWith(2, 'auth.logout', {
      refreshToken: 'refresh-token',
    });
  });

  it('continues to support the legacy single FCM token payload', async () => {
    const { controller } = createController();
    const response = createResponse();

    let fetchCalls: unknown[][] = [];
    await withFetchMock(async () => {
      await controller.logout(
        { pushToken: 'fcm-token-that-is-long-enough' },
        {
          cookies: {
            access_token: 'access-token',
            refresh_token: 'refresh-token',
          },
        } as never,
        response as never,
      );

      fetchCalls = fetchMockCalls(global.fetch);
    });

    expect(fetchCalls).toHaveLength(1);
    expect(fetchCalls[0]?.[1]).toEqual(
      expect.objectContaining({
        body: JSON.stringify({
          provider: 'fcm',
          token: 'fcm-token-that-is-long-enough',
        }),
      }),
    );
  });

  it('forwards notification lifecycle metadata during logout cleanup', async () => {
    const { controller } = createController();
    const response = createResponse();

    let fetchCalls: unknown[][] = [];
    await withFetchMock(async () => {
      await controller.logout(
        {
          pushTokens: [
            {
              provider: 'fcm',
              token: 'fcm-token-that-is-long-enough',
              deviceId: 'installation-1',
              lifecycleVersion: 7,
            },
          ],
        } as never,
        {
          cookies: {
            access_token: 'access-token',
            refresh_token: 'refresh-token',
          },
        } as never,
        response as never,
      );

      fetchCalls = fetchMockCalls(global.fetch);
    });

    expect(fetchCalls[0]?.[1]).toEqual(
      expect.objectContaining({
        body: JSON.stringify({
          provider: 'fcm',
          token: 'fcm-token-that-is-long-enough',
          deviceId: 'installation-1',
          lifecycleVersion: 7,
        }),
      }),
    );
  });

  it('revokes the refresh session even when notification cleanup fails', async () => {
    const { controller, authClient } = createController();
    const response = createResponse();
    const originalFetch = global.fetch;
    global.fetch = jest
      .fn()
      .mockResolvedValue(
        new Response('notification service unavailable', { status: 503 }),
      );

    try {
      await expect(
        controller.logout(
          {
            pushTokens: [
              { provider: 'fcm', token: 'fcm-token-that-is-long-enough' },
            ],
          } as never,
          {
            cookies: {
              access_token: 'access-token',
              refresh_token: 'refresh-token',
            },
          } as never,
          response as never,
        ),
      ).resolves.toEqual({ message: 'Logged out successfully' });

      expect(authClient.send).toHaveBeenCalledWith('auth.verify_token', {
        token: 'access-token',
      });
      expect(authClient.send).toHaveBeenCalledWith('auth.logout', {
        refreshToken: 'refresh-token',
      });
      expect(response.clearCookie).toHaveBeenCalledWith(
        'access_token',
        expect.objectContaining({ path: '/' }),
      );
      expect(response.clearCookie).toHaveBeenCalledWith(
        'refresh_token',
        expect.objectContaining({ path: '/' }),
      );
    } finally {
      global.fetch = originalFetch;
    }
  });
});

type FetchMock = {
  mock: {
    calls: unknown[][];
  };
};

const fetchMockCalls = (fetch: typeof global.fetch): unknown[][] =>
  (fetch as unknown as FetchMock).mock.calls;
