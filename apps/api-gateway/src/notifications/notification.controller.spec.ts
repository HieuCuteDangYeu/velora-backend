import { ServiceUnavailableException } from '@nestjs/common';

import { NotificationController } from './notification.controller';

describe('NotificationController', () => {
  const registerBody = {
    provider: 'fcm',
    platform: 'android',
    token: 'fcm-token-that-is-long-enough',
  };

  const createController = (notificationGatewaySecret?: string) => {
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

    return new NotificationController(configService as never);
  };

  it('forwards the gateway secret with a registered user id', async () => {
    const controller = createController('gateway-secret');
    const fetchSpy = jest.spyOn(global, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ id: 'token-1' }), {
        headers: { 'Content-Type': 'application/json' },
      }),
    );

    try {
      await expect(
        controller.registerPushToken(
          { user: { id: 'user-1' } } as never,
          registerBody,
        ),
      ).resolves.toEqual({ id: 'token-1' });

      expect(fetchSpy).toHaveBeenCalledWith(
        'http://notification-service:3015/notifications/push-tokens',
        expect.objectContaining({
          headers: expect.objectContaining({
            'x-user-id': 'user-1',
            'x-notification-gateway-secret': 'gateway-secret',
          }),
        }),
      );
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it('fails closed when the gateway secret is missing', async () => {
    const controller = createController();

    await expect(
      controller.registerPushToken(
        { user: { id: 'user-1' } } as never,
        registerBody,
      ),
    ).rejects.toBeInstanceOf(ServiceUnavailableException);
  });
});
