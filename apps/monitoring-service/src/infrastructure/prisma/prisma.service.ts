import { Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { PrismaClient } from '@prisma/monitoring-client';

@Injectable()
export class PrismaService
  extends PrismaClient
  implements OnModuleInit, OnModuleDestroy
{
  constructor() {
    const limit = process.env.MONITORING_DATABASE_CONNECTION_LIMIT;
    let url = process.env.MONITORING_DATABASE_URL;
    if (limit !== undefined) {
      if (!/^[1-9]\d*$/.test(limit) || !Number.isSafeInteger(Number(limit))) {
        throw new Error(
          'MONITORING_DATABASE_CONNECTION_LIMIT must be a positive integer',
        );
      }
      if (!url) throw new Error('MONITORING_DATABASE_URL is required');
      const connection = new URL(url);
      connection.searchParams.set('connection_limit', limit);
      url = connection.toString();
    }
    super(url ? { datasources: { db: { url } } } : undefined);
  }

  async onModuleInit(): Promise<void> {
    await this.$connect();
  }

  async onModuleDestroy(): Promise<void> {
    await this.$disconnect();
  }
}
