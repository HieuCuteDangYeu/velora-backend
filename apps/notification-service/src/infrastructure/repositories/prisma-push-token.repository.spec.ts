import { PrismaPushTokenRepository } from './prisma-push-token.repository';

describe('PrismaPushTokenRepository', () => {
  it('retires prior active tokens for the same provider and installation', async () => {
    type UpdateManyArgs = {
      where: {
        userId: string;
        provider: string;
        platform: string;
        deviceId?: string;
        token: { not: string };
        isActive: boolean;
      };
      data: {
        isActive: boolean;
        lastSeenAt: Date;
      };
    };
    let update: UpdateManyArgs | undefined;
    const updateMany = (args: UpdateManyArgs) => {
      update = args;
      return Promise.resolve({ count: 1 });
    };
    const prisma = {
      pushToken: {
        updateMany: jest.fn(updateMany),
      },
    };
    const repository = new PrismaPushTokenRepository(prisma as never);
    const input = {
      provider: 'fcm' as const,
      platform: 'ios' as const,
      token: 'fcm-token-that-is-long-enough',
      deviceId: 'installation-1',
      lifecycleVersion: 2,
    };

    await repository.deactivateOtherDeviceTokens('user-1', input);

    expect(update?.where).toEqual({
      userId: 'user-1',
      provider: 'fcm',
      platform: 'ios',
      deviceId: 'installation-1',
      token: { not: 'fcm-token-that-is-long-enough' },
      isActive: true,
    });
    expect(update?.data.isActive).toBe(false);
    expect(update?.data.lastSeenAt).toBeInstanceOf(Date);
  });

  it('maps persistence records to domain push tokens', async () => {
    const record = {
      id: 'push-token-1',
      userId: 'user-1',
      provider: 'fcm',
      platform: 'android',
      token: 'fcm-token-that-is-long-enough',
      deviceId: 'installation-1',
      appVersion: '1.0.0',
      bundleId: null,
      deliveryEnvironment: null,
      isActive: true,
      lastSeenAt: new Date(),
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    const prisma = {
      pushToken: {
        findMany: jest.fn().mockResolvedValue([record]),
      },
    };
    const repository = new PrismaPushTokenRepository(prisma as never);

    await expect(repository.findActiveByUserId('user-1')).resolves.toEqual([
      expect.objectContaining({
        id: 'push-token-1',
        provider: 'fcm',
        platform: 'android',
      }),
    ]);
  });
});
