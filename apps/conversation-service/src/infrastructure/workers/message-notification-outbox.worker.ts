import {
  Inject,
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
  Optional,
} from '@nestjs/common';
import { hostname } from 'node:os';
import { randomUUID } from 'node:crypto';
import type Redis from 'ioredis';
import type { Prisma } from '@prisma/conversation-client';
import { IChatRepository } from '../../domain/interfaces/chat.repository.interface';
import type { IEncryptionRepository } from '../../domain/interfaces/encryption.repository.interface';
import { NotificationServiceAdapter } from '../adapters/notification-service.adapter';
import { ConversationPrometheusMetricsService } from '../metrics/conversation-prometheus-metrics.service';
import { PrismaService } from '../prisma/prisma.service';
import { Message } from '../../domain/entities/message.entity';
import { Conversation } from '../../domain/entities/conversation.entity';
import {
  countPendingNotificationIntents,
  findDueNotificationIntents,
  readNotificationIntent,
} from '../repositories/notification-intent.reader';

const POLL_MS = 1_000;
// Five intents per pipeline, so every pipeline stays busy for the whole batch.
export const OUTBOX_BATCH_SIZE = 60;
// Overlap twelve bounded claim/read/intake pipelines, without changing DB pools.
// Intake is latency-bound: at four pipelines the notification service's own database
// gate (4 slots) was the limit; with that database local the gate no longer queues.
export const OUTBOX_CONCURRENCY = 12;
// While live traffic is heavy the drain yields: its Mongo writes (claim, read, complete, each
// majority-acknowledged) compete with message inserts, and at 1000 messages/s twelve pipelines
// roughly doubled the sender ACK time. Once traffic drops the full speed resumes.
export const OUTBOX_BUSY_CONCURRENCY = 2;
export const OUTBOX_BUSY_MESSAGES_PER_SECOND = 50;
const BATCH_SIZE = OUTBOX_BATCH_SIZE;
const CONCURRENCY = OUTBOX_CONCURRENCY;
const LEASE_MS = 30_000;
// CONVERSATION_NOTIFICATION_OUTBOX=leader: one replica at a time drains the outbox. With several
// replicas every worker claimed the same intents and all but one claim lost, and each claim is a
// majority write, so the fleet doubled its Mongo writes for no extra delivery.
const LEADER_KEY = 'chat:outbox:leader';
// The lease is renewed by its own timer, never by the drain: a batch under load takes seconds,
// and a lease tied to batches expired in the middle of one and passed back and forth.
const LEADER_TTL_MS = 10_000;
const LEADER_RENEW_MS = 2_000;
// Take the lease when free, renew it when ours, otherwise leave it.
const LEADER_SCRIPT =
  "local v = redis.call('get', KEYS[1]) " +
  "if v == ARGV[1] then redis.call('pexpire', KEYS[1], ARGV[2]) return 1 " +
  "elseif not v then redis.call('set', KEYS[1], ARGV[1], 'PX', ARGV[2]) return 1 " +
  'else return 0 end';
// A replica that shuts down hands the lease over at once instead of making the others wait.
const LEADER_RELEASE_SCRIPT =
  "if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('del', KEYS[1]) else return 0 end";

@Injectable()
export class MessageNotificationOutboxWorker
  implements OnModuleInit, OnModuleDestroy
{
  private readonly logger = new Logger(MessageNotificationOutboxWorker.name);
  private readonly shutdown = new AbortController();
  private timer?: NodeJS.Timeout;
  private leaderTimer?: NodeJS.Timeout;
  private running?: Promise<void>;
  private stopped = false;
  private nextBacklogSampleAt = 0;
  private leaderMode = false;
  private leader = false;
  private readonly instanceId = `${hostname()}-${process.pid}`;

  constructor(
    private readonly prisma: PrismaService,
    private readonly notifications: NotificationServiceAdapter,
    @Inject('IChatRepository') private readonly chats: IChatRepository,
    @Inject('IEncryptionRepository')
    private readonly encryption: IEncryptionRepository,
    private readonly metrics: ConversationPrometheusMetricsService,
    @Optional() @Inject('REDIS_CLIENT') private readonly redis?: Redis,
  ) {}

  onModuleInit(): void {
    // The outbox is shared through Mongo, so one replica is enough to drain it.
    // A replica that has no route to notification-service (for example one on
    // another machine) must not claim intents it cannot deliver.
    if (process.env.CONVERSATION_NOTIFICATION_OUTBOX === 'off') {
      this.logger.log('Notification outbox worker disabled on this replica');
      return;
    }
    this.leaderMode =
      process.env.CONVERSATION_NOTIFICATION_OUTBOX === 'leader' &&
      this.redis !== undefined;
    if (this.leaderMode) {
      this.logger.log('Notification outbox: leader mode');
      void this.renewLeadership();
      this.leaderTimer = setInterval(() => {
        void this.renewLeadership();
      }, LEADER_RENEW_MS);
      this.leaderTimer.unref();
    }
    this.timer = setInterval(() => {
      void this.runOnce();
    }, POLL_MS);
    this.timer.unref();
  }

  async onModuleDestroy(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    if (this.leaderTimer) clearInterval(this.leaderTimer);
    this.shutdown.abort();
    await this.running;
    if (this.leaderMode && this.leader) {
      try {
        await this.redis!.eval(
          LEADER_RELEASE_SCRIPT,
          1,
          LEADER_KEY,
          this.instanceId,
        );
      } catch {
        // The lease expires on its own.
      }
    }
  }

  // One drain per instance at a time. Each candidate is claimed immediately
  // before processing, so waiting in this batch does not consume its lease.
  runOnce(): Promise<void> {
    if (this.stopped) return Promise.resolve();
    if (this.running) return this.running;
    this.running = this.drainIfLeader()
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

  private async drainIfLeader(): Promise<void> {
    if (this.leaderMode && !this.leader) {
      // Not draining, but the backlog gauge must stay current on every replica: the
      // scraped one may be a former leader whose last reading would otherwise never change.
      await this.sampleBacklog();
      return;
    }
    await this.drainPending();
  }

  // Redis trouble must not stop deliveries: without an answer every replica drains, as before.
  private async renewLeadership(): Promise<void> {
    if (this.stopped) return;
    let holds = true;
    try {
      holds =
        (await this.redis!.eval(
          LEADER_SCRIPT,
          1,
          LEADER_KEY,
          this.instanceId,
          LEADER_TTL_MS,
        )) === 1;
    } catch {
      holds = true;
    }
    if (holds !== this.leader) {
      this.leader = holds;
      this.logger.log(
        holds
          ? 'This replica now drains the notification outbox'
          : 'Another replica drains the notification outbox',
      );
    }
  }

  private async drainPending(): Promise<void> {
    // Keep draining without waiting for the next timer tick for as long as batches
    // come back full and fully delivered. Partial batches wait for the next poll;
    // contention or failures must not become a tight retry loop. Each batch awaits
    // database and network work, so a long backlog never blocks the event loop.
    while (!this.stopped) {
      if (!(await this.drainBatch())) break;
      // The renewal timer keeps the lease; a long drain stops once another replica holds it.
      if (this.leaderMode && !this.leader) break;
    }
  }

  private async drainBatch(): Promise<boolean> {
    const now = new Date();
    const candidates = await this.metrics.measurePhase(
      'outbox_candidate_read',
      () => findDueNotificationIntents(this.prisma, now, BATCH_SIZE),
    );
    let cursor = 0;
    let allCompleted = true;
    const lanes =
      this.metrics.messagesCreatedPerSecond() >= OUTBOX_BUSY_MESSAGES_PER_SECOND
        ? OUTBOX_BUSY_CONCURRENCY
        : CONCURRENCY;
    await Promise.all(
      Array.from({ length: lanes }, async () => {
        while (!this.stopped && cursor < candidates.length) {
          const candidate = candidates[cursor++];
          if (!(await this.deliver(candidate.id))) allCompleted = false;
        }
      }),
    );
    await this.sampleBacklog();
    return !this.stopped && candidates.length === BATCH_SIZE && allCompleted;
  }

  private async sampleBacklog(): Promise<void> {
    if (this.stopped || Date.now() < this.nextBacklogSampleAt) return;
    try {
      const pending = await this.metrics.measurePhase(
        'outbox_backlog_read',
        () => countPendingNotificationIntents(this.prisma),
      );
      this.metrics.setNotificationOutboxPending(pending);
    } catch {
      // The gauge is only a measurement; it must not interrupt delivery.
      this.logger.warn('Notification outbox backlog sample failed');
    } finally {
      this.nextBacklogSampleAt = Date.now() + 10_000;
    }
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
        content: record.content,
        createdAt: record.createdAt,
        isRecalled: record.isRecalled,
      });
      message.content = this.encryption.decrypt(message.content);
      if (
        record.content &&
        message.content === record.content &&
        /^[a-f0-9]{32}:[a-f0-9]{32}:[a-f0-9]+$/i.test(record.content)
      ) {
        throw new Error('Notification content could not be decrypted');
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
