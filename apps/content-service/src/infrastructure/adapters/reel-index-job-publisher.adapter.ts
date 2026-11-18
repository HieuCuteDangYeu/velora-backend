import type { ReelIndexJob } from '@common/processing/interfaces/reel-index-job.interface';
import { REEL_INDEX_JOB_PATTERN } from '@common/processing/interfaces/reel-index-job.interface';
import {
  getReelIndexPrimaryQueue,
  REEL_INDEX_DEAD_LETTER_EXCHANGE,
  REEL_INDEX_DEAD_LETTER_QUEUES,
  REEL_INDEX_EXCHANGE,
  REEL_INDEX_PRIMARY_QUEUES,
  REEL_INDEX_RETRY_QUEUES,
} from '@common/processing/reel-media-queue.constants';
import type { IReelIndexJobPublisher } from '@content/domain/interfaces/reel-index-job-publisher.interface';
import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type {
  AmqpConnectionManager,
  Channel,
  ChannelWrapper,
} from 'amqp-connection-manager';
import { connect } from 'amqp-connection-manager';

@Injectable()
export class ReelIndexJobPublisherAdapter
  implements IReelIndexJobPublisher, OnModuleInit, OnModuleDestroy
{
  private readonly logger = new Logger(ReelIndexJobPublisherAdapter.name);
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
      name: 'content-reel-index-outbox-publisher',
      setup: (channel: Channel) => this.assertTopology(channel),
    });
  }

  async onModuleDestroy(): Promise<void> {
    await this.channel?.close();
    await this.connection?.close();
  }

  async publish(job: ReelIndexJob): Promise<void | 'skipped'> {
    if (!this.channel) {
      throw new Error('Reel index publisher is not initialized');
    }

    // Opt-in for load tests: a job whose tags contain this value is not indexed, so a media
    // stress test does not spend the daily vision (Groq) allowance. Unset = every job is indexed.
    const skipTag = this.configService
      .get<string>('REEL_INDEX_SKIP_TAG')
      ?.trim();
    if (skipTag && job.tags.includes(skipTag)) {
      this.logger.warn(
        `Not indexing reel ${job.reelId}: it carries the tag ${skipTag} (REEL_INDEX_SKIP_TAG)`,
      );
      return 'skipped';
    }

    const definition = getReelIndexPrimaryQueue(job.sourceLengthClass);
    const packet = Buffer.from(
      JSON.stringify({ pattern: REEL_INDEX_JOB_PATTERN, data: job }),
    );

    await this.channel.publish(
      REEL_INDEX_EXCHANGE,
      definition.routingKey,
      packet,
      {
        persistent: true,
        contentType: 'application/json',
        messageId: job.jobId,
        type: REEL_INDEX_JOB_PATTERN,
        timestamp: Date.now(),
        headers: { 'x-reel-index-retry-count': 0 },
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
