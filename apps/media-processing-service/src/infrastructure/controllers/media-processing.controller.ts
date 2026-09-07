import type { ProcessVideoThumbnailPayload } from '@common/media/dtos/process-video-thumbnail.dto';
import {
  isReelMediaJob,
  REEL_MEDIA_JOB_PATTERN,
} from '@common/processing/interfaces/reel-media-job.interface';
import { getReelMediaPrimaryQueue } from '@common/processing/reel-media-queue.constants';
import { Controller, Inject, Logger } from '@nestjs/common';
import { Ctx, EventPattern, Payload, RmqContext } from '@nestjs/microservices';
import type { IReelMediaRetryPublisher } from '@processing/domain/interfaces/reel-media-retry-publisher.interface';
import type { Channel, ConsumeMessage } from 'amqplib';
import { ProcessChatVideoUseCase } from '../../application/use-cases/process-chat-video.use-case';
import { ProcessReelUseCase } from '../../application/use-cases/process-reel.use-case';

@Controller()
export class MediaProcessingController {
  private readonly logger = new Logger(MediaProcessingController.name);

  constructor(
    private readonly processReelUseCase: ProcessReelUseCase,
    private readonly processChatVideoUseCase: ProcessChatVideoUseCase,
    @Inject('IReelMediaRetryPublisher')
    private readonly reelMediaRetryPublisher: IReelMediaRetryPublisher,
  ) {}

  @EventPattern(REEL_MEDIA_JOB_PATTERN)
  async handleReelMediaJob(
    @Payload() payload: unknown,
    @Ctx() context: RmqContext,
  ): Promise<void> {
    const { channel, message } = this.getDelivery(context);

    if (!isReelMediaJob(payload)) {
      this.logger.error('Rejecting malformed Reel media job to DLQ');
      channel.nack(message, false, false);
      return;
    }

    const job = payload;
    const retryNumber = this.getRetryNumber(context);
    const nextRetryNumber =
      retryNumber < 2 ? ((retryNumber + 1) as 1 | 2) : undefined;
    const queue = getReelMediaPrimaryQueue(job.expectedLengthClass);

    try {
      const result = await this.processReelUseCase.execute({
        reelId: job.reelId,
        mediaKey: job.mediaKey,
        userId: job.userId,
        processingAttemptId: job.mediaAttemptId,
        queuedAt: job.createdAt,
        expectedLengthClass: job.expectedLengthClass,
        queueName: queue.queue,
        retryNumber,
        allowReclaim: message.fields.redelivered,
        allowRetry: nextRetryNumber !== undefined,
        edit: job.edit,
      });

      if (result.status === 'RETRY' && nextRetryNumber !== undefined) {
        await this.reelMediaRetryPublisher.publishRetry(job, nextRetryNumber);
        channel.ack(message);
        return;
      }

      if (result.status === 'PERMANENT_FAILURE' || result.status === 'RETRY') {
        channel.nack(message, false, false);
        return;
      }

      channel.ack(message);
    } catch (error: unknown) {
      const detail = error instanceof Error ? error.message : String(error);
      this.logger.error(
        `Reel media job ${job.jobId} failed before durable handling: ${detail}`,
      );
      channel.nack(message, false, true);
    }
  }

  @EventPattern('reel.created')
  async handleReelCreated(
    @Payload()
    data: {
      reelId: string;
      mediaKey: string;
      userId: string;
      processingAttemptId?: string;
      queuedAt?: string;
      title?: string;
      description?: string;
      tags?: string[];
    },
    @Ctx() context: RmqContext,
  ): Promise<void> {
    const { channel, message } = this.getDelivery(context);

    try {
      await this.processReelUseCase.execute({
        ...data,
        allowReclaim: message.fields.redelivered,
        allowRetry: false,
      });
      channel.ack(message);
    } catch {
      channel.nack(message, false, true);
    }
  }

  @EventPattern('media.process_video_thumbnail')
  async handleChatVideoProcessing(
    @Payload() data: ProcessVideoThumbnailPayload,
    @Ctx() context: RmqContext,
  ): Promise<void> {
    const { channel, message } = this.getDelivery(context);

    try {
      await this.processChatVideoUseCase.execute(data);
      channel.ack(message);
    } catch {
      channel.nack(message, false, true);
    }
  }

  private getRetryNumber(context: RmqContext): number {
    const { message } = this.getDelivery(context);
    const value: unknown = message.properties.headers?.['x-reel-retry-count'];
    const parsed = Number(value);

    return Number.isInteger(parsed) && parsed >= 0 ? parsed : 0;
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
