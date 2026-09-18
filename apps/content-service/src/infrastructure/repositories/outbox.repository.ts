import { OutboxEvent } from '@content/domain/entities/outbox-event.entity';
import type { IOutboxRepository } from '@content/domain/interfaces/outbox.repository.interface';
import { PrismaService } from '@content/infrastructure/prisma/prisma.service';
import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/content-client';

@Injectable()
export class OutboxRepository implements IOutboxRepository {
  constructor(private readonly prisma: PrismaService) {}

  async claimPending(input: {
    limit: number;
    claimToken: string;
    staleBefore: Date;
  }): Promise<OutboxEvent[]> {
    const rows = await this.prisma.$queryRaw<Array<Record<string, unknown>>>(
      Prisma.sql`
        WITH candidates AS (
          SELECT "id"
          FROM "OutboxEvent"
          WHERE "publishedAt" IS NULL
            AND "nextAttemptAt" <= NOW()
            AND (
              "claimToken" IS NULL
              OR "claimedAt" IS NULL
              OR "claimedAt" < ${input.staleBefore}
            )
          ORDER BY "createdAt" ASC
          FOR UPDATE SKIP LOCKED
          LIMIT ${input.limit}
        )
        UPDATE "OutboxEvent" AS event
        SET "claimToken" = ${input.claimToken},
            "claimedAt" = NOW(),
            "attemptCount" = event."attemptCount" + 1
        FROM candidates
        WHERE event."id" = candidates."id"
        RETURNING event.*
      `,
    );

    return rows.map((row) => this.toDomain(row));
  }

  async markPublished(input: {
    eventId: string;
    claimToken: string;
    publishedAt: Date;
  }): Promise<boolean> {
    const result = await this.prisma.outboxEvent.updateMany({
      where: {
        id: input.eventId,
        claimToken: input.claimToken,
        publishedAt: null,
      },
      data: {
        publishedAt: input.publishedAt,
        claimToken: null,
        claimedAt: null,
        lastError: null,
      },
    });

    return result.count > 0;
  }

  async markFailed(input: {
    eventId: string;
    claimToken: string;
    nextAttemptAt: Date;
    lastError: string;
  }): Promise<boolean> {
    const result = await this.prisma.outboxEvent.updateMany({
      where: {
        id: input.eventId,
        claimToken: input.claimToken,
        publishedAt: null,
      },
      data: {
        nextAttemptAt: input.nextAttemptAt,
        claimToken: null,
        claimedAt: null,
        lastError: input.lastError.slice(0, 4000),
      },
    });

    return result.count > 0;
  }

  private toDomain(record: Record<string, unknown>): OutboxEvent {
    const event = new OutboxEvent();

    event.id = record['id'] as string;
    event.aggregateType = record['aggregateType'] as string;
    event.aggregateId = record['aggregateId'] as string;
    event.eventType = record['eventType'] as string;
    event.payload = record['payload'];
    event.createdAt = record['createdAt'] as Date;
    event.publishedAt = (record['publishedAt'] as Date | null) ?? undefined;
    event.attemptCount = Number(record['attemptCount']) || 0;
    event.nextAttemptAt = record['nextAttemptAt'] as Date;
    event.claimToken = (record['claimToken'] as string | null) ?? undefined;
    event.claimedAt = (record['claimedAt'] as Date | null) ?? undefined;
    event.lastError = (record['lastError'] as string | null) ?? undefined;

    return event;
  }
}
