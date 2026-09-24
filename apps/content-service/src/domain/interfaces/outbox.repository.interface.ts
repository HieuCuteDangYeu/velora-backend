import { OutboxEvent } from '../entities/outbox-event.entity';

export interface IOutboxRepository {
  claimPending(input: {
    limit: number;
    claimToken: string;
    dueBefore: Date;
    staleBefore: Date;
  }): Promise<OutboxEvent[]>;

  markPublished(input: {
    eventId: string;
    claimToken: string;
    publishedAt: Date;
  }): Promise<boolean>;

  markFailed(input: {
    eventId: string;
    claimToken: string;
    nextAttemptAt: Date;
    lastError: string;
  }): Promise<boolean>;
}
