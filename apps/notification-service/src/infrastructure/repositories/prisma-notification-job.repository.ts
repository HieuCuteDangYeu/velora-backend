import { Injectable } from '@nestjs/common';
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
    // A single atomic UPDATE avoids Prisma updateMany's transaction overhead.
    // Bind values; preserve the existing eligibility and five-minute lease.
    const claimed = await this.prisma.$executeRaw`
      UPDATE notification_jobs
      SET status = 'processing', attempt_count = attempt_count + 1,
          updated_at = ${now}
      WHERE id = ${id} AND (
        status = 'pending'
        OR (status = 'failed' AND next_attempt_at <= ${now})
        OR (status = 'processing' AND updated_at <= ${processingLeaseExpiredAt})
      )
    `;

    if (claimed === 0) {
      return null;
    }

    const record = await this.prisma.notificationJob.findUniqueOrThrow({
      where: { id },
    });

    return this.toDomain(record);
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
