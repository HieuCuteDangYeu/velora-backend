import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ConversationPrometheusMetricsService } from '../metrics/conversation-prometheus-metrics.service';
import { Conversation } from '../../domain/entities/conversation.entity';
import { Message } from '../../domain/entities/message.entity';

@Injectable()
export class NotificationServiceAdapter {
  private readonly notificationServiceUrl: string;
  private readonly internalSecret: string | undefined;

  constructor(
    configService: ConfigService,
    private readonly metrics?: ConversationPrometheusMetricsService,
  ) {
    this.notificationServiceUrl = (
      configService.get<string>('NOTIFICATION_SERVICE_URL') ||
      'http://localhost:3015'
    ).replace(/\/$/, '');
    this.internalSecret = configService.get<string>(
      'NOTIFICATION_INTERNAL_SECRET',
    );
  }

  // A successful HTTP response alone does not establish durable intake.
  // Ambiguous responses are replayed with the same message/recipient dedupe key.
  async notifyNewMessage(
    conversation: Conversation,
    message: Message,
    actorUserId: string,
    shutdownSignal?: AbortSignal,
  ): Promise<void> {
    if (!this.internalSecret) {
      throw new Error('NOTIFICATION_INTERNAL_SECRET is missing');
    }
    const recipientUserIds = [...new Set(conversation.participantIds)].filter(
      (id) => Boolean(id) && id !== actorUserId,
    );
    if (recipientUserIds.length === 0) return;

    const actorName = conversation.participants
      ?.find((participant) => participant.id === actorUserId)
      ?.name?.trim();
    const title = conversation.isGroup
      ? conversation.name?.trim() || 'Group chat'
      : actorName || 'New message';
    const messageBody = this.buildNotificationBody(message);
    const timeoutSignal = AbortSignal.timeout(5_000);
    const signal = shutdownSignal
      ? AbortSignal.any([shutdownSignal, timeoutSignal])
      : timeoutSignal;
    const request = async () => {
      const response = await fetch(
        `${this.notificationServiceUrl}/notifications/internal/new-message`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-internal-secret': this.internalSecret!,
          },
          body: JSON.stringify({
            recipientUserIds,
            actorUserId,
            conversationId: message.conversationId,
            messageId: message.id,
            title,
            body: conversation.isGroup
              ? `${actorName || 'Someone'}: ${messageBody}`
              : messageBody,
          }),
          signal,
        },
      );
      if (response.status !== 202) {
        await response.body?.cancel();
        throw new Error(`Notification intake HTTP ${response.status}`);
      }
      const receipt: unknown = await response.json();
      const value = receipt as Record<string, unknown> | null;
      if (
        !value ||
        value.status !== 'queued' ||
        value.recipientCount !== recipientUserIds.length ||
        !Number.isInteger(value.createdCount) ||
        Number(value.createdCount) < 0 ||
        Number(value.createdCount) > recipientUserIds.length
      ) {
        throw new Error('Notification intake did not confirm durable jobs');
      }
    };
    await (this.metrics
      ? this.metrics.measurePhase('notification', request)
      : request());
  }

  private buildNotificationBody(message: Message): string {
    const content = message.content.trim();
    if (content) return content;
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
        return 'You have a new message';
    }
  }
}
