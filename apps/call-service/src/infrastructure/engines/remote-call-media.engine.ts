import {
  Inject,
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import {
  ClientProxy,
  ClientProxyFactory,
  Transport,
} from '@nestjs/microservices';
import type Redis from 'ioredis';
import { lastValueFrom, timeout } from 'rxjs';
import type {
  ActiveProducerResult,
  ClosedMediaConsumerResult,
  ClosedMediaProducerResult,
  ClosedParticipantMediaResult,
  ConsumedMediaResult,
  CreateRecvTransportResult,
  CreateSendTransportResult,
  ICallMediaEngine,
  MediaPublicAddressStatus,
  MediaWorkerLoad,
  ProducedMediaResult,
  RestartIceResult,
  RouterRtpCapabilitiesResult,
} from '../../domain/interfaces/call-media.engine.interface';
import {
  callMediaPlacementKey,
  MEDIA_NODE_INVOKE_PATTERN,
  MEDIA_NODE_STALE_INCARNATION,
  MEDIA_NODES_KEY,
  mediaNodeCallsKey,
  mediaNodeKey,
  type MediaNodeInvokeRequest,
  type MediaNodeRecord,
  type MediaRoomsLostEvent,
  type RemoteMediaMethod,
} from '../../media-node/media-node.contract';
import { safeCallErrorCode, shortCallIdentifier } from '../gateways/call-debug';
import { RedisCallStateRepository } from '../repositories/redis-call-state.repository';

/** Which node (and which run of it) holds a call's mediasoup room. */
export interface MediaPlacement {
  nodeId: string;
  incarnation: string;
}

/** The room is gone: never placed, already closed, or its node died. */
class MediaRoomUnavailable extends Error {
  constructor() {
    super('Call room not found');
  }
}

export const REMOTE_MEDIA_RPC_TIMEOUT_MS = 5_000;
// Placement outlives any call; the call's other Redis state uses the same TTL.
const PLACEMENT_TTL_MS = 6 * 60 * 60 * 1000;
const PLACEMENT_CACHE_LIMIT = 10_000;

function positiveInteger(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

/**
 * ICallMediaEngine for stateless signaling replicas. Each call is placed on
 * one live media node (least rooms first) and every later command for that
 * call goes to the same node and incarnation. Calls whose node died or
 * restarted are reported through onRoomsLost, exactly like a dead worker in
 * the embedded engine.
 */
@Injectable()
export class RemoteCallMediaEngine
  implements ICallMediaEngine, OnModuleInit, OnModuleDestroy
{
  private readonly logger = new Logger(RemoteCallMediaEngine.name);
  private readonly clients = new Map<string, ClientProxy>();
  // Placements never change during a call, so caching them is safe; a stale
  // entry only means one extra failed RPC after the node died.
  private readonly placements = new Map<string, MediaPlacement>();
  private readonly roomsLostListeners = new Set<(callIds: string[]) => void>();
  private readonly sweepIntervalMs = positiveInteger(
    process.env.CALL_MEDIA_NODE_SWEEP_INTERVAL_MS,
    5_000,
  );
  private sweepTimer?: ReturnType<typeof setInterval>;
  private sweepInFlight = false;

  constructor(
    @Inject('REDIS_CLIENT') private readonly redis: Redis,
    private readonly stateRepository: RedisCallStateRepository,
  ) {}

  onModuleInit(): void {
    this.sweepTimer = setInterval(() => {
      void this.sweepLostNodes();
    }, this.sweepIntervalMs);
    this.sweepTimer.unref?.();
  }

  onModuleDestroy(): void {
    if (this.sweepTimer) clearInterval(this.sweepTimer);
    for (const client of this.clients.values()) void client.close();
    this.clients.clear();
  }

  onRoomsLost(listener: (callIds: string[]) => void): void {
    this.roomsLostListeners.add(listener);
  }

  async createRoom(callId: string): Promise<void> {
    const placement = await this.place(callId);
    await this.invokeOn(placement, 'createRoom', [callId]);
  }

  getRouterRtpCapabilities(
    callId: string,
  ): Promise<RouterRtpCapabilitiesResult> {
    return this.invoke(callId, 'getRouterRtpCapabilities', [callId]);
  }

  createSendTransport(
    callId: string,
    userId: string,
  ): Promise<CreateSendTransportResult> {
    return this.invoke(callId, 'createSendTransport', [callId, userId]);
  }

  createRecvTransport(
    callId: string,
    userId: string,
  ): Promise<CreateRecvTransportResult> {
    return this.invoke(callId, 'createRecvTransport', [callId, userId]);
  }

  async connectTransport(
    callId: string,
    userId: string,
    transportId: string,
    dtlsParameters: Record<string, unknown>,
  ): Promise<void> {
    await this.invoke(callId, 'connectTransport', [
      callId,
      userId,
      transportId,
      dtlsParameters,
    ]);
  }

  restartIce(
    callId: string,
    userId: string,
    transportId: string,
  ): Promise<RestartIceResult> {
    return this.invoke(callId, 'restartIce', [callId, userId, transportId]);
  }

  async setConsumerMaxBitrate(
    callId: string,
    userId: string,
    transportId: string,
    bitrate: number,
  ): Promise<void> {
    await this.invoke(callId, 'setConsumerMaxBitrate', [
      callId,
      userId,
      transportId,
      bitrate,
    ]);
  }

  produce(
    callId: string,
    userId: string,
    transportId: string,
    kind: 'audio' | 'video',
    rtpParameters: Record<string, unknown>,
    requestId?: string,
  ): Promise<ProducedMediaResult> {
    return this.invoke(callId, 'produce', [
      callId,
      userId,
      transportId,
      kind,
      rtpParameters,
      requestId,
    ]);
  }

  consume(
    callId: string,
    userId: string,
    transportId: string,
    producerId: string,
    rtpCapabilities: Record<string, unknown>,
  ): Promise<ConsumedMediaResult> {
    return this.invoke(callId, 'consume', [
      callId,
      userId,
      transportId,
      producerId,
      rtpCapabilities,
    ]);
  }

  async resumeConsumer(
    callId: string,
    userId: string,
    consumerId: string,
  ): Promise<void> {
    await this.invoke(callId, 'resumeConsumer', [callId, userId, consumerId]);
  }

  async closeConsumer(
    callId: string,
    userId: string,
    consumerId: string,
  ): Promise<ClosedMediaConsumerResult> {
    try {
      return await this.invoke(callId, 'closeConsumer', [
        callId,
        userId,
        consumerId,
      ]);
    } catch (error) {
      if (error instanceof MediaRoomUnavailable) return { closed: false };
      throw error;
    }
  }

  listActiveProducers(
    callId: string,
    excludingUserId?: string,
  ): Promise<ActiveProducerResult[]> {
    return this.invoke(callId, 'listActiveProducers', [
      callId,
      excludingUserId,
    ]);
  }

  async pauseProducer(
    callId: string,
    userId: string,
    producerId: string,
  ): Promise<void> {
    await this.invoke(callId, 'pauseProducer', [callId, userId, producerId]);
  }

  async resumeProducer(
    callId: string,
    userId: string,
    producerId: string,
  ): Promise<void> {
    await this.invoke(callId, 'resumeProducer', [callId, userId, producerId]);
  }

  closeProducer(
    callId: string,
    userId: string,
    producerId: string,
  ): Promise<ClosedMediaProducerResult> {
    return this.invoke(callId, 'closeProducer', [callId, userId, producerId]);
  }

  async closeParticipant(
    callId: string,
    userId: string,
  ): Promise<ClosedParticipantMediaResult> {
    try {
      return await this.invoke(callId, 'closeParticipant', [callId, userId]);
    } catch (error) {
      if (error instanceof MediaRoomUnavailable) return { producers: [] };
      throw error;
    }
  }

  async closeRoom(callId: string): Promise<void> {
    const placement = await this.getPlacement(callId);
    if (placement) {
      try {
        await this.invokeOn(placement, 'closeRoom', [callId]);
      } catch (error) {
        // A dead node already lost the room. Anything else (timeout on a
        // live node) must fail so terminal cleanup retries.
        if (!(error instanceof MediaRoomUnavailable)) throw error;
      }
      await this.forgetPlacement(callId, placement);
    }
    // The node clears this itself; repeat it for calls whose node is gone.
    await this.stateRepository.clearCallState(callId);
  }

  getWorkerLoad(): Promise<MediaWorkerLoad[]> {
    // Each media node exports its own worker metrics.
    return Promise.resolve([]);
  }

  getPublicAddressStatus(): MediaPublicAddressStatus {
    // Public address detection runs on media nodes, not on signaling.
    return {
      detectionEnabled: false,
      lastCheckSucceeded: false,
      lastSuccessTimestampSeconds: 0,
      changes: 0,
      mismatch: false,
    };
  }

  /** A media node reported rooms lost with a dead worker. */
  async handleRoomsLostEvent(event: MediaRoomsLostEvent): Promise<void> {
    if (!event?.nodeId || !Array.isArray(event.callIds)) return;
    const lost: string[] = [];
    for (const callId of event.callIds) {
      const placement = await this.getPlacement(callId, { fresh: true });
      // Ignore late events for calls that were re-placed or already ended.
      if (
        placement?.nodeId === event.nodeId &&
        placement.incarnation === event.incarnation
      ) {
        lost.push(callId);
      }
    }
    this.notifyRoomsLost(lost);
  }

  /**
   * Ends calls whose node stopped heartbeating or restarted. One replica
   * runs it per interval; the terminal transition is idempotent anyway.
   */
  async sweepLostNodes(): Promise<void> {
    if (this.sweepInFlight) return;
    this.sweepInFlight = true;
    try {
      const claimed = await this.redis.set(
        'call:tick:media-node-sweep',
        '1',
        'PX',
        Math.max(500, Math.floor(this.sweepIntervalMs * 0.8)),
        'NX',
      );
      if (claimed !== 'OK') return;

      const nodeIds = await this.redis.zrange(MEDIA_NODES_KEY, 0, -1);
      for (const nodeId of nodeIds) {
        const record = await this.readNode(nodeId);
        const callIds = await this.redis.smembers(mediaNodeCallsKey(nodeId));
        const lost: string[] = [];
        for (const callId of callIds) {
          const placement = await this.getPlacement(callId, { fresh: true });
          if (!placement || placement.nodeId !== nodeId) {
            await this.redis.srem(mediaNodeCallsKey(nodeId), callId);
          } else if (record?.incarnation !== placement.incarnation) {
            lost.push(callId);
          }
        }
        if (!record && callIds.length === 0) {
          await this.redis.zrem(MEDIA_NODES_KEY, nodeId);
        }
        if (lost.length) {
          this.logger.warn(
            `Media node ${nodeId} lost ${lost.length} room(s); ending those calls`,
          );
          this.notifyRoomsLost(lost);
        }
      }
    } catch (error) {
      this.logger.warn(
        `Media node sweep failed errorCode=${safeCallErrorCode(error)}`,
      );
    } finally {
      this.sweepInFlight = false;
    }
  }

  private notifyRoomsLost(callIds: string[]): void {
    if (!callIds.length) return;
    for (const callId of callIds) this.placements.delete(callId);
    for (const listener of this.roomsLostListeners) listener(callIds);
  }

  /** Returns the call's placement, choosing the least-loaded node if new. */
  private async place(callId: string): Promise<MediaPlacement> {
    const existing = await this.getPlacement(callId, { fresh: true });
    if (existing) return existing;

    const node = await this.chooseNode();
    const candidate: MediaPlacement = {
      nodeId: node.nodeId,
      incarnation: node.incarnation,
    };
    // NX: concurrent createRoom calls (initiate + accept retry, possibly on
    // different replicas) all converge on whichever placement won.
    const won = await this.redis.set(
      callMediaPlacementKey(callId),
      JSON.stringify(candidate),
      'PX',
      PLACEMENT_TTL_MS,
      'NX',
    );
    const placement =
      won === 'OK'
        ? candidate
        : await this.getPlacement(callId, { fresh: true });
    if (!placement) throw new Error('Media worker is unavailable');
    await this.redis.sadd(mediaNodeCallsKey(placement.nodeId), callId);
    this.cachePlacement(callId, placement);
    return placement;
  }

  private async chooseNode(): Promise<MediaNodeRecord> {
    const nodeIds = await this.redis.zrange(MEDIA_NODES_KEY, 0, -1);
    const live = (
      await Promise.all(nodeIds.map((nodeId) => this.readNode(nodeId)))
    ).filter((record): record is MediaNodeRecord => record !== null);
    if (!live.length) throw new Error('Media worker is unavailable');
    const fewest = Math.min(...live.map((record) => record.rooms));
    const candidates = live.filter((record) => record.rooms === fewest);
    // Random among equals so replicas placing at once do not pile on one node.
    return candidates[Math.floor(Math.random() * candidates.length)];
  }

  private async readNode(nodeId: string): Promise<MediaNodeRecord | null> {
    const raw = await this.redis.get(mediaNodeKey(nodeId));
    if (!raw) return null;
    try {
      return JSON.parse(raw) as MediaNodeRecord;
    } catch {
      return null;
    }
  }

  private async getPlacement(
    callId: string,
    options: { fresh?: boolean } = {},
  ): Promise<MediaPlacement | null> {
    if (!options.fresh) {
      const cached = this.placements.get(callId);
      if (cached) return cached;
    }
    const raw = await this.redis.get(callMediaPlacementKey(callId));
    if (!raw) {
      this.placements.delete(callId);
      return null;
    }
    try {
      const placement = JSON.parse(raw) as MediaPlacement;
      this.cachePlacement(callId, placement);
      return placement;
    } catch {
      return null;
    }
  }

  private cachePlacement(callId: string, placement: MediaPlacement): void {
    this.placements.delete(callId);
    this.placements.set(callId, placement);
    if (this.placements.size > PLACEMENT_CACHE_LIMIT) {
      const oldest = this.placements.keys().next();
      if (!oldest.done) this.placements.delete(oldest.value);
    }
  }

  private async forgetPlacement(
    callId: string,
    placement: MediaPlacement,
  ): Promise<void> {
    this.placements.delete(callId);
    await this.redis
      .multi()
      .del(callMediaPlacementKey(callId))
      .srem(mediaNodeCallsKey(placement.nodeId), callId)
      .exec();
  }

  private async invoke<T>(
    callId: string,
    method: RemoteMediaMethod,
    args: unknown[],
  ): Promise<T> {
    const placement = await this.getPlacement(callId);
    if (!placement) throw new MediaRoomUnavailable();
    return this.invokeOn<T>(placement, method, args);
  }

  private async invokeOn<T>(
    placement: MediaPlacement,
    method: RemoteMediaMethod,
    args: unknown[],
  ): Promise<T> {
    const node = await this.readNode(placement.nodeId);
    if (!node || node.incarnation !== placement.incarnation) {
      throw new MediaRoomUnavailable();
    }
    const request: MediaNodeInvokeRequest = {
      method,
      args,
      incarnation: placement.incarnation,
    };
    try {
      const result = await lastValueFrom(
        this.clientFor(node)
          .send<T>(MEDIA_NODE_INVOKE_PATTERN, request)
          .pipe(timeout(REMOTE_MEDIA_RPC_TIMEOUT_MS)),
      );
      // The node sends null for void results; callers expect undefined.
      return (result ?? undefined) as T;
    } catch (error) {
      throw this.toLocalError(error, method, args[0]);
    }
  }

  private clientFor(node: MediaNodeRecord): ClientProxy {
    const address = `${node.rpcHost}:${node.rpcPort}`;
    let client = this.clients.get(address);
    if (!client) {
      client = ClientProxyFactory.create({
        transport: Transport.TCP,
        options: { host: node.rpcHost, port: node.rpcPort },
      });
      this.clients.set(address, client);
    }
    return client;
  }

  private toLocalError(error: unknown, method: string, callId: unknown): Error {
    const body =
      error && typeof error === 'object'
        ? (error as { message?: unknown; code?: unknown })
        : {};
    if (body.code === MEDIA_NODE_STALE_INCARNATION) {
      return new MediaRoomUnavailable();
    }
    if (error instanceof Error && error.name === 'TimeoutError') {
      this.logger.warn(
        `Media ${method} timed out call=${shortCallIdentifier(
          typeof callId === 'string' ? callId : undefined,
        )}`,
      );
      return new Error(`Media node request timed out (${method})`);
    }
    if (body.message === 'Call room not found') {
      return new MediaRoomUnavailable();
    }
    if (typeof body.message === 'string' && body.message.length > 0) {
      return new Error(body.message);
    }
    return error instanceof Error ? error : new Error('Media request failed');
  }
}
