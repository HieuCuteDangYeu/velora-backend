import {
  CreateNotificationJobInput,
  NotificationJob,
} from '../entities/notification-job.entity';

export type NotificationBacklogStatus = 'pending' | 'failed' | 'processing';
export interface NotificationBacklogSnapshot {
  counts: Record<NotificationBacklogStatus, number>;
  oldestCreatedAt: Date | null;
}

export abstract class INotificationJobRepository {
  abstract create(input: CreateNotificationJobInput): Promise<NotificationJob>;
  /** Persist a batch atomically; replayed idempotency keys keep their state. */
  abstract enqueueMany(inputs: CreateNotificationJobInput[]): Promise<number>;
  /**
   * Atomically lease an eligible job. When requested, a NEW_MESSAGE without an
   * active FCM registration is completed as skipped in the same statement.
   * A null return means no eligible job; delivery must not run.
   */
  abstract claimForProcessing(
    id: string,
    options?: { skipNewMessageWithoutFcmToken: boolean },
  ): Promise<NotificationJob | null>;
  abstract markSent(id: string): Promise<NotificationJob>;
  abstract markFailed(
    id: string,
    error: string,
    nextAttemptAt?: Date,
  ): Promise<NotificationJob>;
  abstract markSkipped(id: string, reason: string): Promise<NotificationJob>;
  /** Unexpired unfinished jobs, including backoff and active leases, not just due work. */
  abstract readBacklog(): Promise<NotificationBacklogSnapshot>;
  abstract findRetryable(limit: number): Promise<NotificationJob[]>;
}
