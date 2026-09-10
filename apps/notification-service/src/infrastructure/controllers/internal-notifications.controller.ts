import {
  BadRequestException,
  Body,
  Controller,
  Headers,
  InternalServerErrorException,
  Post,
  UnauthorizedException,
} from '@nestjs/common';
import { z } from 'zod';

import { SendCallStateUpdateUseCase } from '../../application/use-cases/send-call-state-update.use-case';
import { SendIncomingCallNotificationUseCase } from '../../application/use-cases/send-incoming-call-notification.use-case';
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

const incomingCallNotificationSchema = z.object({
  recipientUserId: z.string().uuid(),
  initiatorId: z.string().min(1),
  targetUserId: z.string().min(1),
  conversationId: z.string().min(1),
  callId: z.string().min(1),
  callType: z.enum(['VOICE', 'VIDEO']),
  initiatorDisplayName: z.string().min(1),
  initiatorAvatarUrl: z.string().min(1).optional(),
  ringTimeoutMs: z.number().int().positive(),
  expiresAt: z.string().datetime(),
});

const callStateUpdateSchema = z.object({
  recipientUserIds: z.array(z.string().uuid()).min(1),
  iosRecipientUserIds: z.array(z.string().uuid()).min(1).optional(),
  conversationId: z.string().min(1),
  callId: z.string().min(1),
  status: z.enum(['active', 'rejected', 'ended', 'cancelled']),
  reason: z.string().min(1).optional(),
  answerActionId: z.string().min(1).optional(),
  lifecycleRevision: z.number().int().nonnegative().optional(),
  at: z.string().datetime(),
});

@Controller('notifications/internal')
export class InternalNotificationsController {
  constructor(
    private readonly sendNewMessageNotification: SendNewMessageNotificationUseCase,
    private readonly sendIncomingCallNotification: SendIncomingCallNotificationUseCase,
    private readonly sendCallStateUpdateUseCase: SendCallStateUpdateUseCase,
  ) {}

  @Post('new-message')
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

  @Post('incoming-call')
  async sendIncomingCall(
    @Headers('x-internal-secret') internalSecret: string | undefined,
    @Body() body: unknown,
  ) {
    this.assertInternalSecret(internalSecret);

    const parsed = incomingCallNotificationSchema.safeParse(body);

    if (!parsed.success) {
      throw new BadRequestException(parsed.error.flatten());
    }

    return this.sendIncomingCallNotification.execute(parsed.data);
  }

  @Post('call-state-update')
  async sendCallStateUpdate(
    @Headers('x-internal-secret') internalSecret: string | undefined,
    @Body() body: unknown,
  ) {
    this.assertInternalSecret(internalSecret);

    const parsed = callStateUpdateSchema.safeParse(body);

    if (!parsed.success) {
      throw new BadRequestException(parsed.error.flatten());
    }

    return this.sendCallStateUpdateUseCase.execute(parsed.data);
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
