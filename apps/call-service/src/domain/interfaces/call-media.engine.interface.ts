export interface CreateSendTransportResult {
  transportId: string;
  direction: 'send';
  iceParameters: Record<string, unknown>;
  iceCandidates: unknown[];
  dtlsParameters: Record<string, unknown>;
}

export interface CreateRecvTransportResult {
  transportId: string;
  direction: 'recv';
  iceParameters: Record<string, unknown>;
  iceCandidates: unknown[];
  dtlsParameters: Record<string, unknown>;
}

export interface ProducedMediaResult {
  producerId: string;
}

export interface ActiveProducerResult {
  producerId: string;
  userId: string;
  kind: 'audio' | 'video';
  paused?: boolean;
  revision?: number;
}

export interface ConsumedMediaResult {
  consumerId: string;
  producerId: string;
  kind: 'audio' | 'video';
  rtpParameters: Record<string, unknown>;
}

export interface RouterRtpCapabilitiesResult {
  codecs: unknown[];
  headerExtensions: unknown[];
}

export interface RestartIceResult {
  iceParameters: Record<string, unknown>;
}

export abstract class ICallMediaEngine {
  abstract createRoom(callId: string): Promise<void>;
  abstract getRouterRtpCapabilities(
    callId: string,
  ): Promise<RouterRtpCapabilitiesResult>;
  abstract createSendTransport(
    callId: string,
    userId: string,
  ): Promise<CreateSendTransportResult>;
  abstract createRecvTransport(
    callId: string,
    userId: string,
  ): Promise<CreateRecvTransportResult>;
  abstract connectTransport(
    callId: string,
    userId: string,
    transportId: string,
    dtlsParameters: Record<string, unknown>,
  ): Promise<void>;
  abstract restartIce(
    callId: string,
    userId: string,
    transportId: string,
  ): Promise<RestartIceResult>;
  abstract setConsumerMaxBitrate(
    callId: string,
    userId: string,
    transportId: string,
    bitrate: number,
  ): Promise<void>;
  abstract produce(
    callId: string,
    userId: string,
    transportId: string,
    kind: 'audio' | 'video',
    rtpParameters: Record<string, unknown>,
    requestId?: string,
  ): Promise<ProducedMediaResult>;
  abstract consume(
    callId: string,
    userId: string,
    transportId: string,
    producerId: string,
    rtpCapabilities: Record<string, unknown>,
  ): Promise<ConsumedMediaResult>;
  abstract resumeConsumer(
    callId: string,
    userId: string,
    consumerId: string,
  ): Promise<void>;
  abstract listActiveProducers(
    callId: string,
    excludingUserId?: string,
  ): Promise<ActiveProducerResult[]>;
  abstract pauseProducer(
    callId: string,
    userId: string,
    producerId: string,
  ): Promise<void>;
  abstract resumeProducer(
    callId: string,
    userId: string,
    producerId: string,
  ): Promise<void>;
  abstract closeProducer(
    callId: string,
    userId: string,
    producerId: string,
  ): Promise<void>;
  abstract closeRoom(callId: string): Promise<void>;
}
