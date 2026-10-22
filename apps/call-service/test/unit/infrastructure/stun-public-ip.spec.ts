import { createSocket, type Socket } from 'node:dgram';
import {
  createBindingRequest,
  parseStunServers,
  queryStunPublicIpv4,
  readBindingResponseIpv4,
} from '../../../src/infrastructure/engines/stun-public-ip';

const MAGIC_COOKIE = Buffer.from([0x21, 0x12, 0xa4, 0x42]);

const attribute = (type: number, value: Buffer) => {
  const header = Buffer.alloc(4);
  header.writeUInt16BE(type, 0);
  header.writeUInt16BE(value.length, 2);
  const padding = Buffer.alloc((4 - (value.length % 4)) % 4);
  return Buffer.concat([header, value, padding]);
};

const ipv4Value = (address: string, port: number, xor: boolean) => {
  const value = Buffer.alloc(8);
  value[1] = 0x01;
  value.writeUInt16BE(xor ? port ^ 0x2112 : port, 2);
  address.split('.').forEach((part, index) => {
    value[4 + index] = Number(part) ^ (xor ? MAGIC_COOKIE[index] : 0);
  });
  return value;
};

const xorMapped = (address: string) =>
  attribute(0x0020, ipv4Value(address, 40000, true));
const mapped = (address: string) =>
  attribute(0x0001, ipv4Value(address, 40000, false));

const response = (
  transactionId: Buffer,
  attributes: Buffer[],
  type = 0x0101,
) => {
  const body = Buffer.concat(attributes);
  const header = Buffer.alloc(20);
  header.writeUInt16BE(type, 0);
  header.writeUInt16BE(body.length, 2);
  MAGIC_COOKIE.copy(header, 4);
  transactionId.copy(header, 8);
  return Buffer.concat([header, body]);
};

const transactionId = Buffer.from('0123456789ab');

describe('STUN server configuration', () => {
  it('reads host:port entries with an optional stun: prefix', () => {
    expect(
      parseStunServers(
        'stun.relay.metered.ca:80, stun:stun.cloudflare.com:3478,stun.example.com',
      ),
    ).toEqual([
      { host: 'stun.relay.metered.ca', port: 80 },
      { host: 'stun.cloudflare.com', port: 3478 },
      { host: 'stun.example.com', port: 3478 },
    ]);
  });

  it.each([
    '',
    ' , ',
    'stun.example.com:0',
    'stun.example.com:70000',
    'turn:relay.example.com:80',
    'http://stun.example.com',
  ])('rejects %p', (value) => {
    expect(() => parseStunServers(value)).toThrow(
      'MEDIASOUP_PUBLIC_IP_STUN_SERVERS must contain host:port STUN servers',
    );
  });
});

describe('STUN Binding messages', () => {
  it('encodes a credential-free Binding request', () => {
    const request = createBindingRequest(transactionId);

    expect(request).toHaveLength(20);
    expect(request.readUInt16BE(0)).toBe(0x0001);
    expect(request.readUInt16BE(2)).toBe(0);
    expect(request.subarray(4, 8)).toEqual(MAGIC_COOKIE);
    expect(request.subarray(8)).toEqual(transactionId);
  });

  it('reads XOR-MAPPED-ADDRESS after a padded attribute', () => {
    const software = attribute(0x8022, Buffer.from('relay'));

    expect(
      readBindingResponseIpv4(
        response(transactionId, [software, xorMapped('203.0.113.7')]),
        transactionId,
      ),
    ).toBe('203.0.113.7');
  });

  it('prefers XOR-MAPPED-ADDRESS and falls back to MAPPED-ADDRESS', () => {
    expect(
      readBindingResponseIpv4(
        response(transactionId, [
          mapped('198.51.100.1'),
          xorMapped('203.0.113.7'),
        ]),
        transactionId,
      ),
    ).toBe('203.0.113.7');
    expect(
      readBindingResponseIpv4(
        response(transactionId, [mapped('198.51.100.1')]),
        transactionId,
      ),
    ).toBe('198.51.100.1');
  });

  it('ignores IPv6 mapped addresses', () => {
    const ipv6 = Buffer.alloc(20);
    ipv6[1] = 0x02;

    expect(
      readBindingResponseIpv4(
        response(transactionId, [attribute(0x0020, ipv6)]),
        transactionId,
      ),
    ).toBeUndefined();
  });

  it.each([
    [
      'another transaction',
      response(Buffer.from('ba9876543210'), [xorMapped('203.0.113.7')]),
    ],
    [
      'an error response',
      response(transactionId, [xorMapped('203.0.113.7')], 0x0111),
    ],
    ['a short packet', Buffer.alloc(12)],
    [
      'a truncated attribute',
      response(transactionId, [xorMapped('203.0.113.7')]).subarray(0, 28),
    ],
  ])('ignores %s', (_case, message) => {
    expect(readBindingResponseIpv4(message, transactionId)).toBeUndefined();
  });
});

describe('STUN public IPv4 query', () => {
  let server: Socket;
  let port: number;

  beforeEach(async () => {
    server = createSocket('udp4');
    await new Promise<void>((resolve) => server.bind(0, '127.0.0.1', resolve));
    port = server.address().port;
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it('returns the address from the matching reply and skips stray packets', async () => {
    server.on('message', (request, remote) => {
      const id = request.subarray(8, 20);
      server.send(
        response(Buffer.from('ba9876543210'), [xorMapped('198.51.100.1')]),
        remote.port,
        remote.address,
      );
      server.send(
        response(id, [xorMapped('203.0.113.7')]),
        remote.port,
        remote.address,
      );
    });

    await expect(
      queryStunPublicIpv4({ host: '127.0.0.1', port }, 2000),
    ).resolves.toBe('203.0.113.7');
  });

  it('times out when the server does not answer', async () => {
    await expect(
      queryStunPublicIpv4({ host: '127.0.0.1', port }, 50),
    ).rejects.toThrow('STUN binding timed out');
  });
});
