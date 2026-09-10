import { ServiceUnavailableException } from '@nestjs/common';

import { AuthController } from './auth.controller';

type NotificationForwardRequest = {
  path: string;
  userId: string;
  body: unknown;
};

type AuthControllerInternals = {
  forwardToNotificationService(
    input: NotificationForwardRequest,
  ): Promise<unknown>;
};

const forwardToNotificationService = (
  controller: AuthController,
  input: NotificationForwardRequest,
): Promise<unknown> =>
  (
    controller as unknown as AuthControllerInternals
  ).forwardToNotificationService(input);

describe('AuthController notification token cleanup', () => {
  const createController = (notificationGatewaySecret?: string) => {
    const authClient = {};
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

    return new AuthController(authClient as never, configService as never);
  };

  const withFetchMock = async (
    fetchMock: typeof fetch,
    run: () => Promise<void>,
  ) => {
    const descriptor = Object.getOwnPropertyDescriptor(global, 'fetch');

    Object.defineProperty(global, 'fetch', {
      configurable: true,
      value: fetchMock,
      writable: true,
    });

    try {
      await run();
    } finally {
      if (descriptor) {
        Object.defineProperty(global, 'fetch', descriptor);
      } else {
        delete (global as { fetch?: typeof fetch }).fetch;
      }
    }
  };

  it('forwards the gateway secret when cleaning up a logout token', async () => {
    const controller = createController('gateway-secret');
    const fetchMock = jest.fn().mockResolvedValue(
      new Response(JSON.stringify({ count: 1 }), {
        headers: { 'Content-Type': 'application/json' },
      }),
    );

    await withFetchMock(fetchMock, async () => {
      await expect(
        forwardToNotificationService(controller, {
          path: '/notifications/push-tokens/deactivate',
          userId: 'user-1',
          body: { provider: 'fcm', token: 'fcm-token-that-is-long-enough' },
        }),
      ).resolves.toEqual({ count: 1 });
    });

    expect(fetchMock).toHaveBeenCalledWith(
      'http://notification-service:3015/notifications/push-tokens/deactivate',
      expect.objectContaining({
        headers: expect.objectContaining({
          'x-user-id': 'user-1',
          'x-notification-gateway-secret': 'gateway-secret',
        }),
      }),
    );
  });

  it('fails closed when the gateway secret is missing', async () => {
    const controller = createController();

    await expect(
      forwardToNotificationService(controller, {
        path: '/notifications/push-tokens/deactivate',
        userId: 'user-1',
        body: { provider: 'fcm', token: 'fcm-token-that-is-long-enough' },
      }),
    ).rejects.toBeInstanceOf(ServiceUnavailableException);
  });
});
