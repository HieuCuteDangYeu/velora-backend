import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ConversationPrometheusMetricsService } from '../metrics/conversation-prometheus-metrics.service';
import { Conversation } from '../../domain/entities/conversation.entity';
import { Message } from '../../domain/entities/message.entity';

export interface NewMessageNotification {
  conversation: Conversation;
  message: Message;
  actorUserId: string;
}

interface IntakePayload {
  recipientUserIds: string[];
  actorUserId: string;
  conversationId: string;
  messageId: string;
  title: string;
  body: string;
}

/** notification-service refused the batch as invalid (400): one item is bad. */
export class NotificationBatchRejectedError extends Error {
  constructor() {
    super('Notification batch intake rejected the request');
  }
}

function validCreatedCount(value: unknown, max: number): boolean {
  return Number.isInteger(value) && Number(value) >= 0 && Number(value) <= max;
}

@Injectable()
export class NotificationServiceAdapter {
  private readonly notificationServiceUrl: string;
  private readonly internalSecret: string | undefined;
  // Set after an older notification-service answered 404 to the batch endpoint.
  private batchUnsupported = false;

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
    const payload = this.buildIntake({ conversation, message, actorUserId });
    if (!payload) return;
    const signal = this.requestSignal(shutdownSignal);
    const request = async () => {
      const response = await this.post('new-message', payload, signal);
      if (response.status !== 202) {
        await response.body?.cancel();
        throw new Error(`Notification intake HTTP ${response.status}`);
      }
      const value = (await response.json()) as Record<string, unknown> | null;
      if (
        !value ||
        value.status !== 'queued' ||
        value.recipientCount !== payload.recipientUserIds.length ||
        !validCreatedCount(value.createdCount, payload.recipientUserIds.length)
      ) {
        throw new Error('Notification intake did not confirm durable jobs');
      }
    };
    await (this.metrics
      ? this.metrics.measurePhase('notification', request)
      : request());
  }

  /**
   * Many messages in one request, stored atomically by notification-service: on
   * success every item has durable jobs, on any error none may be assumed.
   * A notification-service that predates the batch endpoint answers 404; then
   * the items go one by one through the single-message intake.
   */
  async notifyNewMessages(
    items: readonly NewMessageNotification[],
    shutdownSignal?: AbortSignal,
  ): Promise<void> {
    const payloads = items
      .map((item) => this.buildIntake(item))
      .filter((payload) => payload !== null);
    if (payloads.length === 0) return;
    if (this.batchUnsupported) {
      return this.notifyOneByOne(items, shutdownSignal);
    }
    const signal = this.requestSignal(shutdownSignal);
    let fallback = false;
    const request = async () => {
      const response = await this.post(
        'new-messages',
        { items: payloads },
        signal,
      );
      if (response.status === 404) {
        await response.body?.cancel();
        fallback = true;
        return;
      }
      if (response.status === 400) {
        await response.body?.cancel();
        throw new NotificationBatchRejectedError();
      }
      if (response.status !== 202) {
        await response.body?.cancel();
        throw new Error(`Notification batch intake HTTP ${response.status}`);
      }
      const value = (await response.json()) as Record<string, unknown> | null;
      const reported = Array.isArray(value?.items)
        ? (value.items as Record<string, unknown>[])
        : null;
      const total = payloads.reduce(
        (sum, payload) => sum + payload.recipientUserIds.length,
        0,
      );
      if (
        !value ||
        value.status !== 'queued' ||
        value.recipientCount !== total ||
        !validCreatedCount(value.createdCount, total) ||
        !reported ||
        reported.length !== payloads.length ||
        reported.some(
          (entry, index) =>
            entry?.messageId !== payloads[index].messageId ||
            entry?.recipientCount !== payloads[index].recipientUserIds.length,
        )
      ) {
        throw new Error(
          'Notification batch intake did not confirm durable jobs',
        );
      }
    };
    await (this.metrics
      ? this.metrics.measurePhase('notification_batch', request)
      : request());
    if (fallback) {
      this.batchUnsupported = true;
      await this.notifyOneByOne(items, shutdownSignal);
    }
  }

  private async notifyOneByOne(
    items: readonly NewMessageNotification[],
    shutdownSignal?: AbortSignal,
  ): Promise<void> {
    for (const item of items) {
      await this.notifyNewMessage(
        item.conversation,
        item.message,
        item.actorUserId,
        shutdownSignal,
      );
    }
  }

  private buildIntake({
    conversation,
    message,
    actorUserId,
  }: NewMessageNotification): IntakePayload | null {
    if (!this.internalSecret) {
      throw new Error('NOTIFICATION_INTERNAL_SECRET is missing');
    }
    const recipientUserIds = [...new Set(conversation.participantIds)].filter(
      (id) => Boolean(id) && id !== actorUserId,
    );
    if (recipientUserIds.length === 0) return null;

    const actorName = conversation.participants
      ?.find((participant) => participant.id === actorUserId)
      ?.name?.trim();
    const title = conversation.isGroup
      ? conversation.name?.trim() || 'Group chat'
      : actorName || 'New message';
    const messageBody = this.buildNotificationBody(message);
    return {
      recipientUserIds,
      actorUserId,
      conversationId: message.conversationId,
      messageId: message.id,
      title,
      body: conversation.isGroup
        ? `${actorName || 'Someone'}: ${messageBody}`
        : messageBody,
    };
  }

  private requestSignal(shutdownSignal?: AbortSignal): AbortSignal {
    const timeoutSignal = AbortSignal.timeout(5_000);
    return shutdownSignal
      ? AbortSignal.any([shutdownSignal, timeoutSignal])
      : timeoutSignal;
  }

  private post(path: string, body: unknown, signal: AbortSignal) {
    return fetch(
      `${this.notificationServiceUrl}/notifications/internal/${path}`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-internal-secret': this.internalSecret!,
        },
        body: JSON.stringify(body),
        signal,
      },
    );
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
