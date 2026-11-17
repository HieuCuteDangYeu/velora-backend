import { Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { PrismaClient } from '@prisma/auth-client';

@Injectable()
export class PrismaService
  extends PrismaClient
  implements OnModuleInit, OnModuleDestroy
{
  constructor() {
    // The shared Aiven server allows very few connections in total, so the pool
    // is sized by configuration instead of Prisma's CPU-based default.
    const limit = process.env.AUTH_DATABASE_CONNECTION_LIMIT;
    let url = process.env.AUTH_DATABASE_URL;
    if (limit !== undefined) {
      if (!/^[1-9]\d*$/.test(limit) || !Number.isSafeInteger(Number(limit))) {
        throw new Error(
          'AUTH_DATABASE_CONNECTION_LIMIT must be a positive integer',
        );
      }
      if (!url) throw new Error('AUTH_DATABASE_URL is required');
      const connection = new URL(url);
      connection.searchParams.set('connection_limit', limit);
      url = connection.toString();
    }
    super(url ? { datasources: { db: { url } } } : undefined);
  }

  async onModuleInit() {
    await this.$connect();
  }

  async onModuleDestroy() {
    await this.$disconnect();
  }
}
