import { Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';

import { PrismaClient } from '@prisma/notification-client';
import { NotificationPrometheusMetricsService } from '../metrics/notification-prometheus-metrics.service';
import { DatabaseWorkQueue } from './database-work-queue';

@Injectable()
export class PrismaService
  extends PrismaClient
  implements OnModuleInit, OnModuleDestroy
{
  constructor(metrics: NotificationPrometheusMetricsService) {
    const limit = process.env.NOTIFICATION_DATABASE_CONNECTION_LIMIT;
    let url = process.env.NOTIFICATION_DATABASE_URL;
    if (limit !== undefined) {
      if (!/^[1-9]\d*$/.test(limit) || !Number.isSafeInteger(Number(limit))) {
        throw new Error(
          'NOTIFICATION_DATABASE_CONNECTION_LIMIT must be a positive integer',
        );
      }
      if (!url) throw new Error('NOTIFICATION_DATABASE_URL is required');
      const connection = new URL(url);
      connection.searchParams.set('connection_limit', limit);
      url = connection.toString();
    }
    super(url ? { datasources: { db: { url } } } : undefined);
    const configuredPool = url
      ? new URL(url).searchParams.get('connection_limit')
      : null;
    const pool = Number(configuredPool);
    // Never expand the pool. A smaller explicit URL limit also limits work.
    const concurrency =
      Number.isSafeInteger(pool) && pool > 0 ? Math.min(4, pool) : 4;
    const work = new DatabaseWorkQueue(concurrency, 256, {
      state: (active, waiting) => metrics.recordDatabaseQueue(active, waiting),
      admitted: (seconds) => metrics.recordDatabaseWait(seconds),
    });
    // Notification does not use explicit/interactive transactions. Each
    // middleware call owns one complete Prisma operation, including any
    // engine-managed transaction. Review this gate before adding a callback
    // transaction: a transaction waiting for its own slot could deadlock.
    this.$use((params, next) => work.run(() => next(params)));
  }

  async onModuleInit() {
    await this.$connect();
  }

  async onModuleDestroy() {
    await this.$disconnect();
  }
}
