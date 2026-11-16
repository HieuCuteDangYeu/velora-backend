import {
  isReelIndexJob,
  REEL_INDEX_JOB_PATTERN,
} from '@common/processing/interfaces/reel-index-job.interface';
import { getReelIndexPrimaryQueue } from '@common/processing/reel-media-queue.constants';
import {
  isDeferredProviderQuotaFailure,
  ProcessReelIndexJobUseCase,
} from '@indexing/application/use-cases/process-reel-index-job.use-case';
import type { IReelIndexRetryPublisher } from '@indexing/domain/interfaces/reel-index-retry-publisher.interface';
import { Controller, Inject, Logger } from '@nestjs/common';
import { Ctx, EventPattern, Payload, RmqContext } from '@nestjs/microservices';
import type { Channel, ConsumeMessage } from 'amqplib';

@Controller()
export class ReelIndexingController {
  private readonly logger = new Logger(ReelIndexingController.name);

  constructor(
    private readonly processJob: ProcessReelIndexJobUseCase,
    @Inject('IReelIndexRetryPublisher')
    private readonly retryPublisher: IReelIndexRetryPublisher,
  ) {}

  @EventPattern(REEL_INDEX_JOB_PATTERN)
  async handle(
    @Payload() payload: unknown,
    @Ctx() context: RmqContext,
  ): Promise<void> {
    const { channel, message } = this.getDelivery(context);
    if (!isReelIndexJob(payload)) {
      this.logger.error('Rejecting malformed Reel index job to DLQ');
      channel.nack(message, false, false);
      return;
    }

    const retryNumber = this.getRetryNumber(message);
    const nextRetryNumber =
      retryNumber < 2 ? ((retryNumber + 1) as 1 | 2) : undefined;
    const queue = getReelIndexPrimaryQueue(payload.sourceLengthClass);

    try {
      const result = await this.processJob.execute({
        job: payload,
        allowReclaim: message.fields.redelivered,
        allowRetry: nextRetryNumber !== undefined,
        retryNumber,
        queuedAt: this.getQueuedAt(message, payload.createdAt),
      });
      if (result.status === 'RETRY' && nextRetryNumber !== undefined) {
        await this.retryPublisher.publishRetry(payload, nextRetryNumber);
        channel.ack(message);
        return;
      }
      if (result.status === 'PERMANENT_FAILURE' || result.status === 'RETRY') {
        if (isDeferredProviderQuotaFailure(result.error)) {
          // Not a retry problem: the AI provider's daily allowance is spent, and minutes of
          // queue retries cannot change that. The attempt is recorded as failed and the job
          // waits in the dead-letter queue until the index is re-run after the quota recovers.
          this.logger.warn(
            `Index job ${payload.jobId} for reel ${payload.reelId} dead-lettered from ${queue.queue}: visual provider quota exhausted; re-run the index once the quota recovers`,
          );
        } else {
          this.logger.error(
            `Index job ${payload.jobId} exhausted retries on ${queue.queue}: ${result.error.slice(0, 300)}`,
          );
        }
        channel.nack(message, false, false);
        return;
      }
      channel.ack(message);
    } catch (error: unknown) {
      const detail = error instanceof Error ? error.message : String(error);
      this.logger.error(
        `Index job ${payload.jobId} failed before durable handling: ${detail}`,
      );
      channel.nack(message, false, true);
    }
  }

  private getRetryNumber(message: ConsumeMessage): number {
    const parsed = Number(
      message.properties.headers?.['x-reel-index-retry-count'],
    );
    return Number.isInteger(parsed) && parsed >= 0 ? parsed : 0;
  }

  private getQueuedAt(message: ConsumeMessage, fallback: string): string {
    const timestamp = Number(message.properties.timestamp);
    return Number.isFinite(timestamp) && timestamp > 0
      ? new Date(timestamp).toISOString()
      : fallback;
  }

  private getDelivery(context: RmqContext): {
    channel: Channel;
    message: ConsumeMessage;
  } {
    return {
      channel: context.getChannelRef() as Channel,
      message: context.getMessage() as unknown as ConsumeMessage,
    };
  }
}
