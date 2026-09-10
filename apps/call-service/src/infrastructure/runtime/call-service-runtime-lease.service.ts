import { Inject, Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import Redis from 'ioredis';

const RENEW_LEASE_SCRIPT = `
if redis.call('GET', KEYS[1]) == ARGV[1] then
  return redis.call('PEXPIRE', KEYS[1], ARGV[2])
end
return 0
`;

const RELEASE_LEASE_SCRIPT = `
if redis.call('GET', KEYS[1]) == ARGV[1] then
  return redis.call('DEL', KEYS[1])
end
return 0
`;

type LeaseState = 'new' | 'held' | 'lost' | 'released' | 'bypassed';
type LeaseLossHandler = (error: Error) => void | Promise<void>;

function positiveInteger(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback;
}

/**
 * Mediasoup rooms and Socket.IO state are process-local. Until the service has
 * a multi-node adapter plus room affinity, only the Redis lease holder may run
 * the call runtime. The lease is deliberately acquired before Nest starts
 * listening, so a second instance fails closed instead of splitting a room.
 */
@Injectable()
export class CallServiceRuntimeLease implements OnModuleDestroy {
  private readonly logger = new Logger(CallServiceRuntimeLease.name);
  private readonly enabled = process.env.CALL_SINGLE_INSTANCE_GUARD !== 'false';
  private readonly key =
    process.env.CALL_RUNTIME_LEASE_KEY || 'velora:call-service:runtime-lease';
  private readonly ttlMs = positiveInteger(
    process.env.CALL_RUNTIME_LEASE_TTL_MS,
    15_000,
  );
  private readonly renewIntervalMs = Math.max(
    1_000,
    Math.floor(this.ttlMs / 3),
  );
  private readonly owner = `${
    process.env.CALL_RUNTIME_INSTANCE_ID ||
    process.env.HOSTNAME ||
    'call-service'
  }:${process.pid}:${randomUUID()}`;

  private state: LeaseState = 'new';
  private acquirePromise?: Promise<void>;
  private renewTimer?: ReturnType<typeof setInterval>;
  private renewInFlight = false;
  private lossHandler?: LeaseLossHandler;

  constructor(@Inject('REDIS_CLIENT') private readonly redis: Redis) {}

  onLeaseLost(handler: LeaseLossHandler): void {
    this.lossHandler = handler;
  }

  async acquire(): Promise<void> {
    if (!this.enabled) {
      this.state = 'bypassed';
      this.logger.warn(
        'CALL_SINGLE_INSTANCE_GUARD=false: call runtime is not protected from multiple instances',
      );
      return;
    }
    if (this.state === 'held') return;
    if (this.state !== 'new') {
      throw new Error(
        `Call runtime lease cannot be acquired after state=${this.state}`,
      );
    }
    if (this.acquirePromise) {
      return this.acquirePromise;
    }

    const acquisition = this.acquireInternal();
    this.acquirePromise = acquisition;
    try {
      await acquisition;
    } finally {
      if (this.acquirePromise === acquisition) {
        this.acquirePromise = undefined;
      }
    }
  }

  assertHeld(): void {
    if (!this.enabled || this.state === 'held') return;
    throw new Error(`Call runtime lease is not held (state=${this.state})`);
  }

  async onModuleDestroy(): Promise<void> {
    this.clearRenewal();

    if (this.enabled && this.state === 'held') {
      this.state = 'released';
      try {
        await this.redis.eval(RELEASE_LEASE_SCRIPT, 1, this.key, this.owner);
      } catch (error) {
        this.logger.warn(
          `Failed to release call runtime lease: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
    }

    this.redis.disconnect(false);
  }

  private async acquireInternal(): Promise<void> {
    const result = await this.redis.set(
      this.key,
      this.owner,
      'PX',
      this.ttlMs,
      'NX',
    );
    if (result !== 'OK') {
      throw new Error(
        `Another call-service instance already holds the runtime lease key=${this.key}`,
      );
    }

    this.state = 'held';
    this.renewTimer = setInterval(() => {
      void this.renew();
    }, this.renewIntervalMs);
    this.renewTimer.unref?.();
  }

  private async renew(): Promise<void> {
    if (this.state !== 'held' || this.renewInFlight) return;

    this.renewInFlight = true;
    try {
      const result = await this.redis.eval(
        RENEW_LEASE_SCRIPT,
        1,
        this.key,
        this.owner,
        String(this.ttlMs),
      );
      if (Number(result) !== 1) {
        throw new Error('Call runtime lease ownership was lost');
      }
    } catch (error) {
      this.markLost(
        error instanceof Error
          ? error
          : new Error(`Call runtime lease renewal failed: ${String(error)}`),
      );
    } finally {
      this.renewInFlight = false;
    }
  }

  private markLost(error: Error): void {
    if (this.state !== 'held') return;

    this.state = 'lost';
    this.clearRenewal();
    this.logger.error(`Call runtime lease lost: ${error.message}`);
    void Promise.resolve(this.lossHandler?.(error)).catch((handlerError) => {
      this.logger.error(
        `Call runtime lease loss handler failed: ${
          handlerError instanceof Error
            ? handlerError.message
            : String(handlerError)
        }`,
      );
    });
  }

  private clearRenewal(): void {
    if (this.renewTimer) {
      clearInterval(this.renewTimer);
      this.renewTimer = undefined;
    }
  }
}
