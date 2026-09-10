import { Inject, Injectable } from '@nestjs/common';

import { INotificationJobRepository } from '../../domain/interfaces/notification-job.repository.interface';
import { ProcessNotificationJobUseCase } from './process-notification-job.use-case';

export type SendIncomingCallNotificationInput = {
  recipientUserId: string;
  initiatorId: string;
  targetUserId: string;
  conversationId: string;
  callId: string;
  callType: 'VOICE' | 'VIDEO';
  initiatorDisplayName: string;
  initiatorAvatarUrl?: string;
  ringTimeoutMs: number;
  expiresAt: string;
};

@Injectable()
export class SendIncomingCallNotificationUseCase {
  constructor(
    @Inject('INotificationJobRepository')
    private readonly notificationJobRepository: INotificationJobRepository,
    private readonly processNotificationJob: ProcessNotificationJobUseCase,
  ) {}

  async execute(input: SendIncomingCallNotificationInput) {
    const expiresAt = new Date(input.expiresAt);
    const job = await this.notificationJobRepository.create({
      type: 'INCOMING_CALL',
      recipientUserId: input.recipientUserId,
      actorUserId: input.initiatorId,
      conversationId: input.conversationId,
      callId: input.callId,
      title: input.initiatorDisplayName,
      body:
        input.callType === 'VIDEO'
          ? 'Incoming video call'
          : 'Incoming voice call',
      expiresAt,
      idempotencyKey: `incoming-call:${input.callId}:${input.recipientUserId}`,
      dataJson: {
        type: 'INCOMING_CALL',
        callId: input.callId,
        callType: input.callType,
        recipientUserId: input.recipientUserId,
        initiatorId: input.initiatorId,
        targetUserId: input.targetUserId,
        initiatorDisplayName: input.initiatorDisplayName,
        initiatorAvatarUrl: input.initiatorAvatarUrl,
        ringTimeoutMs: input.ringTimeoutMs,
        expiresAt: expiresAt.toISOString(),
      },
    });

    return this.processNotificationJob.execute(job);
  }
}
