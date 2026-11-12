/**
 * RPC contract between signaling replicas (call-service, remote media mode)
 * and media nodes. Both sides ship in the same image, so the contract only
 * has to stay compatible across one rolling deploy.
 */
export const MEDIA_NODE_INVOKE_PATTERN = 'call.media.invoke';
export const MEDIA_ROOMS_LOST_EVENT = 'call.media_rooms_lost';

/** ICallMediaEngine methods a media node serves, all keyed by callId. */
export const REMOTE_MEDIA_METHODS = [
  'createRoom',
  'getRouterRtpCapabilities',
  'createSendTransport',
  'createRecvTransport',
  'connectTransport',
  'restartIce',
  'setConsumerMaxBitrate',
  'produce',
  'consume',
  'resumeConsumer',
  'closeConsumer',
  'listActiveProducers',
  'pauseProducer',
  'resumeProducer',
  'closeProducer',
  'closeParticipant',
  'closeRoom',
] as const;

export type RemoteMediaMethod = (typeof REMOTE_MEDIA_METHODS)[number];

export function isRemoteMediaMethod(
  value: unknown,
): value is RemoteMediaMethod {
  return (
    typeof value === 'string' &&
    (REMOTE_MEDIA_METHODS as readonly string[]).includes(value)
  );
}

export interface MediaNodeInvokeRequest {
  method: RemoteMediaMethod;
  args: unknown[];
  /** The node incarnation the caller placed this call on. */
  incarnation: string;
}

/** Error body a media node returns; the caller rethrows it as an Error. */
export interface MediaNodeRpcErrorBody {
  message: string;
  code?: string;
}

export const MEDIA_NODE_STALE_INCARNATION = 'media_node_stale_incarnation';

/** Heartbeat record at `call:media-node:{nodeId}` (expires when the node dies). */
export interface MediaNodeRecord {
  nodeId: string;
  /** New on every process start: rooms of an older incarnation are gone. */
  incarnation: string;
  rpcHost: string;
  rpcPort: number;
  rooms: number;
  updatedAtMs: number;
  /**
   * Placement preference, lower is preferred; missing means 0. A node only
   * takes new calls once every more preferred node is full or gone.
   */
  priority?: number;
  /** Rooms this node takes before new calls spill over; 0 or missing = no limit. */
  maxRooms?: number;
}

export interface MediaRoomsLostEvent {
  nodeId: string;
  incarnation: string;
  callIds: string[];
}

export const MEDIA_NODES_KEY = 'call:media-nodes';
export const mediaNodeKey = (nodeId: string) => `call:media-node:${nodeId}`;
export const mediaNodeCallsKey = (nodeId: string) =>
  `call:media-node:${nodeId}:calls`;
export const callMediaPlacementKey = (callId: string) =>
  `call:${callId}:media-node`;
