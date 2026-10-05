import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ConversationPrometheusMetricsService } from '../metrics/conversation-prometheus-metrics.service';
import { Conversation } from '../../domain/entities/conversation.entity';
import { Message } from '../../domain/entities/message.entity';

type NewMessageNotificationPayload = {
  recipientUserIds: string[];
  actorUserId: string;
  conversationId: string;
  messageId: string;
  title: string;
  body: string;
};

@Injectable()
export class NotificationServiceAdapter {
  private readonly logger = new Logger(NotificationServiceAdapter.name);
  private readonly notificationServiceUrl: string;
  private readonly internalSecret: string | undefined;

  constructor(
    private readonly configService: ConfigService,
    private readonly metrics?: ConversationPrometheusMetricsService,
  ) {
    this.notificationServiceUrl = (
      this.configService.get<string>('NOTIFICATION_SERVICE_URL') ||
      'http://localhost:3015'
    ).replace(/\/$/, '');
    this.internalSecret = this.configService.get<string>(
      'NOTIFICATION_INTERNAL_SECRET',
    );
  }

  async notifyNewMessage(
    conversation: Conversation | null,
    message: Message,
    actorUserId: string,
  ) {
    if (!conversation) {
      return;
    }

    // Preserve the existing direct-chat guard exactly. PR3 only broadens group
    // delivery and must not change how malformed legacy direct rows behave.
    if (!conversation.isGroup && conversation.participantIds.length !== 2) {
      return;
    }

    const recipientUserIds = Array.from(
      new Set(
        conversation.participantIds.filter(
          (participantId) =>
            Boolean(participantId) && participantId !== actorUserId,
        ),
      ),
    );

    if (recipientUserIds.length === 0) {
      return;
    }

    if (!conversation.isGroup && recipientUserIds.length !== 1) {
      return;
    }

    const actorName = conversation.participants?.find(
      (participant) => participant.id === actorUserId,
    )?.name;
    const messageBody = this.buildNotificationBody(message);
    const title = conversation.isGroup
      ? conversation.name?.trim() || 'Group chat'
      : actorName?.trim() || 'New message';
    const body = conversation.isGroup
      ? `${actorName?.trim() || 'Someone'}: ${messageBody}`
      : messageBody;

    if (!this.internalSecret) {
      this.logger.warn(
        'Skipping new-message notification because NOTIFICATION_INTERNAL_SECRET is missing',
      );
      return;
    }

    const payload: NewMessageNotificationPayload = {
      recipientUserIds,
      actorUserId,
      conversationId: message.conversationId,
      messageId: message.id,
      title,
      body,
    };

    let response: Response;

    try {
      const startedAt = process.hrtime.bigint();
      let status: 'success' | 'error' = 'error';
      try {
        response = await this.postNewMessageNotification(payload);
        status = response.ok ? 'success' : 'error';
      } finally {
        this.metrics?.recordPhase(
          'notification',
          Number(process.hrtime.bigint() - startedAt) / 1e9,
          status,
        );
      }
    } catch (error) {
      this.logRequestFailure(message.id, error);
      return;
    }

    if (response.ok) {
      return;
    }

    // Rolling-deploy compatibility: an older notification-service only knows
    // recipientUserId. A 400 is the only status where we safely retry with the
    // legacy contract because the old schema rejects the batch before creating
    // any jobs. Never fallback on 5xx/network errors: the batch may have been
    // partially processed and retrying could duplicate notifications.
    if (response.status === 400) {
      await this.notifyUsingLegacyContract(payload);
      return;
    }

    const responseText = await response.text();

    this.logger.warn(
      `notification-service rejected message ${message.id} with status ${response.status}: ${responseText}`,
    );
  }

  private postNewMessageNotification(payload: NewMessageNotificationPayload) {
    return fetch(
      `${this.notificationServiceUrl}/notifications/internal/new-message`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-internal-secret': this.internalSecret!,
        },
        body: JSON.stringify(payload),
      },
    );
  }

  private async notifyUsingLegacyContract(
    payload: NewMessageNotificationPayload,
  ): Promise<void> {
    const responses = await Promise.allSettled(
      payload.recipientUserIds.map((recipientUserId) =>
        fetch(
          `${this.notificationServiceUrl}/notifications/internal/new-message`,
          {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'x-internal-secret': this.internalSecret!,
            },
            body: JSON.stringify({
              recipientUserId,
              actorUserId: payload.actorUserId,
              conversationId: payload.conversationId,
              messageId: payload.messageId,
              title: payload.title,
              body: payload.body,
            }),
          },
        ),
      ),
    );

    responses.forEach((result, index) => {
      const recipientUserId = payload.recipientUserIds[index];

      if (result.status === 'rejected') {
        this.logger.warn(
          `Failed legacy new-message notification for message ${payload.messageId} recipient ${recipientUserId}: ${this.readErrorMessage(result.reason)}`,
        );
        return;
      }

      if (!result.value.ok) {
        this.logger.warn(
          `notification-service rejected legacy message ${payload.messageId} recipient ${recipientUserId} with status ${result.value.status}`,
        );
      }
    });
  }

  private logRequestFailure(messageId: string, error: unknown): void {
    this.logger.warn(
      `Failed to call notification-service for message ${messageId}: ${this.readErrorMessage(error)}`,
    );
  }

  private readErrorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
  }

  private buildNotificationBody(message: Message) {
    const content = message.content.trim();

    if (content.length > 0) {
      return content;
    }

    switch (message.type) {
      case 'image':
        return '[Image]';
      case 'video':
        return '[Video]';
      case 'file':
        return '[File]';
      case 'reel':
        return '[Reel]';
      case 'call':
        return '[Call]';
      default:
        return 'You have a new message.';
    }
  }
}
