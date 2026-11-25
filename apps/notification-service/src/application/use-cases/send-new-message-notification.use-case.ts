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
    const recipientUserIds = uniqueRecipients(input);
    const createdCount = await this.notificationJobRepository.enqueueMany(
      toJobs(input, recipientUserIds),
    );

    return {
      recipientCount: recipientUserIds.length,
      status: 'queued' as const,
      createdCount,
    };
  }

  // Many messages in one atomic statement: every job of every message is stored,
  // or none is. Replays are deduplicated per message and recipient as above.
  async executeMany(inputs: SendNewMessageNotificationInput[]) {
    const items = inputs.map((input) => ({
      input,
      recipientUserIds: uniqueRecipients(input),
    }));
    const createdCount = await this.notificationJobRepository.enqueueMany(
      items.flatMap(({ input, recipientUserIds }) =>
        toJobs(input, recipientUserIds),
      ),
    );

    return {
      status: 'queued' as const,
      createdCount,
      recipientCount: items.reduce(
        (total, item) => total + item.recipientUserIds.length,
        0,
      ),
      items: items.map(({ input, recipientUserIds }) => ({
        messageId: input.messageId,
        recipientCount: recipientUserIds.length,
      })),
    };
  }
}

function uniqueRecipients(input: SendNewMessageNotificationInput): string[] {
  return Array.from(
    new Set(
      input.recipientUserIds
        .map((recipientUserId) => recipientUserId.trim())
        .filter(Boolean),
    ),
  );
}

function toJobs(
  input: SendNewMessageNotificationInput,
  recipientUserIds: string[],
) {
  return recipientUserIds.map((recipientUserId) => ({
    type: 'NEW_MESSAGE' as const,
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
  }));
}
