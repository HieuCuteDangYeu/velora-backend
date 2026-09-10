import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import * as mediasoup from 'mediasoup';
import type {
  ActiveProducerResult,
  ConsumedMediaResult,
  CreateRecvTransportResult,
  CreateSendTransportResult,
  ICallMediaEngine,
  ProducedMediaResult,
  RestartIceResult,
  RouterRtpCapabilitiesResult,
} from '../../domain/interfaces/call-media.engine.interface';
import { RedisCallStateRepository } from '../repositories/redis-call-state.repository';
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
  private readonly workers: mediasoup.types.Worker[] = [];
  private workerCursor = 0;
  private readonly workerCount = Math.max(
    1,
    Number(process.env.MEDIASOUP_WORKERS || 1),
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

    await this.bootstrapWorkers(this.workerCount);
  }

  onModuleDestroy(): Promise<void> {
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

    this.rooms.set(callId, {
      callId,
      worker,
      router,
      transports: new Map(),
      transportMeta: new Map(),
      producers: new Map(),
      producerMeta: new Map(),
      consumers: new Map(),
      consumerMeta: new Map(),
    });

    await this.stateRepository.saveRoom({
      callId,
      workerId: String(worker.pid),
      routerId: router.id,
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

    room.transportMeta.set(transportId, { ...meta, connected: true });
    await this.stateRepository.saveTransportState({
      transportId,
      callId,
      userId,
      direction: meta.direction,
      connected: true,
    });
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

    const producer = await transport.produce({
      kind,
      rtpParameters: rtpParameters as mediasoup.types.RtpParameters,
      appData: {
        callId,
        userId,
      },
    });

    room.producers.set(producer.id, producer);
    room.producerMeta.set(producer.id, {
      callId,
      userId,
      transportId,
      kind,
    });

    producer.on('transportclose', () => {
      room.producers.delete(producer.id);
      room.producerMeta.delete(producer.id);
      void this.stateRepository
        .removeProducerState(callId, userId, producer.id)
        .catch((error: unknown) => {
          this.logger.warn(
            `Failed to remove producer state after transport close producer=${producer.id}: ${
              error instanceof Error ? error.message : String(error)
            }`,
          );
        });
    });

    await this.stateRepository.saveProducerState({
      producerId: producer.id,
      transportId,
      callId,
      userId,
      kind,
    });

    return { producerId: producer.id };
  }

  async consume(
    callId: string,
    userId: string,
    transportId: string,
    producerId: string,
    rtpCapabilities: Record<string, unknown>,
  ): Promise<ConsumedMediaResult> {
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

    room.consumers.set(consumer.id, consumer);
    room.consumerMeta.set(consumer.id, {
      callId,
      userId,
      transportId,
      producerId,
    });

    consumer.on('transportclose', () => {
      room.consumers.delete(consumer.id);
      room.consumerMeta.delete(consumer.id);
    });

    consumer.on('producerclose', () => {
      room.consumers.delete(consumer.id);
      room.consumerMeta.delete(consumer.id);
      consumer.close();
    });

    return {
      consumerId: consumer.id,
      producerId,
      kind: producer.kind,
      rtpParameters: consumer.rtpParameters,
    };
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

    producer.close();
    room.producers.delete(producerId);
    room.producerMeta.delete(producerId);
    await this.stateRepository.removeProducerState(callId, userId, producerId);
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
    if (!room) return;

    room.consumers.forEach((consumer) => consumer.close());
    room.producers.forEach((producer) => producer.close());
    room.transports.forEach((transport) => transport.close());
    room.router.close();
    this.rooms.delete(callId);
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
        this.workers.splice(this.workers.indexOf(worker), 1);
      });

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

    const transport = await room.router.createWebRtcTransport({
      listenIps: [
        {
          ip: process.env.MEDIASOUP_LISTEN_IP || '0.0.0.0',
          announcedIp: process.env.MEDIASOUP_ANNOUNCED_IP || undefined,
        },
      ],
      enableUdp: true,
      enableTcp: false,
      initialAvailableOutgoingBitrate: 800000,
      appData: {
        callId,
        userId,
        direction,
      },
    });

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

    await this.stateRepository.saveTransportState({
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

  private getRoomOrThrow(callId: string): RoomRuntimeState {
    const room = this.rooms.get(callId);
    if (!room) {
      throw new Error('Call room not found');
    }
    return room;
  }
}
