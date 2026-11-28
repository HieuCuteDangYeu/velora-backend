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
import {
  NewMessageNotification,
  NotificationBatchRejectedError,
  NotificationServiceAdapter,
} from '../adapters/notification-service.adapter';
import { ConversationPrometheusMetricsService } from '../metrics/conversation-prometheus-metrics.service';
import { PrismaService } from '../prisma/prisma.service';
import { Message } from '../../domain/entities/message.entity';
import { Conversation } from '../../domain/entities/conversation.entity';
import {
  countPendingNotificationIntents,
  findDueNotificationIntents,
  readNotificationIntents,
} from '../repositories/notification-intent.reader';

const POLL_MS = 1_000;
// Due intents read per poll, then delivered in chunks.
export const OUTBOX_BATCH_SIZE = 200;
// One chunk = one claim command, one read, one notification request and one
// completion command for all of its intents. Per-intent round trips (about 78 ms
// each) capped delivery near 150 intents/s with twelve lanes, and under chat load
// the backlog grew by every message.
export const OUTBOX_CHUNK_SIZE = 50;
// Chunks in flight at once.
export const OUTBOX_CONCURRENCY = 4;
// While live traffic is heavy the drain keeps one chunk in flight: its Mongo
// writes are majority-acknowledged and compete with message inserts, but a whole
// chunk costs a handful of commands, so delivery keeps up with the traffic.
export const OUTBOX_BUSY_CONCURRENCY = 1;
export const OUTBOX_BUSY_MESSAGES_PER_SECOND = 50;
const BATCH_SIZE = OUTBOX_BATCH_SIZE;
const CONCURRENCY = OUTBOX_CONCURRENCY;
const LEASE_MS = 30_000;
// CONVERSATION_OUTBOX_PRIORITY=chat: while the whole fleet receives at least
// CONVERSATION_OUTBOX_BUSY_THRESHOLD messages/s, notifications only trickle at
// CONVERSATION_OUTBOX_BUSY_RATE intents/s and chat keeps the CPU; once traffic
// drops the batched drain catches up at full speed. Measured on the homelab:
// delivering every notification during a burst halved the chat throughput.
export const OUTBOX_DEFAULT_BUSY_THRESHOLD = 100;
export const OUTBOX_DEFAULT_BUSY_RATE = 20;
// Each replica reports what it received; the drainer sums fresh reports.
const RATE_KEY = 'chat:outbox:rates';
const RATE_REPORT_MS = 1_000;
const RATE_FRESH_MS = 3_000;
const RATE_KEY_TTL_MS = 10_000;

// Exponential back-off with full jitter (Brooker, 2015): the ceiling doubles from
// 2 s up to 256 s, and the delay is drawn at random between a one-second floor and
// that ceiling, so intents that failed together do not retry together. The floor
// stops an unlucky draw from retrying at once.
export const RETRY_MIN_DELAY_MS = 1_000;
export const RETRY_MAX_EXPONENT = 8;
export function retryDelayMs(
  attempts: number,
  random: () => number = Math.random,
): number {
  const ceiling = Math.min(
    300_000,
    1_000 * 2 ** Math.min(Math.max(attempts, 1), RETRY_MAX_EXPONENT),
  );
  return (
    RETRY_MIN_DELAY_MS +
    Math.floor(random() * (ceiling - RETRY_MIN_DELAY_MS + 1))
  );
}

function positiveInteger(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}
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
  private readonly chatFirst =
    process.env.CONVERSATION_OUTBOX_PRIORITY === 'chat';
  private readonly busyThreshold = positiveInteger(
    process.env.CONVERSATION_OUTBOX_BUSY_THRESHOLD,
    OUTBOX_DEFAULT_BUSY_THRESHOLD,
  );
  private readonly busyRate = positiveInteger(
    process.env.CONVERSATION_OUTBOX_BUSY_RATE,
    OUTBOX_DEFAULT_BUSY_RATE,
  );
  private rateTimer?: NodeJS.Timeout;

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
    // Every replica that receives messages reports its rate, including one whose
    // outbox is off: the drainer decides on the traffic of the whole fleet.
    if (this.chatFirst && this.redis) {
      this.logger.log(
        `Notification outbox: chat first above ${this.busyThreshold} messages/s (then ${this.busyRate} intents/s)`,
      );
      this.rateTimer = setInterval(() => {
        void this.reportRate();
      }, RATE_REPORT_MS);
      this.rateTimer.unref();
    }
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
    if (this.rateTimer) clearInterval(this.rateTimer);
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
      if (this.chatFirst && (await this.chatIsBusy())) {
        // One small chunk per poll: notifications keep moving, chat keeps the CPU.
        await this.drainBatch(this.busyRate, 1);
        return;
      }
      const lanes =
        !this.chatFirst &&
        this.metrics.messagesCreatedPerSecond() >=
          OUTBOX_BUSY_MESSAGES_PER_SECOND
          ? OUTBOX_BUSY_CONCURRENCY
          : CONCURRENCY;
      if (!(await this.drainBatch(BATCH_SIZE, lanes))) break;
      // The renewal timer keeps the lease; a long drain stops once another replica holds it.
      if (this.leaderMode && !this.leader) break;
    }
  }

  private async reportRate(): Promise<void> {
    if (this.stopped) return;
    try {
      await this.redis!.multi()
        .hset(
          RATE_KEY,
          this.instanceId,
          `${this.metrics.messagesCreatedPerSecond()}:${Date.now()}`,
        )
        .pexpire(RATE_KEY, RATE_KEY_TTL_MS)
        .exec();
    } catch {
      // A missed report only makes the drainer see less traffic for a moment.
    }
  }

  // Messages per second the whole fleet received, from the fresh reports. Redis
  // trouble falls back to this replica's own traffic.
  private async chatIsBusy(): Promise<boolean> {
    const local = this.metrics.messagesCreatedPerSecond();
    if (!this.redis) return local >= this.busyThreshold;
    try {
      const reports = await this.redis.hgetall(RATE_KEY);
      const now = Date.now();
      let total = 0;
      let mine = false;
      const stale: string[] = [];
      for (const [instance, value] of Object.entries(reports ?? {})) {
        const [rate, at] = value.split(':').map(Number);
        if (!Number.isFinite(rate) || !Number.isFinite(at)) continue;
        if (now - at > RATE_KEY_TTL_MS) stale.push(instance);
        if (now - at > RATE_FRESH_MS) continue;
        if (instance === this.instanceId) {
          mine = true;
          total += local; // fresher than the report
        } else {
          total += rate;
        }
      }
      if (!mine) total += local;
      if (stale.length > 0)
        void this.redis.hdel(RATE_KEY, ...stale).catch(() => 0);
      return total >= this.busyThreshold;
    } catch {
      return local >= this.busyThreshold;
    }
  }

  private async drainBatch(limit: number, lanes: number): Promise<boolean> {
    const now = new Date();
    const candidates = await this.metrics.measurePhase(
      'outbox_candidate_read',
      () => findDueNotificationIntents(this.prisma, now, limit),
    );
    const chunks: string[][] = [];
    for (let i = 0; i < candidates.length; i += OUTBOX_CHUNK_SIZE) {
      chunks.push(
        candidates.slice(i, i + OUTBOX_CHUNK_SIZE).map(({ id }) => id),
      );
    }
    let cursor = 0;
    let allCompleted = true;
    await Promise.all(
      Array.from({ length: lanes }, async () => {
        while (!this.stopped && cursor < chunks.length) {
          if (!(await this.deliverChunk(chunks[cursor++]))) {
            allCompleted = false;
          }
        }
      }),
    );
    await this.sampleBacklog();
    return !this.stopped && candidates.length === limit && allCompleted;
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

  /**
   * Delivers one chunk with the same guarantees as delivering each intent alone:
   * every intent gets its own claim id, every claim and completion keeps its
   * due/claim guard in the write itself, the record is read only after the claim,
   * and an intent is cleared only after notification-service confirmed durable
   * jobs for it. Returns true when every intent of the chunk was completed.
   */
  private async deliverChunk(ids: readonly string[]): Promise<boolean> {
    const claimedAt = new Date();
    const claims: { id: string; claimId: string }[] = ids.map((id) => ({
      id,
      claimId: randomUUID(),
    }));
    let claimed: number;
    try {
      claimed = await this.metrics.measurePhase('outbox_claim', () =>
        this.updateIntents(
          claims.map(({ id, claimId }) => ({
            q: {
              _id: { $oid: id },
              notificationNextAttemptAt: {
                $type: 'date',
                $lte: { $date: claimedAt.toISOString() },
              },
            },
            u: {
              $set: {
                notificationClaimId: claimId,
                notificationNextAttemptAt: {
                  $date: new Date(claimedAt.getTime() + LEASE_MS).toISOString(),
                },
              },
              $inc: { notificationAttemptCount: 1 },
            },
          })),
        ),
      );
    } catch {
      // Nothing was confirmed as claimed; whatever was claimed expires on its own.
      if (!this.stopped) this.metrics.recordNotificationOutbox('poll_error');
      return false;
    }
    if (claimed === 0) return false;

    let records: Awaited<ReturnType<typeof readNotificationIntents>>;
    try {
      records = await this.metrics.measurePhase('outbox_record_read', () =>
        readNotificationIntents(this.prisma, claims),
      );
    } catch {
      if (this.stopped) return false;
      await this.reschedule(claims);
      return false;
    }
    // Another worker may have acquired an expired lease during a slow read.
    let complete = claimed === ids.length && records.length === ids.length;

    const cancelled: typeof claims = [];
    const failed: { id: string; claimId: string; attempts: number }[] = [];
    const ready: {
      claim: { id: string; claimId: string };
      attempts: number;
      notification: NewMessageNotification;
    }[] = [];
    for (const record of records) {
      const claim = { id: record.id, claimId: record.notificationClaimId };
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
        cancelled.push(claim);
        continue;
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
      try {
        message.content = this.encryption.decrypt(message.content);
        if (
          record.content &&
          message.content === record.content &&
          /^[a-f0-9]{32}:[a-f0-9]{32}:[a-f0-9]+$/i.test(record.content)
        ) {
          throw new Error('Notification content could not be decrypted');
        }
      } catch {
        failed.push({ ...claim, attempts: record.notificationAttemptCount });
        continue;
      }
      const conversation = new Conversation(record.conversation);
      // Enrichment does not change the original recipient snapshot. Removed
      // members are excluded; newly joined members never receive older intents.
      conversation.participantIds = [record.senderId, ...recipientIds];
      ready.push({
        claim,
        attempts: record.notificationAttemptCount,
        notification: { conversation, message, actorUserId: record.senderId },
      });
    }

    if (ready.length > 0) {
      await this.metrics.measurePhase('outbox_enrichment', () =>
        Promise.all(
          ready.map(({ notification }) =>
            this.chats.populateConversationParticipants(
              notification.conversation,
            ),
          ),
        ),
      );
    }
    if (this.stopped) return false;

    const delivered: typeof claims = [];
    if (ready.length > 0) {
      try {
        await this.metrics.measurePhase('outbox_intake', () =>
          this.notifications.notifyNewMessages(
            ready.map(({ notification }) => notification),
            this.shutdown.signal,
          ),
        );
        delivered.push(...ready.map(({ claim }) => claim));
      } catch (error: unknown) {
        if (this.stopped) return false; // Restart reclaims the expired lease.
        if (
          error instanceof NotificationBatchRejectedError &&
          ready.length > 1
        ) {
          // One invalid intent must not hold back the rest: deliver one by one.
          for (const item of ready) {
            if (this.stopped) return false;
            try {
              await this.metrics.measurePhase('outbox_intake', () =>
                this.notifications.notifyNewMessage(
                  item.notification.conversation,
                  item.notification.message,
                  item.notification.actorUserId,
                  this.shutdown.signal,
                ),
              );
              delivered.push(item.claim);
            } catch {
              if (this.stopped) return false;
              failed.push({ ...item.claim, attempts: item.attempts });
            }
          }
        } else {
          // Unavailable or ambiguous: keep every intent for a later replay, which
          // notification-service deduplicates per message and recipient.
          for (const item of ready) {
            failed.push({ ...item.claim, attempts: item.attempts });
          }
        }
      }
    }

    if (failed.length > 0) {
      complete = false;
      await this.reschedule(failed);
    }
    if (delivered.length + cancelled.length > 0) {
      if (!(await this.complete(delivered, cancelled))) complete = false;
    }
    return complete;
  }

  // Back to pending with a backoff, but only while the claim is still ours.
  private async reschedule(
    claims: readonly { id: string; claimId: string; attempts?: number }[],
  ): Promise<boolean> {
    const now = Date.now();
    try {
      const rescheduled = await this.updateIntents(
        claims.map(({ id, claimId, attempts }) => {
          const delayMs = retryDelayMs(attempts ?? 1);
          return {
            q: { _id: { $oid: id }, notificationClaimId: claimId },
            u: {
              $set: {
                notificationClaimId: null,
                notificationNextAttemptAt: {
                  $date: new Date(now + delayMs).toISOString(),
                },
              },
            },
          };
        }),
      );
      for (let i = 0; i < claims.length; i++) {
        this.metrics.recordNotificationOutbox(
          i < rescheduled ? 'retry' : 'lease_lost',
        );
      }
      return rescheduled === claims.length;
    } catch {
      // Do not delete an intent when even rescheduling fails. The persisted
      // lease date makes it eligible again after restart/database recovery.
      this.metrics.recordNotificationOutbox('poll_error');
      return false;
    }
  }

  private async complete(
    delivered: readonly { id: string; claimId: string }[],
    cancelled: readonly { id: string; claimId: string }[],
  ): Promise<boolean> {
    const done = [...delivered, ...cancelled];
    let completed: number;
    try {
      completed = await this.metrics.measurePhase('outbox_complete', () =>
        this.updateIntents(
          done.map(({ id, claimId }) => ({
            q: { _id: { $oid: id }, notificationClaimId: claimId },
            u: {
              $set: {
                notificationRecipientIds: [],
                notificationNextAttemptAt: null,
                notificationClaimId: null,
              },
            },
          })),
        ),
      );
    } catch {
      // Not acknowledged: keep the intents. The jobs are durable and keyed by
      // message and recipient, so the replay is deduplicated by notification-service.
      await this.reschedule(done);
      return false;
    }
    // Mongo reports one total; a shortfall means some leases were taken over.
    const outcomes = [
      ...delivered.map(() => 'queued' as const),
      ...cancelled.map(() => 'cancelled' as const),
    ];
    outcomes.forEach((outcome, index) =>
      this.metrics.recordNotificationOutbox(
        index < completed ? outcome : 'lease_lost',
      ),
    );
    return completed === done.length;
  }

  // Prisma updateMany reads matching IDs before its write. These are guarded
  // single-document statements, sent together in one update command with no
  // read-back. Keep the due/claim guard in Mongo's actual write predicate so
  // another worker cannot acquire or clear a lease between a read and the update.
  private async updateIntents(
    statements: readonly {
      q: Prisma.InputJsonObject;
      u: Prisma.InputJsonObject;
    }[],
  ): Promise<number> {
    const result = await this.prisma.$runCommandRaw({
      update: 'messages',
      updates: statements.map(({ q, u }) => ({
        q,
        u,
        multi: false,
        upsert: false,
      })),
      ordered: false,
      writeConcern: { w: 'majority' },
    });
    // Mongo can return ok:1 with a per-write error. An ambiguous/unacknowledged
    // result must retain the intent, never count as durable completion.
    if (
      result.ok !== 1 ||
      (Array.isArray(result.writeErrors) && result.writeErrors.length > 0) ||
      result.writeConcernError ||
      typeof result.n !== 'number' ||
      result.n < 0 ||
      result.n > statements.length
    ) {
      throw new Error('Notification intent update was not acknowledged');
    }
    return result.n;
  }
}
