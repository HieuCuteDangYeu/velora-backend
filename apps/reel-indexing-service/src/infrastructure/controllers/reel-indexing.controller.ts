import {
  isReelIndexJob,
  REEL_INDEX_JOB_PATTERN,
} from '@common/processing/interfaces/reel-index-job.interface';
import {
  getReelIndexPrimaryQueue,
  REEL_INDEX_QUOTA_ROTATION_HEADER,
  REEL_INDEX_QUOTA_ROTATION_MAX_AGE_MS,
} from '@common/processing/reel-media-queue.constants';
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
    const quotaRotation = this.getQuotaRotation(message);
    const queuedAt = this.getQueuedAt(message, payload.createdAt);

    try {
      const result = await this.processJob.execute({
        job: payload,
        allowReclaim: message.fields.redelivered,
        allowRetry: nextRetryNumber !== undefined,
        retryNumber,
        allowQuotaRotation: this.mayKeepRotating(payload.createdAt),
        queuedAt,
      });
      if (result.status === 'QUOTA_ROTATE') {
        // Every Groq organization is out of tokens for now. Do not hold the consumer and do not
        // use up the ordinary retries: put the job behind the others and look again shortly.
        // The pool answers at once while the keys are spent, so a pass costs no provider request.
        await this.retryPublisher.publishQuotaRotation(
          payload,
          quotaRotation + 1,
        );
        const text = `Index job ${payload.jobId} for reel ${payload.reelId} on ${queue.queue} put back behind the other jobs (pass ${quotaRotation + 1}): visual provider quota exhausted`;
        if (quotaRotation === 0) this.logger.warn(text);
        else this.logger.debug(text);
        channel.ack(message);
        return;
      }
      if (result.status === 'RETRY' && nextRetryNumber !== undefined) {
        await this.retryPublisher.publishRetry(payload, nextRetryNumber);
        channel.ack(message);
        return;
      }
      if (result.status === 'PERMANENT_FAILURE' || result.status === 'RETRY') {
        if (isDeferredProviderQuotaFailure(result.error)) {
          // Not a failure of the job and not a retry problem: the AI provider's allowance is spent,
          // and minutes of queue retries cannot change that. The attempt is already recorded as
          // FAILED with the reason, the half-built index was discarded and the previous index is
          // untouched, so the message is acknowledged instead of piling up in a dead-letter queue
          // nobody reads. The deferred visual retry worker, or a manual re-index, runs it again
          // once the quota has recovered.
          this.logger.warn(
            `Index job ${payload.jobId} for reel ${payload.reelId} on ${queue.queue} not run: visual provider quota exhausted; the attempt is recorded as failed, re-run the index once the quota recovers`,
          );
          channel.ack(message);
          return;
        }
        this.logger.error(
          `Index job ${payload.jobId} exhausted retries on ${queue.queue}: ${result.error.slice(0, 300)}`,
        );
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

  private getQuotaRotation(message: ConsumeMessage): number {
    const parsed = Number(
      message.properties.headers?.[REEL_INDEX_QUOTA_ROTATION_HEADER],
    );
    return Number.isInteger(parsed) && parsed >= 0 ? parsed : 0;
  }

  private mayKeepRotating(createdAt: string): boolean {
    const createdMs = Date.parse(createdAt);
    return (
      Number.isFinite(createdMs) &&
      Date.now() - createdMs < REEL_INDEX_QUOTA_ROTATION_MAX_AGE_MS
    );
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
