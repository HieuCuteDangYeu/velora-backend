import {
  ForbiddenException,
  HttpException,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import type Redis from 'ioredis';
import {
  DuplicateClientMessageError,
  MessageWriteConflictError,
} from './native-message-writer';

/**
 * Single writer per conversation.
 *
 * Every conversation has exactly one owner among the live conversation-service
 * replicas (rendezvous hashing over the replicas that sent a heartbeat in the
 * last few seconds). A replica that receives a message for a conversation it
 * does not own hands the prepared write to the owner over Redis pub/sub and
 * waits for the stored rows, so one process writes each conversation and the
 * replicas stop colliding on the same conversation document.
 *
 * It never gets in the way of delivery: when the owner cannot be reached, or
 * does not answer in time, forward() fails with WriteRouterUnavailableError and
 * the caller writes locally, exactly as without the router (the idempotent
 * client key makes a late duplicate harmless).
 */

const MEMBERS_KEY = 'chat:writers';
const channelOf = (replicaId: string) => `chat:w:${replicaId}`;

/** Date columns of the rows a write returns; JSON turns them into strings. */
const DATE_KEYS = [
  'createdAt',
  'updatedAt',
  'recalledAt',
  'lastMessageAt',
  'notificationNextAttemptAt',
] as const;

/** Why a forwarded write fell back to a local write. */
export type WriteRouteFallbackReason =
  | 'timeout'
  | 'publish_failed'
  | 'owner_gone'
  | 'stopped';

export class WriteRouterUnavailableError extends Error {
  constructor(
    reason: string,
    readonly fallbackReason: WriteRouteFallbackReason = 'stopped',
  ) {
    super(`Conversation write owner unavailable: ${reason}`);
    this.name = 'WriteRouterUnavailableError';
  }
}

/** Default wait for the owner; longer than a healthy forward, short of the 4 s it used to be. */
export const DEFAULT_WRITE_FORWARD_TIMEOUT_MS = 2_000;

type WireError = { kind: string; message: string; status?: number };
type WireMessage =
  | { t: 'q'; id: string; from: string; writes: unknown[] }
  | { t: 'r'; id: string; ok: true; results: unknown[] }
  | { t: 'r'; id: string; ok: false; err: WireError };

type Pending = {
  resolve: (results: unknown[]) => void;
  reject: (error: unknown) => void;
  timer: NodeJS.Timeout;
};

export type WriteHandler = (writes: unknown[]) => Promise<unknown[]>;

export interface WriteRouterOptions {
  selfId: string;
  /** Persists writes this replica owns; runs for forwarded requests. */
  handler: WriteHandler;
  heartbeatMs?: number;
  /**
   * false makes this replica a pure sender: it never owns a conversation and
   * forwards every write to an owner (for a replica on a slow link or a weak
   * machine that should carry sockets, not the write path). Default true.
   */
  ownsConversations?: boolean;
  /**
   * Maps a conversation to the zone whose replicas should own it (the zone of
   * its shard). Replicas register as `<zone>~<id>` (see memberId). Without it,
   * ownership is spread over every live replica.
   */
  zoneOf?: (conversationId: string) => string | null;
  /** A replica without a heartbeat for this long no longer owns anything. */
  memberTtlMs?: number;
  requestTimeoutMs?: number;
  /** Called once for every write that falls back to a local write. */
  onFallback?: (reason: WriteRouteFallbackReason) => void;
  logger?: Pick<Logger, 'log' | 'warn'>;
}

type RouterRedis = Pick<
  Redis,
  | 'publish'
  | 'zadd'
  | 'zremrangebyscore'
  | 'zrangebyscore'
  | 'zrem'
  | 'duplicate'
>;

// FNV-1a: cheap, well spread, identical on every replica.
function hash32(text: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** Separates an optional zone prefix from the replica part of a member id. */
export const ZONE_SEPARATOR = '~';

/** The member id a replica registers under: `<zone>~<replica>` when it has a zone. */
export function memberId(replica: string, zone?: string): string {
  return zone ? `${zone}${ZONE_SEPARATOR}${replica}` : replica;
}

export function zoneOfMember(member: string): string | null {
  const at = member.indexOf(ZONE_SEPARATOR);
  return at > 0 ? member.slice(0, at) : null;
}

/**
 * Highest-random-weight choice: a replica joining or leaving moves only its share.
 * With zoneOf, a conversation goes to a live replica of its own zone (the machine
 * that holds its shard) and only falls back to every replica when that zone has
 * none alive.
 */
export function chooseOwner(
  members: readonly string[],
  conversationId: string,
  zoneOf?: (conversationId: string) => string | null,
): string | null {
  const zone = zoneOf?.(conversationId) ?? null;
  const inZone = zone
    ? members.filter((member) => zoneOfMember(member) === zone)
    : [];
  const candidates = inZone.length > 0 ? inZone : members;
  let best: string | null = null;
  let bestWeight = -1;
  for (const member of candidates) {
    const weight = hash32(`${member}|${conversationId}`);
    if (
      weight > bestWeight ||
      (weight === bestWeight && member > (best ?? ''))
    ) {
      best = member;
      bestWeight = weight;
    }
  }
  return best;
}

export function encodeWriteError(error: unknown): WireError {
  if (error instanceof DuplicateClientMessageError)
    return { kind: 'duplicate', message: error.message };
  if (error instanceof MessageWriteConflictError)
    return { kind: 'conflict', message: error.message };
  if (error instanceof ForbiddenException)
    return { kind: 'forbidden', message: error.message };
  if (error instanceof NotFoundException)
    return { kind: 'notfound', message: error.message };
  if (error instanceof HttpException)
    return { kind: 'http', message: error.message, status: error.getStatus() };
  // Prisma's unique-key violation: the same message was stored already.
  if ((error as { code?: unknown } | null)?.code === 'P2002')
    return { kind: 'duplicate', message: 'Duplicate client message id' };
  return {
    kind: 'error',
    message: error instanceof Error ? error.message : 'write failed',
  };
}

export function decodeWriteError(err: WireError): Error {
  switch (err.kind) {
    case 'duplicate':
      return new DuplicateClientMessageError();
    case 'conflict':
      return new MessageWriteConflictError();
    case 'forbidden':
      return new ForbiddenException(err.message);
    case 'notfound':
      return new NotFoundException(err.message);
    case 'http':
      return new HttpException(err.message, err.status ?? 500);
    default:
      return new Error(err.message);
  }
}

function reviveRecord(record: unknown): unknown {
  if (!record || typeof record !== 'object') return record;
  const revived = { ...(record as Record<string, unknown>) };
  for (const key of DATE_KEYS) {
    const value = revived[key];
    if (typeof value === 'string') revived[key] = new Date(value);
  }
  return revived;
}

/** A stored [message, conversation] pair as it comes back over JSON. */
function revivePersisted(pair: unknown): unknown {
  return Array.isArray(pair) ? pair.map(reviveRecord) : pair;
}

export class ConversationWriteRouter {
  readonly selfId: string;
  private readonly redis: RouterRedis;
  private readonly handler: WriteHandler;
  private readonly heartbeatMs: number;
  private readonly owns: boolean;
  private readonly zoneOf?: (conversationId: string) => string | null;
  private readonly memberTtlMs: number;
  private readonly requestTimeoutMs: number;
  private readonly onFallback?: (reason: WriteRouteFallbackReason) => void;
  private readonly logger: Pick<Logger, 'log' | 'warn'>;
  private readonly pending = new Map<string, Pending>();
  private subscriber?: ReturnType<Redis['duplicate']>;
  private members: string[] = [];
  private heartbeat?: NodeJS.Timeout;
  private report?: NodeJS.Timeout;
  private sequence = 0;
  private stopped = false;
  private readonly counters = {
    forwarded: 0,
    served: 0,
    unavailable: 0,
    failed: 0,
  };
  private reported = '';

  constructor(redis: RouterRedis, options: WriteRouterOptions) {
    this.redis = redis;
    this.selfId = options.selfId;
    this.handler = options.handler;
    this.heartbeatMs = options.heartbeatMs ?? 2_000;
    this.owns = options.ownsConversations ?? true;
    this.zoneOf = options.zoneOf;
    this.memberTtlMs = options.memberTtlMs ?? 6_000;
    this.requestTimeoutMs =
      options.requestTimeoutMs ?? DEFAULT_WRITE_FORWARD_TIMEOUT_MS;
    this.onFallback = options.onFallback;
    this.logger = options.logger ?? new Logger(ConversationWriteRouter.name);
  }

  async start(): Promise<void> {
    const subscriber = this.redis.duplicate();
    this.subscriber = subscriber;
    subscriber.on('message', (_channel: string, raw: string) =>
      this.onMessage(raw),
    );
    subscriber.on('error', () => undefined);
    await subscriber.subscribe(channelOf(this.selfId));
    await this.beat();
    this.heartbeat = setInterval(() => void this.beat(), this.heartbeatMs);
    this.heartbeat.unref();
    this.report = setInterval(() => this.reportCounters(), 15_000);
    this.report.unref();
    this.logger.log(
      `Conversation write routing on: replica ${this.selfId}, ${this.members.length} live`,
    );
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.heartbeat) clearInterval(this.heartbeat);
    if (this.report) clearInterval(this.report);
    for (const [id, entry] of this.pending) {
      clearTimeout(entry.timer);
      this.fallBack('stopped');
      entry.reject(new WriteRouterUnavailableError('shutting down', 'stopped'));
      this.pending.delete(id);
    }
    try {
      await this.redis.zrem(MEMBERS_KEY, this.selfId);
    } catch {
      // The heartbeat expires on its own.
    }
    this.subscriber?.disconnect();
  }

  /** Live replicas as last seen; refreshed by the heartbeat. */
  liveMembers(): readonly string[] {
    return this.members;
  }

  /**
   * The replica that owns the conversation, or null when routing should not be
   * used (this replica is not registered yet, or it is the only one alive).
   */
  ownerOf(conversationId: string): string | null {
    if (this.owns) {
      if (this.members.length < 2 || !this.members.includes(this.selfId))
        return null;
    } else if (this.members.length < 1) {
      return null;
    }
    return chooseOwner(this.members, conversationId, this.zoneOf);
  }

  async forward(owner: string, writes: unknown[]): Promise<unknown[]> {
    if (this.stopped) {
      this.fallBack('stopped');
      throw new WriteRouterUnavailableError('stopped', 'stopped');
    }
    const id = `${this.selfId}:${++this.sequence}`;
    const result = new Promise<unknown[]>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        this.fallBack('timeout');
        reject(new WriteRouterUnavailableError('no answer in time', 'timeout'));
      }, this.requestTimeoutMs);
      this.pending.set(id, { resolve, reject, timer });
    });
    result.catch(() => undefined);
    // The publish is not awaited on its own: if its reply never comes, the
    // request timer above still settles the result.
    void this.redis
      .publish(
        channelOf(owner),
        JSON.stringify({
          t: 'q',
          id,
          from: this.selfId,
          writes,
        } satisfies WireMessage),
      )
      .then(
        (receivers) => {
          if (!this.pending.has(id)) return;
          // Nobody is listening on the owner's channel: it is gone, do not wait.
          if (receivers === 0) {
            this.fallBack('owner_gone');
            this.settle(
              id,
              new WriteRouterUnavailableError(
                'owner not subscribed',
                'owner_gone',
              ),
            );
          } else {
            this.counters.forwarded++;
          }
        },
        () => {
          if (!this.pending.has(id)) return;
          this.fallBack('publish_failed');
          this.settle(
            id,
            new WriteRouterUnavailableError('publish failed', 'publish_failed'),
          );
        },
      );
    return result;
  }

  private fallBack(reason: WriteRouteFallbackReason): void {
    this.counters.unavailable++;
    this.onFallback?.(reason);
  }

  private settle(id: string, error: unknown, results?: unknown[]): void {
    const entry = this.pending.get(id);
    if (!entry) return;
    this.pending.delete(id);
    clearTimeout(entry.timer);
    if (results) entry.resolve(results);
    else entry.reject(error);
  }

  private async beat(): Promise<void> {
    if (this.stopped) return;
    const now = Date.now();
    try {
      if (this.owns) await this.redis.zadd(MEMBERS_KEY, now, this.selfId);
      await this.redis.zremrangebyscore(
        MEMBERS_KEY,
        '-inf',
        now - this.memberTtlMs,
      );
      const live = await this.redis.zrangebyscore(
        MEMBERS_KEY,
        now - this.memberTtlMs,
        '+inf',
      );
      this.members = live.sort();
    } catch {
      // Keep the last known membership; forward() falls back when it is wrong.
    }
  }

  private onMessage(raw: string): void {
    let message: WireMessage;
    try {
      message = JSON.parse(raw) as WireMessage;
    } catch {
      return;
    }
    if (message.t === 'r') {
      if (message.ok)
        this.settle(
          message.id,
          undefined,
          message.results.map(revivePersisted),
        );
      else {
        this.counters.failed++;
        this.settle(message.id, decodeWriteError(message.err));
      }
      return;
    }
    void this.serve(message);
  }

  private async serve(
    request: Extract<WireMessage, { t: 'q' }>,
  ): Promise<void> {
    this.counters.served++;
    let reply: WireMessage;
    try {
      const results = await this.handler(request.writes);
      reply = { t: 'r', id: request.id, ok: true, results };
    } catch (error: unknown) {
      reply = {
        t: 'r',
        id: request.id,
        ok: false,
        err: encodeWriteError(error),
      };
    }
    try {
      await this.redis.publish(channelOf(request.from), JSON.stringify(reply));
    } catch {
      // The requester times out and writes locally; the client key makes that safe.
    }
  }

  private reportCounters(): void {
    const line = `forwarded=${this.counters.forwarded} served=${this.counters.served} unavailable=${this.counters.unavailable} failed=${this.counters.failed} live=${this.members.length}`;
    if (line === this.reported) return;
    this.reported = line;
    this.logger.log(`Conversation write routing: ${line}`);
  }
}
