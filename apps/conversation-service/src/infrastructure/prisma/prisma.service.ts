import { Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { Prisma, PrismaClient } from '@prisma/conversation-client';
import {
  ConversationPrometheusMetricsService,
  type MongoCommand,
} from '../metrics/conversation-prometheus-metrics.service';

const MONGO_COMMANDS: Record<string, MongoCommand> = {
  'messages.insertOne': 'message_insert',
  'messages.insertMany': 'message_insert',
  'messages.aggregate': 'message_read',
  'conversations.aggregate': 'conversation_read',
  'conversations.updateMany': 'conversation_update',
};

@Injectable()
export class PrismaService
  extends PrismaClient<Prisma.PrismaClientOptions, 'query'>
  implements OnModuleInit, OnModuleDestroy
{
  constructor(metrics: ConversationPrometheusMetricsService) {
    super({ log: [{ level: 'query', emit: 'event' }] });
    this.$on('query', (event) => {
      // Only inspect the command prefix. Query text and parameters stay private.
      const match = event.query.match(
        /^db\.(messages|conversations)\.(insertOne|insertMany|aggregate|updateMany)\(/,
      );
      const command = match && MONGO_COMMANDS[`${match[1]}.${match[2]}`];
      if (command) metrics.recordMongoCommand(command, event.duration / 1000);
    });
  }

  async onModuleInit() {
    await this.$connect();
  }

  async onModuleDestroy() {
    await this.$disconnect();
  }
}
