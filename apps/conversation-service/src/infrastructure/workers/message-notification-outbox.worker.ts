import {
  Inject,
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import type { Prisma } from '@prisma/conversation-client';
import { IChatRepository } from '../../domain/interfaces/chat.repository.interface';
import type { IEncryptionRepository } from '../../domain/interfaces/encryption.repository.interface';
import { NotificationServiceAdapter } from '../adapters/notification-service.adapter';
import { ConversationPrometheusMetricsService } from '../metrics/conversation-prometheus-metrics.service';
import { PrismaService } from '../prisma/prisma.service';
import { Message } from '../../domain/entities/message.entity';
import { Conversation } from '../../domain/entities/conversation.entity';
import { readNotificationIntent } from '../repositories/notification-intent.reader';

const POLL_MS = 1_000;
const BATCH_SIZE = 20;
const MAX_BATCHES_PER_POLL = 5;
// Overlap four bounded claim/read/intake pipelines, without changing DB pools.
// Notification intake still shares that service's existing database work gate.
const CONCURRENCY = 4;
const LEASE_MS = 30_000;

@Injectable()
export class MessageNotificationOutboxWorker
  implements OnModuleInit, OnModuleDestroy
{
  private readonly logger = new Logger(MessageNotificationOutboxWorker.name);
  private readonly shutdown = new AbortController();
  private timer?: NodeJS.Timeout;
  private running?: Promise<void>;
  private stopped = false;
  private nextBacklogSampleAt = 0;

  constructor(
    private readonly prisma: PrismaService,
    private readonly notifications: NotificationServiceAdapter,
    @Inject('IChatRepository') private readonly chats: IChatRepository,
    @Inject('IEncryptionRepository')
    private readonly encryption: IEncryptionRepository,
    private readonly metrics: ConversationPrometheusMetricsService,
  ) {}

  onModuleInit(): void {
    this.timer = setInterval(() => {
      void this.runOnce();
    }, POLL_MS);
    this.timer.unref();
  }

  async onModuleDestroy(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    this.shutdown.abort();
    await this.running;
  }

  // One bounded drain per instance at a time. Each candidate is claimed immediately
  // before processing, so waiting in this batch does not consume its lease.
  runOnce(): Promise<void> {
    if (this.stopped) return Promise.resolve();
    if (this.running) return this.running;
    this.running = this.drainPending()
      .catch(() => {
        if (!this.stopped) {
          this.metrics.recordNotificationOutbox('poll_error');
          this.logger.warn(
            'Notification outbox poll failed; pending intents retained',
          );
        }
      })
      .finally(() => {
        this.running = undefined;
      });
    return this.running;
  }

  private async drainPending(): Promise<void> {
    for (
      let batch = 0;
      batch < MAX_BATCHES_PER_POLL && !this.stopped;
      batch++
    ) {
      // Continue only after a full, successful batch. Partial batches wait for
      // the next poll; contention or failures must not become a tight retry loop.
      if (!(await this.drainBatch())) break;
    }
  }

  private async drainBatch(): Promise<boolean> {
    const now = new Date();
    const candidates = await this.metrics.measurePhase(
      'outbox_candidate_read',
      () =>
        this.prisma.message.findMany({
          // Mongo's BSON ordering considers null < Date. Exclude it explicitly;
          // otherwise completed intents can fill the batch and starve pending ones.
          where: { notificationNextAttemptAt: { not: null, lte: now } },
          orderBy: [{ notificationNextAttemptAt: 'asc' }, { id: 'asc' }],
          take: BATCH_SIZE,
          select: { id: true },
        }),
    );
    let cursor = 0;
    let allCompleted = true;
    await Promise.all(
      Array.from({ length: CONCURRENCY }, async () => {
        while (!this.stopped && cursor < candidates.length) {
          const candidate = candidates[cursor++];
          if (!(await this.deliver(candidate.id))) allCompleted = false;
        }
      }),
    );
    if (!this.stopped && Date.now() >= this.nextBacklogSampleAt) {
      const pending = await this.metrics.measurePhase(
        'outbox_backlog_read',
        () =>
          this.prisma.message.count({
            where: { notificationNextAttemptAt: { not: null } },
          }),
      );
      this.metrics.setNotificationOutboxPending(pending);
      this.nextBacklogSampleAt = Date.now() + 10_000;
    }
    return !this.stopped && candidates.length === BATCH_SIZE && allCompleted;
  }

  private async deliver(id: string): Promise<boolean> {
    const claimId = randomUUID();
    let attempts = 1;
    try {
      const claimed = await this.metrics.measurePhase('outbox_claim', () =>
        this.updateIntent(
          id,
          {
            notificationNextAttemptAt: {
              $type: 'date',
              $lte: { $date: new Date().toISOString() },
            },
          },
          {
            $set: {
              notificationClaimId: claimId,
              notificationNextAttemptAt: {
                $date: new Date(Date.now() + LEASE_MS).toISOString(),
              },
            },
            $inc: { notificationAttemptCount: 1 },
          },
        ),
      );
      if (claimed !== 1) return false;
      const record = await this.metrics.measurePhase('outbox_record_read', () =>
        readNotificationIntent(this.prisma, id, claimId),
      );
      // Another worker may have acquired an expired lease during a slow read.
      if (!record || record.notificationClaimId !== claimId) return false;
      attempts = record.notificationAttemptCount;
      const recipientIds = record.notificationRecipientIds.filter(
        (userId) =>
          userId !== record.senderId &&
          record.conversation?.participantIds.includes(userId),
      );
      if (
        record.isRecalled ||
        !record.conversation ||
        recipientIds.length === 0
      ) {
        return await this.complete(id, claimId, 'cancelled');
      }
      // The intake adapter uses only identity, content and type, not chat history.
      const message = new Message({
        id: record.id,
        conversationId: record.conversationId,
        senderId: record.senderId,
        type: record.type,
        signalType: record.signalType,
        content: record.content,
        createdAt: record.createdAt,
        isRecalled: record.isRecalled,
      });
      if (message.signalType === 0) {
        message.content = this.encryption.decrypt(message.content);
        if (
          record.content &&
          message.content === record.content &&
          /^[a-f0-9]{32}:[a-f0-9]{32}:[a-f0-9]+$/i.test(record.content)
        ) {
          throw new Error('Notification content could not be decrypted');
        }
      }
      const conversation = new Conversation(record.conversation);
      // Enrichment does not change the original recipient snapshot. Removed
      // members are excluded; newly joined members never receive older intents.
      conversation.participantIds = [record.senderId, ...recipientIds];
      await this.metrics.measurePhase('outbox_enrichment', () =>
        this.chats.populateConversationParticipants(conversation),
      );
      if (this.stopped) return false;
      await this.metrics.measurePhase('outbox_intake', () =>
        this.notifications.notifyNewMessage(
          conversation,
          message,
          record.senderId,
          this.shutdown.signal,
        ),
      );
      return await this.complete(id, claimId, 'queued');
    } catch {
      if (this.stopped) return false; // Restart reclaims the expired lease.
      const backoffMs = Math.min(300_000, 1_000 * 2 ** Math.min(attempts, 8));
      try {
        const rescheduled = await this.updateIntent(
          id,
          { notificationClaimId: claimId },
          {
            $set: {
              notificationClaimId: null,
              notificationNextAttemptAt: {
                $date: new Date(
                  Date.now() + backoffMs + Math.floor(Math.random() * 1_000),
                ).toISOString(),
              },
            },
          },
        );
        this.metrics.recordNotificationOutbox(
          rescheduled === 1 ? 'retry' : 'lease_lost',
        );
      } catch {
        // Do not delete an intent when even rescheduling fails. The persisted
        // lease date makes it eligible again after restart/database recovery.
        this.metrics.recordNotificationOutbox('poll_error');
      }
      return false;
    }
  }

  private async complete(
    id: string,
    claimId: string,
    outcome: 'queued' | 'cancelled',
  ): Promise<boolean> {
    const completed = await this.metrics.measurePhase('outbox_complete', () =>
      this.updateIntent(
        id,
        { notificationClaimId: claimId },
        {
          $set: {
            notificationRecipientIds: [],
            notificationNextAttemptAt: null,
            notificationClaimId: null,
          },
        },
      ),
    );
    this.metrics.recordNotificationOutbox(
      completed === 1 ? outcome : 'lease_lost',
    );
    return completed === 1;
  }

  // Prisma updateMany reads matching IDs before its write. These single-document
  // mutations need only an atomic predicate + update, with no read-back. Keep the
  // due/claim guard in Mongo's actual write predicate so another worker cannot
  // acquire or clear a lease between a preliminary read and the update.
  private async updateIntent(
    id: string,
    guard: Prisma.InputJsonObject,
    update: Prisma.InputJsonObject,
  ): Promise<number> {
    const result = await this.prisma.$runCommandRaw({
      update: 'messages',
      updates: [
        {
          q: { _id: { $oid: id }, ...guard },
          u: update,
          multi: false,
          upsert: false,
        },
      ],
      ordered: true,
      writeConcern: { w: 'majority' },
    });
    // Mongo can return ok:1 with a per-write error. An ambiguous/unacknowledged
    // result must retain the intent, never count as durable completion.
    if (
      result.ok !== 1 ||
      (Array.isArray(result.writeErrors) && result.writeErrors.length > 0) ||
      result.writeConcernError ||
      (result.n !== 0 && result.n !== 1)
    ) {
      throw new Error('Notification intent update was not acknowledged');
    }
    return result.n;
  }
}
