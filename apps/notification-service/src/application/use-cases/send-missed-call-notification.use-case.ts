import { Inject, Injectable } from '@nestjs/common';

import { INotificationJobRepository } from '../../domain/interfaces/notification-job.repository.interface';
import { ProcessNotificationJobUseCase } from './process-notification-job.use-case';

export type SendMissedCallNotificationInput = {
  /** Decided by call-service (missedUserIds); never inferred here. */
  recipientUserIds: string[];
  callId: string;
  /** Group invitation per recipient, so a re-invite can be missed again. */
  invitationIdByUserId?: Record<string, string>;
  conversationId: string;
  callType: 'VOICE' | 'VIDEO';
  isGroupCall?: boolean;
  groupName?: string;
  initiatorId: string;
  initiatorDisplayName: string;
};

@Injectable()
export class SendMissedCallNotificationUseCase {
  constructor(
    @Inject('INotificationJobRepository')
    private readonly notificationJobRepository: INotificationJobRepository,
    private readonly processNotificationJob: ProcessNotificationJobUseCase,
  ) {}

  /**
   * One durable job per recipient, sent right away and retried like a new
   * message notification. Replays of the same call event reuse the job.
   */
  async execute(input: SendMissedCallNotificationInput) {
    const recipientUserIds = [
      ...new Set(
        input.recipientUserIds
          .map((userId) => userId.trim())
          .filter((userId) => userId && userId !== input.initiatorId),
      ),
    ];
    const { title, body } = this.buildText(input);

    return Promise.all(
      recipientUserIds.map(async (recipientUserId) => {
        const occurrence =
          input.invitationIdByUserId?.[recipientUserId] ?? input.callId;
        const job = await this.notificationJobRepository.create({
          type: 'MISSED_CALL',
          recipientUserId,
          actorUserId: input.initiatorId,
          conversationId: input.conversationId,
          callId: input.callId,
          title,
          body,
          dataJson: {
            type: 'MISSED_CALL',
            callType: input.callType,
            ...(input.isGroupCall ? { isGroupCall: true } : {}),
          },
          idempotencyKey: `missed-call:${JSON.stringify([occurrence, recipientUserId])}`,
        });
        return this.processNotificationJob.execute(job);
      }),
    );
  }

  private buildText(input: SendMissedCallNotificationInput) {
    const kind = input.callType === 'VIDEO' ? 'video' : 'voice';
    if (input.isGroupCall) {
      return {
        title: input.groupName || 'Group call',
        body: `Missed group ${kind} call from ${input.initiatorDisplayName}`,
      };
    }
    return {
      title: input.initiatorDisplayName,
      body: `Missed ${kind} call`,
    };
  }
}
