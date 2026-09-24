import {
  isReelMediaJob,
  REEL_MEDIA_JOB_EVENT_TYPE,
} from '@common/processing/interfaces/reel-media-job.interface';
import {
  isReelIndexJob,
  REEL_INDEX_JOB_EVENT_TYPE,
} from '@common/processing/interfaces/reel-index-job.interface';
import { Inject, Injectable, Logger } from '@nestjs/common';
import { randomUUID } from 'crypto';
import type { IOutboxRepository } from '../../domain/interfaces/outbox.repository.interface';
import type { IReelMediaJobPublisher } from '../../domain/interfaces/reel-media-job-publisher.interface';
import type { IReelIndexJobPublisher } from '../../domain/interfaces/reel-index-job-publisher.interface';

export interface DispatchOutboxEventsResult {
  claimed: number;
  published: number;
  failed: number;
  nextRetryDelayMs?: number;
}

@Injectable()
export class DispatchOutboxEventsUseCase {
  private readonly logger = new Logger(DispatchOutboxEventsUseCase.name);

  constructor(
    @Inject('IOutboxRepository')
    private readonly outboxRepository: IOutboxRepository,
    @Inject('IReelMediaJobPublisher')
    private readonly reelMediaJobPublisher: IReelMediaJobPublisher,
    @Inject('IReelIndexJobPublisher')
    private readonly reelIndexJobPublisher: IReelIndexJobPublisher,
  ) {}

  async execute(input: {
    batchSize: number;
    staleClaimMs: number;
  }): Promise<DispatchOutboxEventsResult> {
    const now = new Date();
    const claimToken = randomUUID();
    const events = await this.outboxRepository.claimPending({
      limit: input.batchSize,
      claimToken,
      dueBefore: now,
      staleBefore: new Date(now.getTime() - input.staleClaimMs),
    });
    const result: DispatchOutboxEventsResult = {
      claimed: events.length,
      published: 0,
      failed: 0,
    };

    for (const event of events) {
      try {
        if (
          event.eventType === REEL_MEDIA_JOB_EVENT_TYPE &&
          isReelMediaJob(event.payload)
        ) {
          await this.reelMediaJobPublisher.publish(event.payload);
        } else if (
          event.eventType === REEL_INDEX_JOB_EVENT_TYPE &&
          isReelIndexJob(event.payload)
        ) {
          await this.reelIndexJobPublisher.publish(event.payload);
        } else {
          throw new Error(`Unsupported outbox event ${event.eventType}`);
        }

        const marked = await this.outboxRepository.markPublished({
          eventId: event.id,
          claimToken,
          publishedAt: new Date(),
        });

        if (!marked) {
          throw new Error(`Lost outbox claim before marking ${event.id}`);
        }

        result.published += 1;
      } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error);
        const retryDelayMs = this.getRetryDelayMs(event.attemptCount);
        const nextAttemptAt = new Date(Date.now() + retryDelayMs);

        await this.outboxRepository.markFailed({
          eventId: event.id,
          claimToken,
          nextAttemptAt,
          lastError: message,
        });
        result.failed += 1;
        result.nextRetryDelayMs =
          result.nextRetryDelayMs === undefined
            ? retryDelayMs
            : Math.min(result.nextRetryDelayMs, retryDelayMs);

        this.logger.warn(
          `Outbox event ${event.id} publish failed on attempt ${event.attemptCount}: ${message}`,
        );
      }
    }

    return result;
  }

  getRetryDelayMs(attemptCount: number): number {
    const exponent = Math.max(0, Math.min(8, attemptCount - 1));

    return Math.min(5 * 60_000, 1000 * 2 ** exponent);
  }
}
