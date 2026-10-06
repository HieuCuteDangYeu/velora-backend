import { Inject, Injectable } from '@nestjs/common';

import { INotificationJobRepository } from '../../domain/interfaces/notification-job.repository.interface';

export type SendNewMessageNotificationInput = {
  recipientUserIds: string[];
  actorUserId: string;
  conversationId: string;
  messageId: string;
  title: string;
  body: string;
};

@Injectable()
export class SendNewMessageNotificationUseCase {
  constructor(
    @Inject('INotificationJobRepository')
    private readonly notificationJobRepository: INotificationJobRepository,
  ) {}

  async execute(input: SendNewMessageNotificationInput) {
    const recipientUserIds = Array.from(
      new Set(
        input.recipientUserIds
          .map((recipientUserId) => recipientUserId.trim())
          .filter(Boolean),
      ),
    );

    const createdCount = await this.notificationJobRepository.enqueueMany(
      recipientUserIds.map((recipientUserId) => ({
        type: 'NEW_MESSAGE',
        recipientUserId,
        actorUserId: input.actorUserId,
        conversationId: input.conversationId,
        messageId: input.messageId,
        title: input.title,
        body: input.body,
        dataJson: {
          type: 'NEW_MESSAGE',
        },
        idempotencyKey: `new-message:${JSON.stringify([input.conversationId, input.messageId, recipientUserId])}`,
      })),
    );

    return {
      recipientCount: recipientUserIds.length,
      status: 'queued' as const,
      createdCount,
    };
  }
}
