import {
  InternalServerErrorException,
  UnauthorizedException,
} from '@nestjs/common';

import { PushTokensController } from './push-tokens.controller';

describe('PushTokensController', () => {
  const pushToken = {
    provider: 'fcm' as const,
    platform: 'android' as const,
    token: 'fcm-token-that-is-long-enough',
  };

  const createController = () => {
    const registerPushToken = {
      execute: jest.fn(),
    };
    const deactivatePushToken = {
      execute: jest.fn(),
    };

    return {
      controller: new PushTokensController(
        registerPushToken as never,
        deactivatePushToken as never,
      ),
      registerPushToken,
      deactivatePushToken,
    };
  };

  const withGatewaySecret = async (
    gatewaySecret: string | undefined,
    run: () => Promise<void>,
  ) => {
    const previousGatewaySecret = process.env.NOTIFICATION_GATEWAY_SECRET;

    if (gatewaySecret === undefined) {
      delete process.env.NOTIFICATION_GATEWAY_SECRET;
    } else {
      process.env.NOTIFICATION_GATEWAY_SECRET = gatewaySecret;
    }

    try {
      await run();
    } finally {
      if (previousGatewaySecret === undefined) {
        delete process.env.NOTIFICATION_GATEWAY_SECRET;
      } else {
        process.env.NOTIFICATION_GATEWAY_SECRET = previousGatewaySecret;
      }
    }
  };

  it('rejects a token registration without gateway credentials', async () => {
    const { controller, registerPushToken } = createController();

    await withGatewaySecret('gateway-secret', async () => {
      await expect(
        controller.register('user-1', undefined, pushToken),
      ).rejects.toBeInstanceOf(UnauthorizedException);
    });

    expect(registerPushToken.execute).not.toHaveBeenCalled();
  });

  it('rejects an invalid gateway secret', async () => {
    const { controller, registerPushToken } = createController();

    await withGatewaySecret('gateway-secret', async () => {
      await expect(
        controller.register('user-1', 'wrong-secret', pushToken),
      ).rejects.toBeInstanceOf(UnauthorizedException);
    });

    expect(registerPushToken.execute).not.toHaveBeenCalled();
  });

  it('fails closed when the gateway secret is not configured', async () => {
    const { controller, registerPushToken } = createController();

    await withGatewaySecret(undefined, async () => {
      await expect(
        controller.register('user-1', 'gateway-secret', pushToken),
      ).rejects.toBeInstanceOf(InternalServerErrorException);
    });

    expect(registerPushToken.execute).not.toHaveBeenCalled();
  });

  it('registers a token when the gateway credentials are valid', async () => {
    const { controller, registerPushToken } = createController();
    registerPushToken.execute.mockResolvedValue({ id: 'token-1' });

    await withGatewaySecret('gateway-secret', async () => {
      await expect(
        controller.register('user-1', 'gateway-secret', pushToken),
      ).resolves.toEqual({ id: 'token-1' });
    });

    expect(registerPushToken.execute).toHaveBeenCalledWith('user-1', pushToken);
  });

  it('rejects lifecycle ordering metadata without a device id', async () => {
    const { controller, registerPushToken } = createController();

    await withGatewaySecret('gateway-secret', async () => {
      await expect(
        controller.register('user-1', 'gateway-secret', {
          ...pushToken,
          lifecycleVersion: 1,
        }),
      ).rejects.toThrow(
        'deviceId is required when lifecycleVersion is provided',
      );
    });

    expect(registerPushToken.execute).not.toHaveBeenCalled();
  });
});
