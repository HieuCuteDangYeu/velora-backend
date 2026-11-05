import {
  Inject,
  Injectable,
  Logger,
  OnApplicationBootstrap,
  OnApplicationShutdown,
} from '@nestjs/common';
import type Redis from 'ioredis';
import type { MediaWorkerLoad } from '../domain/interfaces/call-media.engine.interface';
import { safeCallErrorCode } from '../infrastructure/gateways/call-debug';
import { MediasoupCallMediaEngine } from '../infrastructure/engines/mediasoup-call.engine';
import {
  MEDIA_NODES_KEY,
  mediaNodeKey,
  type MediaNodeRecord,
} from './media-node.contract';
import { MediaNodeIdentity } from './media-node-identity';

/**
 * Publishes this node's heartbeat so signaling can place calls on it and can
 * end the calls it held once the heartbeat expires or the incarnation changes.
 */
@Injectable()
export class MediaNodeRegistry
  implements OnApplicationBootstrap, OnApplicationShutdown
{
  private readonly logger = new Logger(MediaNodeRegistry.name);
  private timer?: ReturnType<typeof setInterval>;
  private stopped = false;

  constructor(
    @Inject('REDIS_CLIENT') private readonly redis: Redis,
    private readonly identity: MediaNodeIdentity,
    private readonly engine: MediasoupCallMediaEngine,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    // Fail startup if Redis is unreachable: an unregistered node gets no calls.
    await this.heartbeat();
    this.timer = setInterval(
      () => {
        void this.heartbeat().catch((error) =>
          this.logger.warn(
            `Media node heartbeat failed errorCode=${safeCallErrorCode(error)}`,
          ),
        );
      },
      Math.max(1_000, Math.floor(this.identity.heartbeatTtlMs / 3)),
    );
    this.timer.unref?.();
    this.logger.log(
      `Media node ${this.identity.nodeId} registered rpc=${this.identity.rpcHost}:${this.identity.rpcPort}`,
    );
  }

  async onApplicationShutdown(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    // Rooms die with this process. Removing the record lets signaling end
    // the affected calls now instead of after the heartbeat expires.
    try {
      const current = await this.redis.get(mediaNodeKey(this.identity.nodeId));
      const record = current ? (JSON.parse(current) as MediaNodeRecord) : null;
      if (record?.incarnation === this.identity.incarnation) {
        await this.redis.del(mediaNodeKey(this.identity.nodeId));
      }
    } catch (error) {
      this.logger.warn(
        `Media node deregistration failed errorCode=${safeCallErrorCode(error)}`,
      );
    }
  }

  async heartbeat(): Promise<void> {
    if (this.stopped) return;
    const load: MediaWorkerLoad[] = await this.engine
      .getWorkerLoad()
      .catch(() => []);
    const record: MediaNodeRecord = {
      nodeId: this.identity.nodeId,
      incarnation: this.identity.incarnation,
      rpcHost: this.identity.rpcHost,
      rpcPort: this.identity.rpcPort,
      rooms: load.reduce((total, worker) => total + worker.rooms, 0),
      updatedAtMs: Date.now(),
    };
    await this.redis
      .multi()
      .set(
        mediaNodeKey(record.nodeId),
        JSON.stringify(record),
        'PX',
        this.identity.heartbeatTtlMs,
      )
      .zadd(MEDIA_NODES_KEY, record.updatedAtMs, record.nodeId)
      .exec();
  }
}
