import {
  InternalServerErrorException,
  UnauthorizedException,
} from '@nestjs/common';

import { DevPushController } from './dev-push.controller';

describe('DevPushController', () => {
  it('rejects requests without the internal secret', async () => {
    const sendTestPush = {
      execute: jest.fn(),
    };
    const controller = new DevPushController(sendTestPush as never);
    const previousInternalSecret = process.env.NOTIFICATION_INTERNAL_SECRET;

    process.env.NOTIFICATION_INTERNAL_SECRET = 'local-notification-secret';

    try {
      await expect(
        controller.sendTest(undefined, {
          title: 'Velora test',
          body: 'Backend Firebase Admin is working.',
        }),
      ).rejects.toBeInstanceOf(UnauthorizedException);

      expect(sendTestPush.execute).not.toHaveBeenCalled();
    } finally {
      if (previousInternalSecret === undefined) {
        delete process.env.NOTIFICATION_INTERNAL_SECRET;
      } else {
        process.env.NOTIFICATION_INTERNAL_SECRET = previousInternalSecret;
      }
    }
  });

  it('fails closed when the internal secret is not configured', async () => {
    const sendTestPush = {
      execute: jest.fn(),
    };
    const controller = new DevPushController(sendTestPush as never);
    const previousInternalSecret = process.env.NOTIFICATION_INTERNAL_SECRET;

    delete process.env.NOTIFICATION_INTERNAL_SECRET;

    try {
      await expect(
        controller.sendTest('local-notification-secret', {
          title: 'Velora test',
          body: 'Backend Firebase Admin is working.',
        }),
      ).rejects.toBeInstanceOf(InternalServerErrorException);

      expect(sendTestPush.execute).not.toHaveBeenCalled();
    } finally {
      if (previousInternalSecret === undefined) {
        delete process.env.NOTIFICATION_INTERNAL_SECRET;
      } else {
        process.env.NOTIFICATION_INTERNAL_SECRET = previousInternalSecret;
      }
    }
  });
});
