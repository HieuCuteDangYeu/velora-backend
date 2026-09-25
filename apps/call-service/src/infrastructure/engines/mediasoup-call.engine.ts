import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import * as mediasoup from 'mediasoup';
import type {
  ActiveProducerResult,
  ClosedMediaConsumerResult,
  ClosedParticipantMediaResult,
  ConsumedMediaResult,
  CreateRecvTransportResult,
  CreateSendTransportResult,
  ICallMediaEngine,
  ProducedMediaResult,
  RestartIceResult,
  RouterRtpCapabilitiesResult,
} from '../../domain/interfaces/call-media.engine.interface';
import { safeCallErrorCode, shortCallIdentifier } from '../gateways/call-debug';
import {
  RedisCallStateRepository,
  type StoredTransportState,
} from '../repositories/redis-call-state.repository';
import {
  getAnnouncedIpAddressFamily,
  validateMediasoupNetworkConfiguration,
} from './mediasoup-network-configuration';

type MediaType = 'audio' | 'video';
type TransportDirection = 'send' | 'recv';
type RoomRuntimeState = {
  callId: string;
  worker: mediasoup.types.Worker;
  router: mediasoup.types.Router;
  transports: Map<string, mediasoup.types.WebRtcTransport>;
  transportMeta: Map<
    string,
    {
      callId: string;
      userId: string;
      direction: TransportDirection;
      connected: boolean;
    }
  >;
  producers: Map<string, mediasoup.types.Producer>;
  producerByUserKind: Map<string, string>;
  producerOperations: Map<
    string,
    { producerId: string; transportId: string; userId: string; kind: MediaType }
  >;
  producerMeta: Map<
    string,
    { callId: string; userId: string; transportId: string; kind: MediaType }
  >;
  consumers: Map<string, mediasoup.types.Consumer>;
  consumerMeta: Map<
    string,
    { callId: string; userId: string; transportId: string; producerId: string }
  >;
};

@Injectable()
export class MediasoupCallMediaEngine
  implements ICallMediaEngine, OnModuleInit, OnModuleDestroy
{
  private readonly logger = new Logger(MediasoupCallMediaEngine.name);
  private readonly rooms = new Map<string, RoomRuntimeState>();
  // A lost accept acknowledgement can retry while the first request is still
  // creating the router. Keep room creation single-flight per call so the
  // same durable answer action cannot leak a second router.
  private readonly roomCreationPromises = new Map<string, Promise<void>>();
  private readonly producerCreationPromises = new Map<
    string,
    Promise<ProducedMediaResult>
  >();
  // Consumer retries can overlap when a response times out on the mobile
  // control plane while mediasoup is still allocating the first Consumer.
  // Serialize per receiver+producer so an older allocation can never finish
  // after a newer one and close the newer Consumer as "stale".
  private readonly consumerCreationPromises = new Map<
    string,
    Promise<ConsumedMediaResult>
  >();
  private readonly workers: mediasoup.types.Worker[] = [];
  private readonly webRtcServers = new Map<
    mediasoup.types.Worker,
    mediasoup.types.WebRtcServer
  >();
  private workerCursor = 0;
  private readonly workerCount = Math.max(
    1,
    Number(process.env.MEDIASOUP_WORKERS || 1),
  );
  // A WebRtcServer multiplexes every transport for one worker over one UDP
  // socket. This is useful behind routers that cannot forward a port range.
  private readonly webRtcServerPort = this.readOptionalPort(
    process.env.MEDIASOUP_WEBRTC_SERVER_PORT,
  );

  constructor(private readonly stateRepository: RedisCallStateRepository) {}

  async onModuleInit(): Promise<void> {
    const announcedIp = process.env.MEDIASOUP_ANNOUNCED_IP?.trim();
    validateMediasoupNetworkConfiguration({
      environment: process.env.NODE_ENV,
      announcedIp,
    });
    if (process.env.NODE_ENV?.toLowerCase() === 'production') {
      this.logger.log(
        `Validated public Mediasoup ${getAnnouncedIpAddressFamily(announcedIp)} candidate configuration`,
      );
    }

    if (this.webRtcServerPort && this.workerCount !== 1) {
      throw new Error(
        'MEDIASOUP_WEBRTC_SERVER_PORT requires MEDIASOUP_WORKERS=1 because each worker needs its own UDP socket',
      );
    }

    await this.bootstrapWorkers(this.workerCount);
  }

  onModuleDestroy(): Promise<void> {
    this.webRtcServers.forEach((webRtcServer) => webRtcServer.close());
    this.workers.forEach((worker) => worker.close());
    return Promise.resolve();
  }

  async createRoom(callId: string): Promise<void> {
    if (this.rooms.has(callId)) return;

    const existingCreation = this.roomCreationPromises.get(callId);
    if (existingCreation) {
      return existingCreation;
    }

    const creation = this.createRoomInternal(callId);
    this.roomCreationPromises.set(callId, creation);

    try {
      await creation;
    } finally {
      if (this.roomCreationPromises.get(callId) === creation) {
        this.roomCreationPromises.delete(callId);
      }
    }
  }

  private async createRoomInternal(callId: string): Promise<void> {
    // A call can have been created by the request that won the single-flight
    // check while this request was scheduled.
    if (this.rooms.has(callId)) return;

    const worker = await this.getNextWorker();
    const router = await worker.createRouter({
      mediaCodecs: [
        {
          kind: 'audio',
          mimeType: 'audio/opus',
          clockRate: 48000,
          channels: 2,
          parameters: {
            useinbandfec: 1,
            usedtx: 1,
          },
        },
        {
          kind: 'video',
          mimeType: 'video/VP8',
          clockRate: 90000,
          parameters: {
            'x-google-start-bitrate': 1000,
          },
        },
      ],
    });

    try {
      await this.stateRepository.saveRoom({
        callId,
        workerId: String(worker.pid),
        routerId: router.id,
      });
    } catch (error) {
      try {
        router.close();
      } catch {
        // Preserve the persistence failure that prevented room creation.
      }
      throw error;
    }

    this.rooms.set(callId, {
      callId,
      worker,
      router,
      transports: new Map(),
      transportMeta: new Map(),
      producers: new Map(),
      producerByUserKind: new Map(),
      producerOperations: new Map(),
      producerMeta: new Map(),
      consumers: new Map(),
      consumerMeta: new Map(),
    });
  }

  getRouterRtpCapabilities(
    callId: string,
  ): Promise<RouterRtpCapabilitiesResult> {
    const room = this.getRoomOrThrow(callId);
    return Promise.resolve({
      codecs: room.router.rtpCapabilities.codecs ?? [],
      headerExtensions: room.router.rtpCapabilities.headerExtensions ?? [],
    });
  }

  async createSendTransport(
    callId: string,
    userId: string,
  ): Promise<CreateSendTransportResult> {
    return this.createTransport(callId, userId, 'send');
  }

  async createRecvTransport(
    callId: string,
    userId: string,
  ): Promise<CreateRecvTransportResult> {
    return this.createTransport(callId, userId, 'recv');
  }

  async connectTransport(
    callId: string,
    userId: string,
    transportId: string,
    dtlsParameters: Record<string, unknown>,
  ): Promise<void> {
    const room = this.getRoomOrThrow(callId);
    const transport = room.transports.get(transportId);
    const meta = room.transportMeta.get(transportId);

    if (
      !transport ||
      !meta ||
      meta.userId !== userId ||
      meta.callId !== callId
    ) {
      throw new Error('Transport not found');
    }

    await transport.connect({
      dtlsParameters: dtlsParameters as mediasoup.types.DtlsParameters,
    });

    await this.persistTransportStateOrClose(room, transport, {
      transportId,
      callId,
      userId,
      direction: meta.direction,
      connected: true,
    });
    room.transportMeta.set(transportId, { ...meta, connected: true });
  }

  async restartIce(
    callId: string,
    userId: string,
    transportId: string,
  ): Promise<RestartIceResult> {
    const room = this.getRoomOrThrow(callId);
    const transport = room.transports.get(transportId);
    const meta = room.transportMeta.get(transportId);

    if (
      !transport ||
      !meta ||
      meta.userId !== userId ||
      meta.callId !== callId ||
      !meta.connected
    ) {
      throw new Error('Transport is not connected');
    }

    return {
      iceParameters: (await transport.restartIce()) as unknown as Record<
        string,
        unknown
      >,
    };
  }

  async setConsumerMaxBitrate(
    callId: string,
    userId: string,
    transportId: string,
    bitrate: number,
  ): Promise<void> {
    const room = this.getRoomOrThrow(callId);
    const transport = room.transports.get(transportId);
    const meta = room.transportMeta.get(transportId);

    if (
      !transport ||
      !meta ||
      meta.callId !== callId ||
      meta.userId !== userId ||
      meta.direction !== 'recv' ||
      !meta.connected ||
      !Number.isInteger(bitrate) ||
      bitrate <= 0
    ) {
      throw new Error('Consumer transport not found');
    }

    await transport.setMaxOutgoingBitrate(bitrate);
  }

  async produce(
    callId: string,
    userId: string,
    transportId: string,
    kind: MediaType,
    rtpParameters: Record<string, unknown>,
    requestId?: string,
  ): Promise<ProducedMediaResult> {
    const room = this.getRoomOrThrow(callId);
    const transport = room.transports.get(transportId);
    const meta = room.transportMeta.get(transportId);

    if (
      !transport ||
      !meta ||
      meta.userId !== userId ||
      meta.callId !== callId ||
      meta.direction !== 'send' ||
      !meta.connected
    ) {
      throw new Error('Send transport is not connected');
    }

    const normalizedRequestId = requestId?.trim();
    if (normalizedRequestId) {
      const previousOperation = room.producerOperations.get(
        this.producerOperationKey(userId, kind, normalizedRequestId),
      );
      if (previousOperation) {
        return { producerId: previousOperation.producerId };
      }
    }

    const producerKey = this.producerUserKindKey(userId, kind);
    const creationKey = `${callId}:${producerKey}`;
    const pendingCreation = this.producerCreationPromises.get(creationKey);
    if (pendingCreation) {
      const pendingResult = await pendingCreation;
      if (normalizedRequestId) {
        const pendingOperation = room.producerOperations.get(
          this.producerOperationKey(userId, kind, normalizedRequestId),
        );
        if (pendingOperation?.producerId === pendingResult.producerId) {
          return pendingResult;
        }
      }
      throw new Error('Media producer already exists');
    }

    // Keep replacement and creation behind the same single-flight promise.
    // A rebuild can race the old transport's close callback; serializing the
    // close-before-create sequence prevents two producers for one participant
    // and media kind even in that window.
    const creation = this.createProducerAfterReplacement(
      room,
      callId,
      userId,
      transportId,
      kind,
      rtpParameters,
      normalizedRequestId,
    );
    this.producerCreationPromises.set(creationKey, creation);
    try {
      return await creation;
    } finally {
      if (this.producerCreationPromises.get(creationKey) === creation) {
        this.producerCreationPromises.delete(creationKey);
      }
    }
  }

  private async createProducerAfterReplacement(
    room: RoomRuntimeState,
    callId: string,
    userId: string,
    transportId: string,
    kind: MediaType,
    rtpParameters: Record<string, unknown>,
    requestId?: string,
  ): Promise<ProducedMediaResult> {
    const producerKey = this.producerUserKindKey(userId, kind);
    const existingProducerId = room.producerByUserKind.get(producerKey);
    let replacedProducerId: string | undefined;
    let replacedProducerOperations: Array<
      [
        string,
        {
          producerId: string;
          transportId: string;
          userId: string;
          kind: MediaType;
        },
      ]
    > = [];

    if (existingProducerId && room.producers.has(existingProducerId)) {
      const existingMeta = room.producerMeta.get(existingProducerId);
      if (existingMeta?.transportId === transportId) {
        throw new Error('Media producer already exists');
      }

      // A new send transport indicates a controlled media rebuild. Close the
      // producer on the old transport before creating its replacement.
      replacedProducerOperations = [
        ...room.producerOperations.entries(),
      ].filter(([, operation]) => operation.producerId === existingProducerId);
      await this.closeProducer(callId, userId, existingProducerId);
      replacedProducerId = existingProducerId;
    }

    const result = await this.createProducer(
      room,
      callId,
      userId,
      transportId,
      kind,
      rtpParameters,
      requestId,
    );
    // Keep request-id idempotency stable across a controlled replacement. A
    // lost ACK from the old transport may arrive after the rebuild; replaying
    // that request must resolve to the replacement rather than creating a
    // second producer for the same participant/kind.
    for (const [operationKey, operation] of replacedProducerOperations) {
      room.producerOperations.set(operationKey, {
        ...operation,
        producerId: result.producerId,
        transportId,
      });
    }
    return replacedProducerId ? { ...result, replacedProducerId } : result;
  }

  private async createProducer(
    room: RoomRuntimeState,
    callId: string,
    userId: string,
    transportId: string,
    kind: MediaType,
    rtpParameters: Record<string, unknown>,
    requestId?: string,
  ): Promise<ProducedMediaResult> {
    const transport = room.transports.get(transportId);
    if (!transport) throw new Error('Send transport is not connected');

    const producer = await transport.produce({
      kind,
      rtpParameters: rtpParameters as mediasoup.types.RtpParameters,
      appData: {
        callId,
        userId,
      },
    });

    // A terminal transition may have removed the room while mediasoup was
    // still allocating the producer. Do not publish or persist media that no
    // longer belongs to a live call.
    if (this.rooms.get(callId) !== room) {
      producer.close();
      throw new Error('Call room not found');
    }

    room.producers.set(producer.id, producer);
    room.producerMeta.set(producer.id, {
      callId,
      userId,
      transportId,
      kind,
    });
    room.producerByUserKind.set(
      this.producerUserKindKey(userId, kind),
      producer.id,
    );
    if (requestId) {
      room.producerOperations.set(
        this.producerOperationKey(userId, kind, requestId),
        { producerId: producer.id, transportId, userId, kind },
      );
    }

    producer.on('transportclose', () => {
      room.producers.delete(producer.id);
      room.producerMeta.delete(producer.id);
      const producerKey = this.producerUserKindKey(userId, kind);
      if (room.producerByUserKind.get(producerKey) === producer.id) {
        room.producerByUserKind.delete(producerKey);
      }
      for (const [operationKey, operation] of room.producerOperations) {
        if (operation.producerId === producer.id) {
          room.producerOperations.delete(operationKey);
        }
      }
      void this.stateRepository
        .removeProducerState(callId, userId, producer.id)
        .catch((error: unknown) => {
          this.logger.warn(
            `Failed to remove producer state after transport close producer=${shortCallIdentifier(producer.id)} errorCode=${safeCallErrorCode(error)}`,
          );
        });
    });

    try {
      await this.stateRepository.saveProducerState({
        producerId: producer.id,
        transportId,
        callId,
        userId,
        kind,
      });
      if (this.rooms.get(callId) !== room || producer.closed) {
        throw new Error('Call room not found');
      }
    } catch (error) {
      // Do not leave a live mediasoup producer behind when the durable
      // producer index cannot be written. The caller will receive the
      // persistence error and may retry with the same request id; the retry
      // must start from a clean one-producer invariant.
      room.producers.delete(producer.id);
      room.producerMeta.delete(producer.id);
      const producerKey = this.producerUserKindKey(userId, kind);
      if (room.producerByUserKind.get(producerKey) === producer.id) {
        room.producerByUserKind.delete(producerKey);
      }
      for (const [operationKey, operation] of room.producerOperations) {
        if (operation.producerId === producer.id) {
          room.producerOperations.delete(operationKey);
        }
      }
      try {
        producer.close();
      } catch {
        // Best-effort mediasoup cleanup; preserve the persistence error.
      }
      await this.stateRepository
        .removeProducerState(callId, userId, producer.id)
        .catch(() => undefined);
      throw error;
    }

    return { producerId: producer.id };
  }

  private producerUserKindKey(userId: string, kind: MediaType): string {
    return `${userId}:${kind}`;
  }

  private producerOperationKey(
    userId: string,
    kind: MediaType,
    requestId: string,
  ): string {
    return `${userId}:${kind}:${requestId}`;
  }

  async consume(
    callId: string,
    userId: string,
    transportId: string,
    producerId: string,
    rtpCapabilities: Record<string, unknown>,
  ): Promise<ConsumedMediaResult> {
    const creationKey = this.consumerCreationKey(callId, userId, producerId);
    const previousCreation = this.consumerCreationPromises.get(creationKey);
    const waitForPrevious = previousCreation
      ? previousCreation.then(
          () => undefined,
          () => undefined,
        )
      : Promise.resolve();

    const creation = waitForPrevious.then(() =>
      this.createConsumerAfterPrevious(
        callId,
        userId,
        transportId,
        producerId,
        rtpCapabilities,
      ),
    );
    this.consumerCreationPromises.set(creationKey, creation);

    try {
      return await creation;
    } finally {
      if (this.consumerCreationPromises.get(creationKey) === creation) {
        this.consumerCreationPromises.delete(creationKey);
      }
    }
  }

  private async createConsumerAfterPrevious(
    callId: string,
    userId: string,
    transportId: string,
    producerId: string,
    rtpCapabilities: Record<string, unknown>,
  ): Promise<ConsumedMediaResult> {
    // Re-resolve every runtime object after waiting for the previous consume.
    // A terminal transition or transport rebuild may have removed the room or
    // replaced the receive transport while this request was queued.
    const room = this.getRoomOrThrow(callId);
    const producer = room.producers.get(producerId);
    const transport = room.transports.get(transportId);
    const transportMeta = room.transportMeta.get(transportId);

    if (!producer) {
      throw new Error('Producer not found');
    }

    if (
      !transport ||
      !transportMeta ||
      transportMeta.userId !== userId ||
      transportMeta.direction !== 'recv'
    ) {
      throw new Error('Receive transport is unavailable');
    }

    const canConsume = room.router.canConsume({
      producerId,
      rtpCapabilities: rtpCapabilities,
    });

    if (!canConsume) {
      throw new Error('Cannot consume producer with provided RTP capabilities');
    }

    const consumer = await transport.consume({
      producerId,
      rtpCapabilities: rtpCapabilities,
      paused: true,
      appData: {
        callId,
        userId,
      },
    });

    // Terminal cleanup can race an in-flight mediasoup allocation. Never
    // resurrect a Consumer after the room that authorized it was removed.
    if (this.rooms.get(callId) !== room) {
      consumer.close();
      throw new Error('Call room not found');
    }

    // The previous consume for this receiver+producer has fully settled before
    // this point. Replacing stale runtime state is therefore ordered: an older
    // request can no longer overtake this one and close its Consumer later.
    for (const [consumerId, meta] of room.consumerMeta) {
      if (meta.userId !== userId || meta.producerId !== producerId) continue;
      this.closeRuntimeConsumer(room, consumerId);
    }

    room.consumers.set(consumer.id, consumer);
    room.consumerMeta.set(consumer.id, {
      callId,
      userId,
      transportId,
      producerId,
    });

    consumer.on('transportclose', () => {
      this.forgetRuntimeConsumer(room, consumer.id);
    });

    consumer.on('producerclose', () => {
      this.forgetRuntimeConsumer(room, consumer.id);
      consumer.close();
    });

    return {
      consumerId: consumer.id,
      producerId,
      kind: producer.kind,
      rtpParameters: consumer.rtpParameters,
    };
  }

  private consumerCreationKey(
    callId: string,
    userId: string,
    producerId: string,
  ): string {
    return `${callId}:${userId}:${producerId}`;
  }

  async resumeConsumer(
    callId: string,
    userId: string,
    consumerId: string,
  ): Promise<void> {
    const room = this.getRoomOrThrow(callId);
    const consumer = room.consumers.get(consumerId);
    const meta = room.consumerMeta.get(consumerId);

    if (
      !consumer ||
      !meta ||
      meta.userId !== userId ||
      meta.callId !== callId
    ) {
      throw new Error('Consumer not found');
    }

    await consumer.resume();
  }

  closeConsumer(
    callId: string,
    userId: string,
    consumerId: string,
  ): Promise<ClosedMediaConsumerResult> {
    const room = this.rooms.get(callId);
    if (!room) {
      return Promise.resolve({ closed: false });
    }

    const consumer = room.consumers.get(consumerId);
    const meta = room.consumerMeta.get(consumerId);
    if (!consumer || !meta) {
      this.forgetRuntimeConsumer(room, consumerId);
      return Promise.resolve({ closed: false });
    }
    if (meta.callId !== callId || meta.userId !== userId) {
      return Promise.reject(new Error('Consumer not found'));
    }

    this.closeRuntimeConsumer(room, consumerId);
    return Promise.resolve({ closed: true });
  }

  private forgetRuntimeConsumer(
    room: RoomRuntimeState,
    consumerId: string,
  ): void {
    room.consumers.delete(consumerId);
    room.consumerMeta.delete(consumerId);
  }

  private closeRuntimeConsumer(
    room: RoomRuntimeState,
    consumerId: string,
  ): boolean {
    const consumer = room.consumers.get(consumerId);
    this.forgetRuntimeConsumer(room, consumerId);
    if (!consumer) return false;

    try {
      consumer.close();
    } catch {
      // A producer/transport close may have won the cleanup race.
    }
    return true;
  }

  listActiveProducers(
    callId: string,
    excludingUserId?: string,
  ): Promise<ActiveProducerResult[]> {
    const room = this.getRoomOrThrow(callId);

    return Promise.resolve(
      [...room.producerMeta.entries()]
        .filter(([producerId, meta]) => {
          if (excludingUserId && meta.userId === excludingUserId) {
            return false;
          }

          return room.producers.has(producerId);
        })
        .map(([producerId, meta]) => ({
          producerId,
          userId: meta.userId,
          kind: meta.kind,
          paused: room.producers.get(producerId)?.paused ?? false,
        })),
    );
  }

  async pauseProducer(
    callId: string,
    userId: string,
    producerId: string,
  ): Promise<void> {
    const room = this.getRoomOrThrow(callId);
    const producer = room.producers.get(producerId);
    const meta = room.producerMeta.get(producerId);

    if (
      !producer ||
      !meta ||
      meta.callId !== callId ||
      meta.userId !== userId
    ) {
      throw new Error('Producer not found');
    }

    await producer.pause();
  }

  async resumeProducer(
    callId: string,
    userId: string,
    producerId: string,
  ): Promise<void> {
    const room = this.getRoomOrThrow(callId);
    const producer = room.producers.get(producerId);
    const meta = room.producerMeta.get(producerId);

    if (
      !producer ||
      !meta ||
      meta.callId !== callId ||
      meta.userId !== userId
    ) {
      throw new Error('Producer not found');
    }

    await producer.resume();
  }

  async closeProducer(
    callId: string,
    userId: string,
    producerId: string,
  ): Promise<{ closed: boolean; kind?: MediaType }> {
    const room = this.getRoomOrThrow(callId);
    const producer = room.producers.get(producerId);
    const meta = room.producerMeta.get(producerId);

    if (!producer || !meta || meta.callId !== callId) {
      // Explicit client cleanup is intentionally idempotent. A transport
      // close or a concurrent terminal transition may already have removed
      // the producer by the time the cleanup command reaches the gateway.
      return { closed: false };
    }
    if (meta.userId !== userId) {
      throw new Error('Producer not found');
    }

    producer.close();
    room.producers.delete(producerId);
    room.producerMeta.delete(producerId);
    const producerKey = this.producerUserKindKey(userId, meta.kind);
    if (room.producerByUserKind.get(producerKey) === producerId) {
      room.producerByUserKind.delete(producerKey);
    }
    for (const [operationKey, operation] of room.producerOperations) {
      if (operation.producerId === producerId) {
        room.producerOperations.delete(operationKey);
      }
    }
    await this.stateRepository.removeProducerState(callId, userId, producerId);
    return { closed: true, kind: meta.kind };
  }

  async closeParticipant(
    callId: string,
    userId: string,
  ): Promise<ClosedParticipantMediaResult> {
    const room = this.getRoomOrThrow(callId);
    const producers = [...room.producerMeta.entries()]
      .filter(([, meta]) => meta.userId === userId)
      .map(([producerId, meta]) => ({ producerId, kind: meta.kind }));

    try {
      for (const producer of producers) {
        try {
          await this.closeProducer(callId, userId, producer.producerId);
        } catch (error) {
          this.logger.warn(
            `Failed to persist participant producer cleanup call=${shortCallIdentifier(callId)} errorCode=${safeCallErrorCode(error)}`,
          );
        }
      }
    } finally {
      // A Redis cleanup failure must never keep this guest's media alive.
      const transports = [...room.transportMeta.entries()].filter(
        ([, meta]) => meta.userId === userId,
      );
      for (const [transportId] of transports) {
        try {
          room.transports.get(transportId)?.close();
        } catch (error) {
          this.logger.warn(
            `Failed to close participant transport call=${shortCallIdentifier(callId)} errorCode=${safeCallErrorCode(error)}`,
          );
        }
      }
      for (const [consumerId, meta] of [...room.consumerMeta.entries()]) {
        if (meta.userId !== userId) continue;
        try {
          room.consumers.get(consumerId)?.close();
        } catch (error) {
          this.logger.warn(
            `Failed to close participant consumer call=${shortCallIdentifier(callId)} errorCode=${safeCallErrorCode(error)}`,
          );
        }
      }
      const cleanupResults = await Promise.allSettled(
        transports.map(([transportId, meta]) =>
          this.stateRepository.removeTransportState(
            callId,
            userId,
            meta.direction,
            transportId,
          ),
        ),
      );
      if (cleanupResults.some((result) => result.status === 'rejected')) {
        this.logger.warn(
          `Failed to persist participant transport cleanup call=${shortCallIdentifier(callId)}`,
        );
      }
    }

    return { producers };
  }

  closeRoom(callId: string): Promise<void> {
    return this.closeRoomAfterPendingCreation(callId);
  }

  private async closeRoomAfterPendingCreation(callId: string): Promise<void> {
    // A terminal transition may win while a router is still being allocated.
    // Waiting for the in-flight creation keeps that router from materializing
    // after terminal cleanup has already returned.
    const creation = this.roomCreationPromises.get(callId);
    if (creation) {
      try {
        await creation;
      } catch {
        // Failed room creation leaves nothing to close.
      }
    }

    const room = this.rooms.get(callId);
    if (room) {
      for (const resource of [
        ...room.consumers.values(),
        ...room.producers.values(),
        ...room.transports.values(),
        room.router,
      ]) {
        try {
          resource.close();
        } catch (error) {
          this.logger.warn(
            `Failed to close terminal media call=${shortCallIdentifier(callId)} errorCode=${safeCallErrorCode(error)}`,
          );
        }
      }
      this.rooms.delete(callId);
    }
    // Terminal use cases may start their Redis cleanup while room creation is
    // still pending. Clear once more after that creation and media teardown.
    await this.stateRepository.clearCallState(callId);
  }

  private async bootstrapWorkers(count: number): Promise<void> {
    if (this.workers.length > 0) return;

    for (let index = 0; index < count; index += 1) {
      const worker = await mediasoup.createWorker({
        rtcMinPort: Number(process.env.MEDIASOUP_RTC_MIN_PORT || 40000),
        rtcMaxPort: Number(process.env.MEDIASOUP_RTC_MAX_PORT || 49999),
        logLevel: 'warn',
        logTags: ['info', 'ice', 'dtls', 'rtp', 'srtp', 'rtcp'],
      });

      worker.on('died', () => {
        this.logger.error(`Mediasoup worker died pid=${worker.pid}`);
        this.webRtcServers.get(worker)?.close();
        this.webRtcServers.delete(worker);
        this.workers.splice(this.workers.indexOf(worker), 1);
      });

      if (this.webRtcServerPort) {
        const webRtcServer = await worker.createWebRtcServer({
          listenInfos: [
            {
              protocol: 'udp',
              ip: process.env.MEDIASOUP_LISTEN_IP || '0.0.0.0',
              announcedAddress: process.env.MEDIASOUP_ANNOUNCED_IP || undefined,
              port: this.webRtcServerPort,
            },
          ],
        });
        this.webRtcServers.set(worker, webRtcServer);
      }

      this.workers.push(worker);
    }
  }

  private async getNextWorker(): Promise<mediasoup.types.Worker> {
    if (this.workers.length === 0) {
      await this.bootstrapWorkers(this.workerCount);
    }

    const worker = this.workers[this.workerCursor % this.workers.length];
    this.workerCursor = (this.workerCursor + 1) % this.workers.length;
    return worker;
  }

  private async createTransport(
    callId: string,
    userId: string,
    direction: 'send',
  ): Promise<CreateSendTransportResult>;
  private async createTransport(
    callId: string,
    userId: string,
    direction: 'recv',
  ): Promise<CreateRecvTransportResult>;
  private async createTransport(
    callId: string,
    userId: string,
    direction: TransportDirection,
  ): Promise<CreateSendTransportResult | CreateRecvTransportResult> {
    const room = this.getRoomOrThrow(callId);

    const webRtcServer = this.webRtcServers.get(room.worker);
    const transport = await room.router.createWebRtcTransport({
      ...(webRtcServer
        ? { webRtcServer }
        : {
            listenIps: [
              {
                ip: process.env.MEDIASOUP_LISTEN_IP || '0.0.0.0',
                announcedIp: process.env.MEDIASOUP_ANNOUNCED_IP || undefined,
              },
            ],
          }),
      enableUdp: true,
      enableTcp: false,
      initialAvailableOutgoingBitrate: 800000,
      appData: {
        callId,
        userId,
        direction,
      },
    });

    if (this.rooms.get(callId) !== room) {
      transport.close();
      throw new Error('Call room not found');
    }

    room.transports.set(transport.id, transport);
    room.transportMeta.set(transport.id, {
      callId,
      userId,
      direction,
      connected: false,
    });

    transport.on('dtlsstatechange', (state) => {
      if (state === 'closed') {
        transport.close();
      }
    });

    transport.observer.on('close', () => {
      room.transports.delete(transport.id);
      room.transportMeta.delete(transport.id);
    });

    await this.persistTransportStateOrClose(room, transport, {
      transportId: transport.id,
      callId,
      userId,
      direction,
      connected: false,
    });

    return {
      transportId: transport.id,
      direction,
      iceParameters: transport.iceParameters,
      iceCandidates: transport.iceCandidates,
      dtlsParameters: transport.dtlsParameters,
    };
  }

  private async persistTransportStateOrClose(
    room: RoomRuntimeState,
    transport: mediasoup.types.WebRtcTransport,
    state: StoredTransportState,
  ): Promise<void> {
    try {
      await this.stateRepository.saveTransportState(state);
      if (this.rooms.get(state.callId) !== room || transport.closed) {
        throw new Error('Call room not found');
      }
    } catch (error) {
      try {
        transport.close();
      } catch {
        // Keep the persistence failure as the caller-visible cause.
      }
      room.transports.delete(transport.id);
      room.transportMeta.delete(transport.id);
      try {
        await this.stateRepository.removeTransportState(
          state.callId,
          state.userId,
          state.direction,
          state.transportId,
        );
      } catch (cleanupError) {
        this.logger.warn(
          `Transport state cleanup failed call=${shortCallIdentifier(state.callId)} errorCode=${safeCallErrorCode(cleanupError)}`,
        );
      }
      throw error;
    }
  }

  private readOptionalPort(value: string | undefined): number | undefined {
    if (!value?.trim()) return undefined;

    const port = Number(value);
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      throw new Error(
        'MEDIASOUP_WEBRTC_SERVER_PORT must be an integer between 1 and 65535',
      );
    }
    return port;
  }

  private getRoomOrThrow(callId: string): RoomRuntimeState {
    const room = this.rooms.get(callId);
    if (!room) {
      throw new Error('Call room not found');
    }
    return room;
  }
}
