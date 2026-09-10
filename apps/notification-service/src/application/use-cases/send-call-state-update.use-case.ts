import { Inject, Injectable } from '@nestjs/common';

import { INotificationJobRepository } from '../../domain/interfaces/notification-job.repository.interface';
import { ProcessNotificationJobUseCase } from './process-notification-job.use-case';

export type SendCallStateUpdateInput = {
  recipientUserIds: string[];
  iosRecipientUserIds?: string[];
  conversationId: string;
  callId: string;
  status: 'active' | 'rejected' | 'ended' | 'cancelled';
  reason?: string;
  answerActionId?: string;
  lifecycleRevision?: number;
  at: string;
};

type CallStateTargetPlatform = 'android' | 'ios';

@Injectable()
export class SendCallStateUpdateUseCase {
  constructor(
    @Inject('INotificationJobRepository')
    private readonly notificationJobRepository: INotificationJobRepository,
    private readonly processNotificationJob: ProcessNotificationJobUseCase,
  ) {}

  /**
   * State updates must survive a temporary FCM/APNs outage. Persist one
   * independently retryable job per recipient before attempting delivery so a
   * slow or offline device cannot make another recipient's update disappear.
   */
  async execute(input: SendCallStateUpdateInput) {
    const recipients = this.collectRecipients(input);

    if (recipients.size === 0) {
      return {
        status: 'skipped' as const,
        sendResult: this.emptySendResult(),
      };
    }

    const deliveries = await Promise.all(
      [...recipients.entries()].map(async ([recipientUserId, platforms]) => {
        const job = await this.notificationJobRepository.create({
          type: 'CALL_STATE_UPDATE',
          recipientUserId,
          conversationId: input.conversationId,
          callId: input.callId,
          title: 'Call update',
          body: '',
          idempotencyKey: this.getIdempotencyKey(input, recipientUserId),
          dataJson: {
            type: 'CALL_STATE_UPDATE',
            platforms: [...platforms].sort(),
            status: input.status,
            ...(input.reason ? { reason: input.reason } : {}),
            ...(input.answerActionId
              ? { answerActionId: input.answerActionId }
              : {}),
            ...(input.lifecycleRevision !== undefined
              ? { lifecycleRevision: input.lifecycleRevision }
              : {}),
            at: input.at,
          },
        });

        return this.processNotificationJob.execute(job);
      }),
    );
    const results = deliveries.flatMap(
      (delivery) => delivery.sendResult.results,
    );
    const sentCount = results.filter((result) => result.ok).length;
    const failedCount = results.length - sentCount;

    return {
      status:
        failedCount > 0
          ? ('failed' as const)
          : sentCount > 0
            ? ('sent' as const)
            : ('skipped' as const),
      sendResult: {
        totalTokens: results.length,
        sentCount,
        failedCount,
        results,
      },
    };
  }

  private collectRecipients(input: SendCallStateUpdateInput) {
    const recipients = new Map<string, Set<CallStateTargetPlatform>>();
    const addRecipient = (
      rawRecipientUserId: string,
      platform: CallStateTargetPlatform,
    ) => {
      const recipientUserId = rawRecipientUserId.trim();

      if (!recipientUserId) {
        return;
      }

      const platforms = recipients.get(recipientUserId) ?? new Set();
      platforms.add(platform);
      recipients.set(recipientUserId, platforms);
    };

    for (const recipientUserId of input.recipientUserIds) {
      addRecipient(recipientUserId, 'android');
    }

    const iosRecipientUserIds =
      input.iosRecipientUserIds ??
      (input.status === 'active' ? [] : input.recipientUserIds);

    for (const recipientUserId of iosRecipientUserIds) {
      addRecipient(recipientUserId, 'ios');
    }

    return recipients;
  }

  private emptySendResult() {
    return {
      totalTokens: 0,
      sentCount: 0,
      failedCount: 0,
      results: [],
    };
  }

  private getIdempotencyKey(
    input: SendCallStateUpdateInput,
    recipientUserId: string,
  ): string {
    // Lifecycle revision is the authoritative dedupe key. Keep a deterministic
    // fallback for legacy publishers during the compatibility window.
    const eventKey =
      input.lifecycleRevision !== undefined
        ? `revision:${input.lifecycleRevision}`
        : `legacy:${input.status}:${input.reason ?? ''}:${input.answerActionId ?? ''}:${input.at}`;

    return `call-state:${input.callId}:${recipientUserId}:${eventKey}`;
  }
}
