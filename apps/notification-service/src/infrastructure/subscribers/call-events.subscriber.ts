import { Controller, Logger } from '@nestjs/common';
import { Ctx, EventPattern, Payload, RmqContext } from '@nestjs/microservices';
import type { Channel, ConsumeMessage } from 'amqplib';
import { z } from 'zod';

import { SendCallStateUpdateUseCase } from '../../application/use-cases/send-call-state-update.use-case';
import { SendIncomingCallNotificationUseCase } from '../../application/use-cases/send-incoming-call-notification.use-case';

const callLifecyclePayloadSchema = z.object({
  callId: z.string().min(1),
  conversationId: z.string().min(1),
  initiatorId: z.string().min(1),
  targetUserId: z.string().min(1),
  recipientUserId: z.string().min(1),
  userId: z.string().min(1),
  callType: z.enum(['VOICE', 'VIDEO']),
  initiatorDisplayName: z.string().min(1),
  initiatorAvatarUrl: z.string().min(1).optional(),
  ringTimeoutMs: z.number().int().positive(),
  expiresAt: z.string().datetime(),
  reason: z.string().min(1).optional(),
  answerActionId: z.string().min(1).optional(),
  lifecycleRevision: z.number().int().nonnegative().optional(),
  at: z.string().datetime(),
});

type CallLifecycleEvent =
  | 'call.initiated'
  | 'call.answered'
  | 'call.ended'
  | 'call.rejected';

@Controller()
export class CallEventsSubscriber {
  private readonly logger = new Logger(CallEventsSubscriber.name);

  constructor(
    private readonly sendIncomingCallNotification: SendIncomingCallNotificationUseCase,
    private readonly sendCallStateUpdate: SendCallStateUpdateUseCase,
  ) {}

  @EventPattern('call.initiated')
  async handleCallInitiated(
    @Payload() payload: unknown,
    @Ctx() context: RmqContext,
  ) {
    await this.handle('call.initiated', payload, context);
  }

  @EventPattern('call.answered')
  async handleCallAnswered(
    @Payload() payload: unknown,
    @Ctx() context: RmqContext,
  ) {
    await this.handle('call.answered', payload, context);
  }

  @EventPattern('call.ended')
  async handleCallEnded(
    @Payload() payload: unknown,
    @Ctx() context: RmqContext,
  ) {
    await this.handle('call.ended', payload, context);
  }

  @EventPattern('call.rejected')
  async handleCallRejected(
    @Payload() payload: unknown,
    @Ctx() context: RmqContext,
  ) {
    await this.handle('call.rejected', payload, context);
  }

  private async handle(
    event: CallLifecycleEvent,
    payload: unknown,
    context: RmqContext,
  ) {
    const { channel, message } = this.getDelivery(context);
    const parsed = callLifecyclePayloadSchema.safeParse(payload);

    if (!parsed.success) {
      this.logger.error(`Discarding malformed ${event} lifecycle event`);
      channel.nack(message, false, false);
      return;
    }

    try {
      if (event === 'call.initiated') {
        await this.sendIncomingCallNotification.execute({
          recipientUserId: parsed.data.recipientUserId,
          initiatorId: parsed.data.initiatorId,
          targetUserId: parsed.data.targetUserId,
          conversationId: parsed.data.conversationId,
          callId: parsed.data.callId,
          callType: parsed.data.callType,
          initiatorDisplayName: parsed.data.initiatorDisplayName,
          initiatorAvatarUrl: parsed.data.initiatorAvatarUrl,
          ringTimeoutMs: parsed.data.ringTimeoutMs,
          expiresAt: parsed.data.expiresAt,
        });
      } else {
        await this.sendCallStateUpdate.execute({
          recipientUserIds: [parsed.data.initiatorId, parsed.data.targetUserId],
          ...(event === 'call.answered'
            ? { iosRecipientUserIds: [parsed.data.targetUserId] }
            : {}),
          conversationId: parsed.data.conversationId,
          callId: parsed.data.callId,
          status: this.callStateStatus(event, parsed.data.reason),
          reason: parsed.data.reason,
          answerActionId: parsed.data.answerActionId,
          lifecycleRevision: parsed.data.lifecycleRevision,
          at: parsed.data.at,
        });
      }

      channel.ack(message);
    } catch (error) {
      this.logger.error(
        `Failed to persist ${event} lifecycle notification; requeueing`,
        error instanceof Error ? error.stack : String(error),
      );
      channel.nack(message, false, true);
    }
  }

  private callStateStatus(
    event: Exclude<CallLifecycleEvent, 'call.initiated'>,
    reason?: string,
  ): 'active' | 'rejected' | 'ended' | 'cancelled' {
    if (event === 'call.answered') return 'active';
    if (event === 'call.rejected') return 'rejected';
    return reason === 'cancelled' ? 'cancelled' : 'ended';
  }

  private getDelivery(context: RmqContext): {
    channel: Channel;
    message: ConsumeMessage;
  } {
    return {
      channel: context.getChannelRef() as Channel,
      message: context.getMessage() as unknown as ConsumeMessage,
    };
  }
}
