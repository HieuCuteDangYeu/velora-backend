export type CreateTransportPayload = {
  callId: string;
  direction: 'send' | 'recv';
};

export type ConnectTransportPayload = {
  callId: string;
  transportId: string;
  dtlsParameters: Record<string, unknown>;
};

export type ProducePayload = {
  callId: string;
  transportId: string;
  kind: 'audio' | 'video';
  rtpParameters: Record<string, unknown>;
  requestId?: string;
  audioEnabled?: boolean;
};

export type CloseProducerPayload = {
  callId: string;
  producerId: string;
  kind: 'audio' | 'video';
  requestId?: string;
};

export type ConsumePayload = {
  callId: string;
  transportId: string;
  producerId: string;
  rtpCapabilities: Record<string, unknown>;
  requestId?: string;
};

export type ResumeConsumerPayload = {
  callId: string;
  consumerId: string;
};

export type CloseConsumerPayload = {
  callId: string;
  consumerId: string;
  requestId?: string;
};

export type RestartIcePayload = {
  callId: string;
  transportId: string;
};
