import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { PrismaClient } from '@prisma/call-client';

/**
 * Call history is optional at runtime: without CALL_DATABASE_URL the service
 * still runs calls, chat call logs and missed-call pushes, and only skips the
 * stored history. A database outage must never stop calls either, so startup
 * does not wait for a connection; Prisma connects on the first query and the
 * history outbox retries.
 */
@Injectable()
export class CallPrismaService
  extends PrismaClient
  implements OnModuleInit, OnModuleDestroy
{
  private readonly logger = new Logger(CallPrismaService.name);
  readonly enabled = Boolean(process.env.CALL_DATABASE_URL?.trim());

  onModuleInit(): void {
    if (!this.enabled) {
      this.logger.warn(
        'CALL_DATABASE_URL is not set: call history is disabled',
      );
      return;
    }
    this.$connect().catch((error: unknown) => {
      this.logger.warn(
        `call history database is unavailable at startup: ${
          error instanceof Error ? error.name : 'unknown_error'
        }`,
      );
    });
  }

  async onModuleDestroy(): Promise<void> {
    if (this.enabled) {
      await this.$disconnect();
    }
  }
}
