import { Logger } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import type Redis from 'ioredis';
import { safeCallErrorCode } from '../gateways/call-debug';

export const CALL_COORDINATOR = 'ICallCoordinator';

/**
 * Shared signaling state and mutual exclusion for the call gateway.
 *
 * The in-process implementation keeps the single-instance behaviour (embedded
 * media mode). The Redis implementation lets several signaling replicas share
 * the same per-call serialization and client-visible media state.
 */
export abstract class CallCoordinator {
  /** Runs `task` while no other holder of `key` runs, in any replica. */
  abstract runExclusive<T>(key: string, task: () => Promise<T>): Promise<T>;
  abstract hashGet(key: string, field: string): Promise<string | null>;
  abstract hashGetAll(key: string): Promise<Record<string, string>>;
  /** Sets one field and (re)starts the whole hash's time to live. */
  abstract hashSet(
    key: string,
    field: string,
    value: string,
    ttlMs: number,
  ): Promise<void>;
  /** Deletes the given fields, or the whole hash when none are given. */
  abstract hashDelete(key: string, fields?: string[]): Promise<void>;
  /**
   * Claims one run of periodic work named `name` for `ttlMs`. Exactly one
   * replica gets `true` per window, so global sweeps do not run N times.
   */
  abstract claimTick(name: string, ttlMs: number): Promise<boolean>;
  abstract dispose(): void;
}

/** Serializes tasks per key inside this process; the tail never rejects. */
class LocalKeyedQueue {
  private readonly tails = new Map<string, Promise<void>>();

  run<T>(key: string, task: () => Promise<T>): Promise<T> {
    const operation = (this.tails.get(key) ?? Promise.resolve())
      .catch(() => undefined)
      .then(task);
    const tail = operation.then(
      () => undefined,
      () => undefined,
    );
    this.tails.set(key, tail);
    return operation.finally(() => {
      if (this.tails.get(key) === tail) this.tails.delete(key);
    });
  }

  clear(): void {
    this.tails.clear();
  }
}

export class InProcessCallCoordinator extends CallCoordinator {
  private readonly queue = new LocalKeyedQueue();
  private readonly hashes = new Map<
    string,
    { fields: Map<string, string>; expiresAtMs: number }
  >();

  runExclusive<T>(key: string, task: () => Promise<T>): Promise<T> {
    return this.queue.run(key, task);
  }

  hashGet(key: string, field: string): Promise<string | null> {
    return Promise.resolve(this.liveHash(key)?.get(field) ?? null);
  }

  hashGetAll(key: string): Promise<Record<string, string>> {
    return Promise.resolve(
      Object.fromEntries(this.liveHash(key)?.entries() ?? []),
    );
  }

  hashSet(
    key: string,
    field: string,
    value: string,
    ttlMs: number,
  ): Promise<void> {
    const fields = this.liveHash(key) ?? new Map<string, string>();
    fields.set(field, value);
    this.hashes.set(key, { fields, expiresAtMs: Date.now() + ttlMs });
    return Promise.resolve();
  }

  hashDelete(key: string, fields?: string[]): Promise<void> {
    if (!fields) {
      this.hashes.delete(key);
      return Promise.resolve();
    }
    const hash = this.liveHash(key);
    for (const field of fields) hash?.delete(field);
    if (hash?.size === 0) this.hashes.delete(key);
    return Promise.resolve();
  }

  claimTick(): Promise<boolean> {
    return Promise.resolve(true);
  }

  dispose(): void {
    this.queue.clear();
    this.hashes.clear();
  }

  private liveHash(key: string): Map<string, string> | undefined {
    const entry = this.hashes.get(key);
    if (!entry) return undefined;
    if (entry.expiresAtMs <= Date.now()) {
      this.hashes.delete(key);
      return undefined;
    }
    return entry.fields;
  }
}

const RENEW_LOCK_SCRIPT = `
if redis.call('GET', KEYS[1]) == ARGV[1] then
  return redis.call('PEXPIRE', KEYS[1], ARGV[2])
end
return 0
`;

const RELEASE_LOCK_SCRIPT = `
if redis.call('GET', KEYS[1]) == ARGV[1] then
  return redis.call('DEL', KEYS[1])
end
return 0
`;

export class CallLockTimeoutError extends Error {
  readonly code = 'call_lock_timeout';
  constructor(key: string) {
    super(`Timed out waiting for call lock ${key}`);
  }
}

export interface RedisCallCoordinatorOptions {
  /** Lock lifetime without renewal: how long a crashed holder blocks others. */
  lockTtlMs?: number;
  /** Longest wait for a contended lock before the request fails. */
  lockWaitMs?: number;
}

export class RedisCallCoordinator extends CallCoordinator {
  private readonly logger = new Logger(RedisCallCoordinator.name);
  // Tasks for one key queue locally first, so a replica competes for the
  // Redis lock with one request at a time instead of polling N times.
  private readonly queue = new LocalKeyedQueue();
  private readonly owner = randomUUID();
  private readonly lockTtlMs: number;
  private readonly lockWaitMs: number;

  constructor(
    private readonly redis: Redis,
    options: RedisCallCoordinatorOptions = {},
  ) {
    super();
    this.lockTtlMs = options.lockTtlMs ?? 10_000;
    this.lockWaitMs = options.lockWaitMs ?? 20_000;
  }

  runExclusive<T>(key: string, task: () => Promise<T>): Promise<T> {
    return this.queue.run(key, () => this.withRedisLock(key, task));
  }

  hashGet(key: string, field: string): Promise<string | null> {
    return this.redis.hget(key, field);
  }

  hashGetAll(key: string): Promise<Record<string, string>> {
    return this.redis.hgetall(key);
  }

  async hashSet(
    key: string,
    field: string,
    value: string,
    ttlMs: number,
  ): Promise<void> {
    await this.redis.multi().hset(key, field, value).pexpire(key, ttlMs).exec();
  }

  async hashDelete(key: string, fields?: string[]): Promise<void> {
    if (!fields) {
      await this.redis.del(key);
      return;
    }
    if (fields.length) await this.redis.hdel(key, ...fields);
  }

  async claimTick(name: string, ttlMs: number): Promise<boolean> {
    const result = await this.redis.set(
      `call:tick:${name}`,
      this.owner,
      'PX',
      Math.max(1, ttlMs),
      'NX',
    );
    return result === 'OK';
  }

  dispose(): void {
    this.queue.clear();
  }

  private async withRedisLock<T>(
    key: string,
    task: () => Promise<T>,
  ): Promise<T> {
    const lockKey = `call:lock:${key}`;
    const token = `${this.owner}:${randomUUID()}`;
    await this.acquire(lockKey, token, key);

    const renewal = setInterval(
      () => {
        this.redis
          .eval(RENEW_LOCK_SCRIPT, 1, lockKey, token, String(this.lockTtlMs))
          .catch((error) =>
            this.logger.warn(
              `Call lock renewal failed errorCode=${safeCallErrorCode(error)}`,
            ),
          );
      },
      Math.max(500, Math.floor(this.lockTtlMs / 3)),
    );
    renewal.unref?.();

    try {
      return await task();
    } finally {
      clearInterval(renewal);
      await this.redis
        .eval(RELEASE_LOCK_SCRIPT, 1, lockKey, token)
        .catch((error) =>
          this.logger.warn(
            `Call lock release failed errorCode=${safeCallErrorCode(error)}`,
          ),
        );
    }
  }

  private async acquire(
    lockKey: string,
    token: string,
    key: string,
  ): Promise<void> {
    const deadline = Date.now() + this.lockWaitMs;
    let delayMs = 5;
    while (true) {
      const result = await this.redis.set(
        lockKey,
        token,
        'PX',
        this.lockTtlMs,
        'NX',
      );
      if (result === 'OK') return;
      if (Date.now() >= deadline) throw new CallLockTimeoutError(key);
      await new Promise((resolve) =>
        setTimeout(resolve, delayMs + Math.random() * delayMs),
      );
      delayMs = Math.min(100, delayMs * 2);
    }
  }
}
