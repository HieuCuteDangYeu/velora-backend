export type NotificationJobType =
  | 'NEW_MESSAGE'
  | 'INCOMING_CALL'
  | 'CALL_STATE_UPDATE';
export type NotificationJobStatus =
  | 'pending'
  | 'processing'
  | 'sent'
  | 'failed'
  | 'skipped';

export type CreateNotificationJobInput = {
  type: NotificationJobType;
  recipientUserId: string;
  actorUserId?: string;
  conversationId?: string;
  messageId?: string;
  callId?: string;
  title: string;
  body: string;
  dataJson?: Record<string, unknown>;
  expiresAt?: Date;
  /**
   * Stable key for an externally delivered event. Replays must reuse the
   * original durable job instead of sending a second notification.
   */
  idempotencyKey?: string;
};

export type NotificationJobProps = {
  id: string;
  type: NotificationJobType;
  recipientUserId: string;
  actorUserId: string | null;
  conversationId: string | null;
  messageId: string | null;
  callId: string | null;
  title: string;
  body: string;
  dataJson: unknown;
  expiresAt: Date | null;
  status: NotificationJobStatus;
  attemptCount: number;
  nextAttemptAt: Date | null;
};

export class NotificationJob {
  readonly id: string;
  readonly type: NotificationJobType;
  readonly recipientUserId: string;
  readonly actorUserId: string | null;
  readonly conversationId: string | null;
  readonly messageId: string | null;
  readonly callId: string | null;
  readonly title: string;
  readonly body: string;
  readonly dataJson: unknown;
  readonly expiresAt: Date | null;
  readonly status: NotificationJobStatus;
  readonly attemptCount: number;
  readonly nextAttemptAt: Date | null;

  constructor(props: NotificationJobProps) {
    Object.assign(this, props);
  }
}
