import { randomBytes } from 'node:crypto';
import { createSocket } from 'node:dgram';

// RFC 5389 Binding request: the reply carries the public address the request
// arrived from. It needs no credentials, and none are ever sent.
const BINDING_REQUEST = 0x0001;
const BINDING_SUCCESS_RESPONSE = 0x0101;
const MAGIC_COOKIE = 0x2112a442;
const HEADER_LENGTH = 20;
const MAPPED_ADDRESS = 0x0001;
const XOR_MAPPED_ADDRESS = 0x0020;
const IPV4_FAMILY = 0x01;
const DEFAULT_STUN_PORT = 3478;

// The Metered TURN hosts in TURN_URLS do not answer unauthenticated Binding
// requests; Metered's STUN host does. The others are independent fallbacks.
export const DEFAULT_PUBLIC_IP_STUN_SERVERS =
  'stun.relay.metered.ca:80,stun.cloudflare.com:3478,stun.l.google.com:19302';

export type StunServer = { host: string; port: number };

export const parseStunServers = (raw: string): StunServer[] => {
  const servers = raw
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map((entry) => {
      const match = entry.match(/^(?:stun:)?([a-z0-9.-]+)(?::([0-9]+))?$/i);
      const port = match?.[2] ? Number(match[2]) : DEFAULT_STUN_PORT;
      if (!match || !(port >= 1 && port <= 65535)) {
        throw new Error(
          'MEDIASOUP_PUBLIC_IP_STUN_SERVERS must contain host:port STUN servers',
        );
      }
      return { host: match[1], port };
    });

  if (servers.length === 0) {
    throw new Error(
      'MEDIASOUP_PUBLIC_IP_STUN_SERVERS must contain host:port STUN servers',
    );
  }
  return servers;
};

export const createBindingRequest = (transactionId: Buffer): Buffer => {
  const request = Buffer.alloc(HEADER_LENGTH);
  request.writeUInt16BE(BINDING_REQUEST, 0);
  request.writeUInt16BE(0, 2);
  request.writeUInt32BE(MAGIC_COOKIE, 4);
  transactionId.copy(request, 8);
  return request;
};

/**
 * Returns the IPv4 address a Binding success response reports, or undefined
 * for any other packet, including replies to a different transaction.
 */
export const readBindingResponseIpv4 = (
  message: Buffer,
  transactionId: Buffer,
): string | undefined => {
  if (
    message.length < HEADER_LENGTH ||
    message.readUInt16BE(0) !== BINDING_SUCCESS_RESPONSE ||
    message.readUInt32BE(4) !== MAGIC_COOKIE ||
    !message.subarray(8, HEADER_LENGTH).equals(transactionId)
  ) {
    return undefined;
  }

  const end = Math.min(message.length, HEADER_LENGTH + message.readUInt16BE(2));
  let mappedAddress: string | undefined;
  let offset = HEADER_LENGTH;
  while (offset + 4 <= end) {
    const type = message.readUInt16BE(offset);
    const length = message.readUInt16BE(offset + 2);
    const value = offset + 4;
    if (value + length > end) return undefined;

    if (length >= 8 && message[value + 1] === IPV4_FAMILY) {
      const address = message.subarray(value + 4, value + 8);
      if (type === XOR_MAPPED_ADDRESS) {
        // XOR-MAPPED-ADDRESS hides the address from NATs that rewrite it.
        return [...address]
          .map((byte, index) => byte ^ message[4 + index])
          .join('.');
      }
      if (type === MAPPED_ADDRESS) mappedAddress = [...address].join('.');
    }
    // Attributes are padded to a multiple of four bytes.
    offset = value + length + ((4 - (length % 4)) % 4);
  }
  return mappedAddress;
};

export const queryStunPublicIpv4 = (
  server: StunServer,
  timeoutMs: number,
): Promise<string> =>
  new Promise((resolve, reject) => {
    const socket = createSocket('udp4');
    const transactionId = randomBytes(12);
    let settled = false;
    const finish = (error: Error | undefined, address?: string) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.close();
      if (error || !address) reject(error ?? new Error('STUN binding failed'));
      else resolve(address);
    };
    const timer = setTimeout(
      () => finish(new Error('STUN binding timed out')),
      timeoutMs,
    );

    socket.on('message', (message) => {
      const address = readBindingResponseIpv4(message, transactionId);
      if (address) finish(undefined, address);
    });
    socket.on('error', (error) => finish(error));
    socket.send(createBindingRequest(transactionId), server.port, server.host);
  });
