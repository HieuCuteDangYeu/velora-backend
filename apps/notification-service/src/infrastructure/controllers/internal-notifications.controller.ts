import {
  BadRequestException,
  Body,
  Controller,
  Headers,
  HttpCode,
  HttpStatus,
  InternalServerErrorException,
  Post,
  UnauthorizedException,
} from '@nestjs/common';
import { z } from 'zod';

import { SendNewMessageNotificationUseCase } from '../../application/use-cases/send-new-message-notification.use-case';

const newMessageNotificationSchema = z
  .object({
    recipientUserId: z.string().uuid().optional(),
    recipientUserIds: z.array(z.string().uuid()).optional(),
    actorUserId: z.string().min(1),
    conversationId: z.string().min(1),
    messageId: z.string().min(1),
    title: z.string().min(1),
    body: z.string().min(1),
  })
  .superRefine((value, context) => {
    const recipientCount =
      (value.recipientUserIds?.length ?? 0) + (value.recipientUserId ? 1 : 0);

    if (recipientCount === 0) {
      context.addIssue({
        code: 'custom',
        path: ['recipientUserIds'],
        message: 'At least one recipient user id is required',
      });
    }
  })
  .transform(({ recipientUserId, recipientUserIds, ...rest }) => ({
    ...rest,
    recipientUserIds: Array.from(
      new Set([
        ...(recipientUserIds ?? []),
        ...(recipientUserId ? [recipientUserId] : []),
      ]),
    ),
  }));

@Controller('notifications/internal')
export class InternalNotificationsController {
  constructor(
    private readonly sendNewMessageNotification: SendNewMessageNotificationUseCase,
  ) {}

  @Post('new-message')
  @HttpCode(HttpStatus.ACCEPTED)
  async sendNewMessage(
    @Headers('x-internal-secret') internalSecret: string | undefined,
    @Body() body: unknown,
  ) {
    this.assertInternalSecret(internalSecret);

    const parsed = newMessageNotificationSchema.safeParse(body);

    if (!parsed.success) {
      throw new BadRequestException(parsed.error.flatten());
    }

    return this.sendNewMessageNotification.execute(parsed.data);
  }

  private assertInternalSecret(internalSecret: string | undefined) {
    const expectedSecret = process.env.NOTIFICATION_INTERNAL_SECRET;

    if (!expectedSecret) {
      throw new InternalServerErrorException(
        'Missing NOTIFICATION_INTERNAL_SECRET',
      );
    }

    if (!internalSecret || internalSecret !== expectedSecret) {
      throw new UnauthorizedException('Invalid x-internal-secret');
    }
  }
}
