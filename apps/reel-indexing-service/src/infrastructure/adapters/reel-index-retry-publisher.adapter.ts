import type { ReelIndexJob } from '@common/processing/interfaces/reel-index-job.interface';
import { REEL_INDEX_JOB_PATTERN } from '@common/processing/interfaces/reel-index-job.interface';
import {
  getReelIndexRetryQueue,
  REEL_INDEX_DEAD_LETTER_EXCHANGE,
  REEL_INDEX_DEAD_LETTER_QUEUES,
  REEL_INDEX_EXCHANGE,
  REEL_INDEX_PRIMARY_QUEUES,
  REEL_INDEX_QUOTA_ROTATION_HEADER,
  REEL_INDEX_QUOTA_ROTATIONS_ON_SHORT_LANE,
  REEL_INDEX_RETRY_QUEUES,
} from '@common/processing/reel-media-queue.constants';
import type { IReelIndexRetryPublisher } from '@indexing/domain/interfaces/reel-index-retry-publisher.interface';
import { Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type {
  AmqpConnectionManager,
  Channel,
  ChannelWrapper,
} from 'amqp-connection-manager';
import { connect } from 'amqp-connection-manager';

@Injectable()
export class ReelIndexRetryPublisherAdapter
  implements IReelIndexRetryPublisher, OnModuleInit, OnModuleDestroy
{
  private connection?: AmqpConnectionManager;
  private channel?: ChannelWrapper;

  constructor(private readonly configService: ConfigService) {}

  onModuleInit(): void {
    this.connection = connect(
      [
        this.configService.get<string>('RABBITMQ_URL') ||
          'amqp://localhost:5672',
      ],
      {
        heartbeatIntervalInSeconds: this.getPositiveInteger(
          'RABBITMQ_HEARTBEAT_SECONDS',
          300,
        ),
      },
    );
    this.channel = this.connection.createChannel({
      name: 'reel-index-retry-publisher',
      setup: (channel: Channel) => this.assertTopology(channel),
    });
  }

  async onModuleDestroy(): Promise<void> {
    await this.channel?.close();
    await this.connection?.close();
  }

  async publishRetry(job: ReelIndexJob, retryNumber: 1 | 2): Promise<void> {
    if (!this.channel)
      throw new Error('Index retry publisher is not initialized');

    const definition = getReelIndexRetryQueue(
      job.sourceLengthClass,
      retryNumber,
    );
    const packet = Buffer.from(
      JSON.stringify({ pattern: REEL_INDEX_JOB_PATTERN, data: job }),
    );
    await this.channel.sendToQueue(definition.queue, packet, {
      persistent: true,
      contentType: 'application/json',
      messageId: job.jobId,
      type: REEL_INDEX_JOB_PATTERN,
      timestamp: Date.now(),
      headers: { 'x-reel-index-retry-count': retryNumber },
    });
  }

  async publishQuotaRotation(
    job: ReelIndexJob,
    rotation: number,
  ): Promise<void> {
    if (!this.channel)
      throw new Error('Index retry publisher is not initialized');

    // The short lane for the first few passes, the long one after that, so a quota that stays
    // spent for hours is polled every few minutes instead of every half minute.
    const definition = getReelIndexRetryQueue(
      job.sourceLengthClass,
      rotation <= REEL_INDEX_QUOTA_ROTATIONS_ON_SHORT_LANE ? 1 : 2,
    );
    await this.channel.sendToQueue(
      definition.queue,
      Buffer.from(
        JSON.stringify({ pattern: REEL_INDEX_JOB_PATTERN, data: job }),
      ),
      {
        persistent: true,
        contentType: 'application/json',
        messageId: job.jobId,
        type: REEL_INDEX_JOB_PATTERN,
        timestamp: Date.now(),
        headers: { [REEL_INDEX_QUOTA_ROTATION_HEADER]: rotation },
      },
    );
  }

  private async assertTopology(channel: Channel): Promise<void> {
    await channel.assertExchange(REEL_INDEX_EXCHANGE, 'direct', {
      durable: true,
    });
    await channel.assertExchange(REEL_INDEX_DEAD_LETTER_EXCHANGE, 'direct', {
      durable: true,
    });

    for (const definition of REEL_INDEX_PRIMARY_QUEUES) {
      await channel.assertQueue(definition.queue, {
        durable: true,
        arguments: {
          'x-dead-letter-exchange': REEL_INDEX_DEAD_LETTER_EXCHANGE,
          'x-dead-letter-routing-key': definition.deadLetterRoutingKey,
        },
      });
      await channel.bindQueue(
        definition.queue,
        REEL_INDEX_EXCHANGE,
        definition.routingKey,
      );
    }

    for (const definition of REEL_INDEX_RETRY_QUEUES) {
      await channel.assertQueue(definition.queue, {
        durable: true,
        arguments: {
          'x-message-ttl': definition.delayMs,
          'x-dead-letter-exchange': REEL_INDEX_EXCHANGE,
          'x-dead-letter-routing-key': definition.returnRoutingKey,
        },
      });
    }

    for (const definition of REEL_INDEX_DEAD_LETTER_QUEUES) {
      await channel.assertQueue(definition.queue, { durable: true });
      await channel.bindQueue(
        definition.queue,
        REEL_INDEX_DEAD_LETTER_EXCHANGE,
        definition.routingKey,
      );
    }
  }

  private getPositiveInteger(key: string, fallback: number): number {
    const value = Number(this.configService.get<string>(key) ?? fallback);
    return Number.isInteger(value) && value > 0 ? value : fallback;
  }
}
