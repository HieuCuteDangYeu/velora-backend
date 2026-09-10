import { FirebaseAdminGateway } from './firebase-admin.gateway';

describe('FirebaseAdminGateway', () => {
  it('sends iOS background data with the APNs background headers', async () => {
    const send = jest.fn().mockResolvedValue('message-id');
    const gateway = Object.create(
      FirebaseAdminGateway.prototype,
    ) as FirebaseAdminGateway;

    Object.defineProperty(gateway, 'messaging', {
      value: { send },
    });

    await gateway.send({
      token: 'ios-fcm-token',
      includeNotification: false,
      apnsContentAvailable: true,
      apnsBackground: true,
      data: {
        type: 'CALL_STATE_UPDATE',
      },
    });

    expect(send).toHaveBeenCalledWith(
      expect.objectContaining({
        token: 'ios-fcm-token',
        data: {
          type: 'CALL_STATE_UPDATE',
        },
        apns: {
          headers: {
            'apns-push-type': 'background',
            'apns-priority': '5',
          },
          payload: {
            aps: {
              'content-available': 1,
            },
          },
        },
      }),
    );
  });
});
