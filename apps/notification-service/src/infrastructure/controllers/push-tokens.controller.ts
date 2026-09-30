import {
  BadRequestException,
  Body,
  ConflictException,
  Controller,
  Headers,
  InternalServerErrorException,
  Post,
  UnauthorizedException,
} from '@nestjs/common';
import { timingSafeEqual } from 'node:crypto';
import { z } from 'zod';

import { DeactivatePushTokenUseCase } from '../../application/use-cases/deactivate-push-token.use-case';
import { RegisterPushTokenUseCase } from '../../application/use-cases/register-push-token.use-case';
import {
  FcmPushTokenInvalidatedError,
  PushTokenLifecycleConflictError,
} from '../../domain/errors/notification.errors';

const registerPushTokenSchema = z.discriminatedUnion('provider', [
  z.object({
    provider: z.literal('fcm'),
    platform: z.enum(['ios', 'android']),
    token: z.string().min(10),
    deviceId: z.string().optional(),
    appVersion: z.string().optional(),
    groupLifecycleVersion: z.number().int().min(1).max(2).optional(),
    lifecycleVersion: z.number().int().min(1).max(2_147_483_647).optional(),
  }),
  z.object({
    provider: z.literal('apns_voip'),
    platform: z.literal('ios'),
    token: z.string().min(10),
    deviceId: z.string().optional(),
    appVersion: z.string().optional(),
    groupLifecycleVersion: z.number().int().min(1).max(2).optional(),
    lifecycleVersion: z.number().int().min(1).max(2_147_483_647).optional(),
    bundleId: z.string().min(1),
    deliveryEnvironment: z.enum(['development', 'production']),
  }),
]);

const deactivatePushTokenSchema = z.discriminatedUnion('provider', [
  z.object({
    provider: z.literal('fcm'),
    token: z.string().min(10),
    deviceId: z.string().optional(),
    lifecycleVersion: z.number().int().min(1).max(2_147_483_647).optional(),
  }),
  z.object({
    provider: z.literal('apns_voip'),
    token: z.string().min(10),
    deviceId: z.string().optional(),
    lifecycleVersion: z.number().int().min(1).max(2_147_483_647).optional(),
  }),
]);

@Controller('notifications/push-tokens')
export class PushTokensController {
  constructor(
    private readonly registerPushToken: RegisterPushTokenUseCase,
    private readonly deactivatePushToken: DeactivatePushTokenUseCase,
  ) {}

  @Post()
  async register(
    @Headers('x-user-id') userId: string | undefined,
    @Headers('x-notification-gateway-secret') gatewaySecret: string | undefined,
    @Body() body: unknown,
  ) {
    const authenticatedUserId = this.assertGatewayRequest(
      userId,
      gatewaySecret,
    );

    const parsed = registerPushTokenSchema.safeParse(body);

    if (!parsed.success) {
      throw new BadRequestException(parsed.error.flatten());
    }

    this.assertVersionedLifecycleHasDeviceId(parsed.data);

    try {
      return await this.registerPushToken.execute(
        authenticatedUserId,
        parsed.data,
      );
    } catch (error) {
      if (error instanceof FcmPushTokenInvalidatedError) {
        throw new ConflictException({
          code: error.code,
          message: error.message,
        });
      }

      if (error instanceof PushTokenLifecycleConflictError) {
        throw new ConflictException(error.message);
      }

      throw error;
    }
  }

  @Post('deactivate')
  deactivate(
    @Headers('x-user-id') userId: string | undefined,
    @Headers('x-notification-gateway-secret') gatewaySecret: string | undefined,
    @Body() body: unknown,
  ) {
    const authenticatedUserId = this.assertGatewayRequest(
      userId,
      gatewaySecret,
    );

    const parsed = deactivatePushTokenSchema.safeParse(body);

    if (!parsed.success) {
      throw new BadRequestException(parsed.error.flatten());
    }

    this.assertVersionedLifecycleHasDeviceId(parsed.data);

    return this.deactivatePushToken.execute(authenticatedUserId, parsed.data);
  }

  private assertGatewayRequest(
    userId: string | undefined,
    gatewaySecret: string | undefined,
  ): string {
    const expectedSecret = process.env.NOTIFICATION_GATEWAY_SECRET;

    if (!expectedSecret) {
      throw new InternalServerErrorException(
        'Missing NOTIFICATION_GATEWAY_SECRET',
      );
    }

    if (
      !userId ||
      !gatewaySecret ||
      !this.secretsMatch(gatewaySecret, expectedSecret)
    ) {
      throw new UnauthorizedException(
        'Invalid notification gateway credentials',
      );
    }

    return userId;
  }

  private assertVersionedLifecycleHasDeviceId(input: {
    deviceId?: string;
    lifecycleVersion?: number;
  }) {
    if (input.lifecycleVersion !== undefined && !input.deviceId) {
      throw new BadRequestException(
        'deviceId is required when lifecycleVersion is provided',
      );
    }
  }

  private secretsMatch(actual: string, expected: string) {
    const actualBuffer = Buffer.from(actual);
    const expectedBuffer = Buffer.from(expected);

    return (
      actualBuffer.length === expectedBuffer.length &&
      timingSafeEqual(actualBuffer, expectedBuffer)
    );
  }
}
