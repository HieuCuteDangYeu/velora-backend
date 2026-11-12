import { randomUUID } from 'node:crypto';

function positiveInteger(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function nonNegativeInteger(
  value: string | undefined,
  fallback: number,
): number {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : fallback;
}

/** Who this media node is and how signaling reaches it. */
export class MediaNodeIdentity {
  readonly nodeId =
    process.env.MEDIA_NODE_ID?.trim() || process.env.HOSTNAME || 'call-media';
  readonly incarnation = randomUUID();
  /** Hostname signaling replicas dial; the compose service name by default. */
  readonly rpcHost = process.env.CALL_MEDIA_RPC_HOST?.trim() || this.nodeId;
  readonly rpcPort = positiveInteger(process.env.CALL_MEDIA_RPC_PORT, 4100);
  readonly httpPort = positiveInteger(process.env.CALL_MEDIA_HTTP_PORT, 3019);
  /** Lower is preferred; a remote node uses a higher number than the home one. */
  readonly priority = nonNegativeInteger(
    process.env.CALL_MEDIA_NODE_PRIORITY,
    0,
  );
  /** Rooms before new calls spill over to the next priority; 0 means no limit. */
  readonly maxRooms = nonNegativeInteger(
    process.env.CALL_MEDIA_NODE_MAX_ROOMS,
    0,
  );
  readonly heartbeatTtlMs = positiveInteger(
    process.env.CALL_MEDIA_HEARTBEAT_TTL_MS,
    15_000,
  );
}
