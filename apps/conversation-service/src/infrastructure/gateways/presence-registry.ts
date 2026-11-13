import { randomUUID } from 'node:crypto';
import type Redis from 'ioredis';

type RegistryRedis = Pick<Redis, 'multi' | 'pipeline' | 'zcount'>;

interface RegistryOptions {
  /** Set false to leave presence to the gateway's own socket queries. */
  enabled?: boolean;
  /** A socket not refreshed for this long stops counting (crashed replica). */
  ttlMs?: number;
  /** How often a replica refreshes the sockets it holds. */
  refreshMs?: number;
}

export interface LocalSocket {
  userId: string;
  socketId: string;
}

const PRESENCE_KEY_PREFIX = 'presence:sockets:';
const REFRESH_CHUNK = 500;

/**
 * Who is online, kept in Redis instead of asked of every replica.
 *
 * ChatGateway used to answer "is this user online?" with
 * server.in(userRoom).fetchSockets(). With the Socket.IO Redis adapter that is
 * a request to every replica, each returning a description of every socket in
 * the room, and the caller waits for all of them (5 s timeout). It ran on
 * every connect and disconnect, so a second replica on another machine made
 * socket setup time out under load.
 *
 * Here each user has a sorted set of their live sockets, scored by when the
 * entry expires. A socket is added on connect and removed on disconnect, and
 * every replica periodically refreshes the sockets it holds, so the sockets of
 * a replica that dies stop counting after ttlMs. "Online" is one ZCOUNT.
 */
export class PresenceRegistry {
  readonly enabled: boolean;
  readonly instanceId = randomUUID();
  private readonly ttlMs: number;
  private readonly refreshMs: number;
  private timer?: NodeJS.Timeout;
  private refreshing = false;

  constructor(
    private readonly redis: RegistryRedis,
    options: RegistryOptions = {},
  ) {
    this.enabled = options.enabled ?? true;
    this.ttlMs = options.ttlMs ?? 45_000;
    this.refreshMs = options.refreshMs ?? 15_000;
  }

  private key(userId: string): string {
    return `${PRESENCE_KEY_PREFIX}${userId}`;
  }

  private member(socketId: string): string {
    return `${this.instanceId}:${socketId}`;
  }

  /** Registers a socket and says whether the user already had a live one. */
  async connect(userId: string, socketId: string): Promise<boolean> {
    const now = Date.now();
    const key = this.key(userId);
    const results = await this.redis
      .multi()
      .zremrangebyscore(key, '-inf', now)
      .zcount(key, now, '+inf')
      .zadd(key, now + this.ttlMs, this.member(socketId))
      .pexpire(key, this.ttlMs * 2)
      .exec();
    return Number(this.read(results, 1)) > 0;
  }

  /** Removes a socket and says whether the user still has another live one. */
  async disconnect(userId: string, socketId: string): Promise<boolean> {
    const key = this.key(userId);
    const results = await this.redis
      .multi()
      .zrem(key, this.member(socketId))
      .zcount(key, Date.now(), '+inf')
      .exec();
    return Number(this.read(results, 1)) > 0;
  }

  async isOnline(userId: string): Promise<boolean> {
    return (await this.redis.zcount(this.key(userId), Date.now(), '+inf')) > 0;
  }

  /**
   * Keeps the sockets this replica holds alive. Errors are swallowed: a missed
   * refresh only matters once ttlMs has passed, and the next one repairs it.
   */
  startHeartbeat(
    localSockets: () => Iterable<LocalSocket>,
    onError?: (error: unknown) => void,
  ): void {
    if (!this.enabled || this.timer) return;
    this.timer = setInterval(() => {
      void this.refresh(localSockets()).catch((error: unknown) =>
        onError?.(error),
      );
    }, this.refreshMs);
    this.timer.unref();
  }

  stopHeartbeat(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  async refresh(sockets: Iterable<LocalSocket>): Promise<void> {
    if (this.refreshing) return;
    this.refreshing = true;
    try {
      const expiresAt = Date.now() + this.ttlMs;
      const byUser = new Map<string, string[]>();
      for (const { userId, socketId } of sockets) {
        const members = byUser.get(userId) ?? [];
        members.push(this.member(socketId));
        byUser.set(userId, members);
      }
      let pipeline = this.redis.pipeline();
      let commands = 0;
      for (const [userId, members] of byUser) {
        const key = this.key(userId);
        const args = members.flatMap((member) => [expiresAt, member]);
        pipeline.zadd(key, ...(args as [number, string]));
        pipeline.pexpire(key, this.ttlMs * 2);
        commands += 2;
        if (commands >= REFRESH_CHUNK) {
          await pipeline.exec();
          pipeline = this.redis.pipeline();
          commands = 0;
        }
      }
      if (commands > 0) await pipeline.exec();
    } finally {
      this.refreshing = false;
    }
  }

  private read(
    results: [Error | null, unknown][] | null,
    index: number,
  ): unknown {
    if (!results) throw new Error('Presence transaction was discarded');
    const failed = results.find(([error]) => error);
    if (failed?.[0]) throw failed[0];
    return results[index][1];
  }
}
