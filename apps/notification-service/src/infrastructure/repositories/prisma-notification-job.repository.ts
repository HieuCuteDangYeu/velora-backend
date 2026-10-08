import { Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import {
  NotificationJob as PrismaNotificationJob,
  Prisma,
} from '@prisma/notification-client';

import {
  CreateNotificationJobInput,
  NotificationJob,
  NotificationJobStatus,
  NotificationJobType,
} from '../../domain/entities/notification-job.entity';
import { INotificationJobRepository } from '../../domain/interfaces/notification-job.repository.interface';
import { PrismaService } from '../prisma/prisma.service';

const PROCESSING_LEASE_MS = 5 * 60_000;

@Injectable()
export class PrismaNotificationJobRepository implements INotificationJobRepository {
  constructor(private readonly prisma: PrismaService) {}

  async enqueueMany(inputs: CreateNotificationJobInput[]): Promise<number> {
    if (inputs.length === 0) return 0;
    // Keep Prisma's transactional chunking for unusually large batches, rather
    // than exceeding PostgreSQL's bind-parameter limit in a single statement.
    if (inputs.length > 1_000) {
      const result = await this.prisma.notificationJob.createMany({
        data: inputs.map((input) => ({
          ...input,
          dataJson: input.dataJson as Prisma.InputJsonValue | undefined,
          status: 'pending',
        })),
        skipDuplicates: true,
      });
      return result.count;
    }

    const now = new Date();
    const rows = inputs.map(
      (input) => Prisma.sql`(
      ${randomUUID()}, ${input.type}, ${input.recipientUserId},
      ${input.actorUserId ?? null}, ${input.conversationId ?? null},
      ${input.messageId ?? null}, ${input.callId ?? null},
      ${input.title}, ${input.body},
      ${input.dataJson === undefined ? null : JSON.stringify(input.dataJson)}::jsonb,
      ${input.expiresAt ?? null}, 'pending', ${input.idempotencyKey ?? null},
      ${now}, ${now}
    )`,
    );
    // One PostgreSQL statement is atomic, including all recipients and dedupe.
    // Unlike createMany, it needs no separate BEGIN/COMMIT round trips. A replay
    // never resets the existing job's lease, attempts, or terminal state.
    return this.prisma.$executeRaw(Prisma.sql`
      INSERT INTO notification_jobs (
        id, type, recipient_user_id, actor_user_id, conversation_id,
        message_id, call_id, title, body, data_json, expires_at, status,
        idempotency_key, created_at, updated_at
      ) VALUES ${Prisma.join(rows)}
      ON CONFLICT (idempotency_key) DO NOTHING
    `);
  }

  async create(input: CreateNotificationJobInput): Promise<NotificationJob> {
    const data = {
      type: input.type,
      recipientUserId: input.recipientUserId,
      actorUserId: input.actorUserId,
      conversationId: input.conversationId,
      messageId: input.messageId,
      callId: input.callId,
      title: input.title,
      body: input.body,
      dataJson: input.dataJson as Prisma.InputJsonValue | undefined,
      expiresAt: input.expiresAt,
      status: 'pending' as const,
      idempotencyKey: input.idempotencyKey,
    };
    const record = input.idempotencyKey
      ? await this.prisma.notificationJob.upsert({
          where: { idempotencyKey: input.idempotencyKey },
          create: data,
          // A replay must not reset an in-flight, failed, or sent delivery.
          update: {},
        })
      : await this.prisma.notificationJob.create({ data });

    return this.toDomain(record);
  }

  async claimForProcessing(id: string): Promise<NotificationJob | null> {
    const now = new Date();
    const processingLeaseExpiredAt = new Date(
      now.getTime() - PROCESSING_LEASE_MS,
    );
    // Return the claimed snapshot in the same atomic statement. Avoid another
    // round trip; preserve the existing eligibility and five-minute lease.
    const records = await this.prisma.$queryRaw<PrismaNotificationJob[]>`
      UPDATE notification_jobs
      SET status = 'processing', attempt_count = attempt_count + 1,
          updated_at = ${now}
      WHERE id = ${id} AND (
        status = 'pending'
        OR (status = 'failed' AND next_attempt_at <= ${now})
        OR (status = 'processing' AND updated_at <= ${processingLeaseExpiredAt})
      )
      RETURNING id, type, recipient_user_id AS "recipientUserId",
        actor_user_id AS "actorUserId", conversation_id AS "conversationId",
        message_id AS "messageId", call_id AS "callId", title, body,
        data_json AS "dataJson", expires_at AS "expiresAt", status,
        idempotency_key AS "idempotencyKey", attempt_count AS "attemptCount",
        next_attempt_at AS "nextAttemptAt", last_error AS "lastError",
        created_at AS "createdAt", updated_at AS "updatedAt", sent_at AS "sentAt"
    `;
    return records.length === 0 ? null : this.toDomain(records[0]);
  }

  async markSent(id: string): Promise<NotificationJob> {
    const record = await this.prisma.notificationJob.update({
      where: { id },
      data: {
        status: 'sent',
        sentAt: new Date(),
        lastError: null,
        nextAttemptAt: null,
      },
    });

    return this.toDomain(record);
  }

  async markFailed(
    id: string,
    error: string,
    nextAttemptAt?: Date,
  ): Promise<NotificationJob> {
    const record = await this.prisma.notificationJob.update({
      where: { id },
      data: {
        status: 'failed',
        lastError: error,
        nextAttemptAt,
        sentAt: null,
      },
    });

    return this.toDomain(record);
  }

  async markSkipped(id: string, reason: string): Promise<NotificationJob> {
    const record = await this.prisma.notificationJob.update({
      where: { id },
      data: {
        status: 'skipped',
        lastError: reason,
        nextAttemptAt: null,
        sentAt: null,
      },
    });

    return this.toDomain(record);
  }

  async findRetryable(limit: number): Promise<NotificationJob[]> {
    const now = new Date();
    const processingLeaseExpiredAt = new Date(
      now.getTime() - PROCESSING_LEASE_MS,
    );
    const records = await this.prisma.notificationJob.findMany({
      where: {
        AND: [
          {
            OR: [
              {
                status: 'pending',
              },
              {
                status: 'failed',
                nextAttemptAt: {
                  lte: now,
                },
              },
              {
                // A process can exit after claiming a job and before it writes
                // a terminal job result. Reclaim only an old lease so an
                // in-flight push is not normally processed twice.
                status: 'processing',
                updatedAt: {
                  lte: processingLeaseExpiredAt,
                },
              },
            ],
          },
          {
            OR: [
              {
                expiresAt: null,
              },
              {
                expiresAt: {
                  gt: now,
                },
              },
            ],
          },
        ],
      },
      orderBy: [
        {
          expiresAt: {
            sort: 'asc',
            nulls: 'last',
          },
        },
        {
          createdAt: 'asc',
        },
      ],
      take: limit,
    });

    return records.map((record) => this.toDomain(record));
  }

  private toDomain(record: PrismaNotificationJob): NotificationJob {
    return new NotificationJob({
      id: record.id,
      type: record.type as NotificationJobType,
      recipientUserId: record.recipientUserId,
      actorUserId: record.actorUserId,
      conversationId: record.conversationId,
      messageId: record.messageId,
      callId: record.callId,
      title: record.title,
      body: record.body,
      dataJson: record.dataJson,
      expiresAt: record.expiresAt,
      status: record.status as NotificationJobStatus,
      attemptCount: record.attemptCount,
      nextAttemptAt: record.nextAttemptAt,
    });
  }
}
