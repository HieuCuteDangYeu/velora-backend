import { Injectable } from '@nestjs/common';
import type { PushToken as PrismaPushToken } from '@prisma/notification-client';

import {
  DeactivatePushTokenInput,
  PushDeliveryEnvironment,
  PushPlatform,
  PushProvider,
  PushToken,
  RegisterPushTokenInput,
} from '../../domain/entities/push-token.entity';
import {
  IPushTokenRepository,
  PushTokenFilters,
  UpdateCount,
} from '../../domain/interfaces/push-token.repository.interface';
import { PrismaService } from '../prisma/prisma.service';

@Injectable()
export class PrismaPushTokenRepository implements IPushTokenRepository {
  constructor(private readonly prisma: PrismaService) {}

  async upsert(
    userId: string,
    input: RegisterPushTokenInput,
  ): Promise<PushToken> {
    const record = await this.prisma.pushToken.upsert({
      where: {
        provider_token: {
          provider: input.provider,
          token: input.token,
        },
      },
      create: {
        userId,
        provider: input.provider,
        platform: input.platform,
        token: input.token,
        deviceId: input.deviceId,
        appVersion: input.appVersion,
        groupLifecycleVersion: input.groupLifecycleVersion ?? 1,
        bundleId: input.provider === 'apns_voip' ? input.bundleId : null,
        deliveryEnvironment:
          input.provider === 'apns_voip' ? input.deliveryEnvironment : null,
        isActive: true,
        lastSeenAt: new Date(),
      },
      update: {
        userId,
        platform: input.platform,
        deviceId: input.deviceId,
        appVersion: input.appVersion,
        groupLifecycleVersion: input.groupLifecycleVersion ?? 1,
        bundleId: input.provider === 'apns_voip' ? input.bundleId : null,
        deliveryEnvironment:
          input.provider === 'apns_voip' ? input.deliveryEnvironment : null,
        isActive: true,
        lastSeenAt: new Date(),
      },
    });

    return this.toDomain(record);
  }

  deactivate(
    userId: string,
    input: DeactivatePushTokenInput,
    includeLegacyDeviceRegistration: boolean,
  ): Promise<UpdateCount> {
    return this.prisma.pushToken.updateMany({
      where: {
        userId,
        provider: input.provider,
        token: input.token,
        ...(includeLegacyDeviceRegistration
          ? {
              OR: [{ deviceId: input.deviceId }, { deviceId: null }],
            }
          : {}),
        isActive: true,
      },
      data: {
        isActive: false,
        lastSeenAt: new Date(),
      },
    });
  }

  deactivateRegistration(
    userId: string,
    input: RegisterPushTokenInput,
  ): Promise<UpdateCount> {
    return this.prisma.pushToken.updateMany({
      where: {
        userId,
        provider: input.provider,
        token: input.token,
        deviceId: input.deviceId,
        isActive: true,
      },
      data: {
        isActive: false,
        lastSeenAt: new Date(),
      },
    });
  }

  deactivateOtherDeviceTokens(
    userId: string,
    input: RegisterPushTokenInput,
  ): Promise<UpdateCount> {
    return this.prisma.pushToken.updateMany({
      where: {
        userId,
        provider: input.provider,
        platform: input.platform,
        deviceId: input.deviceId,
        token: { not: input.token },
        isActive: true,
      },
      data: {
        isActive: false,
        lastSeenAt: new Date(),
      },
    });
  }

  async findActiveByUserId(
    userId: string,
    filters?: PushTokenFilters,
  ): Promise<PushToken[]> {
    const records = await this.prisma.pushToken.findMany({
      where: {
        userId,
        ...(filters?.provider ? { provider: filters.provider } : {}),
        ...(filters?.platform ? { platform: filters.platform } : {}),
        isActive: true,
      },
      orderBy: {
        updatedAt: 'desc',
      },
    });

    return records.map((record) => this.toDomain(record));
  }

  async findLatestActiveFcm(): Promise<PushToken | null> {
    const record = await this.prisma.pushToken.findFirst({
      where: {
        provider: 'fcm',
        isActive: true,
      },
      orderBy: {
        updatedAt: 'desc',
      },
    });

    return record ? this.toDomain(record) : null;
  }

  deactivateById(id: string): Promise<UpdateCount> {
    return this.prisma.pushToken.updateMany({
      where: {
        id,
        isActive: true,
      },
      data: {
        isActive: false,
        lastSeenAt: new Date(),
      },
    });
  }

  private toDomain(record: PrismaPushToken): PushToken {
    return new PushToken({
      id: record.id,
      userId: record.userId,
      provider: record.provider as PushProvider,
      platform: record.platform as PushPlatform,
      token: record.token,
      deviceId: record.deviceId,
      appVersion: record.appVersion,
      groupLifecycleVersion: record.groupLifecycleVersion,
      bundleId: record.bundleId,
      deliveryEnvironment:
        record.deliveryEnvironment as PushDeliveryEnvironment | null,
      isActive: record.isActive,
      lastSeenAt: record.lastSeenAt,
      createdAt: record.createdAt,
      updatedAt: record.updatedAt,
    });
  }
}
