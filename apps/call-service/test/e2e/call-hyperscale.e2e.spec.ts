/**
 * Remote media mode end to end: two signaling replicas share one real Redis
 * (Socket.IO adapter, locks, placement) and drive one real mediasoup media
 * node over TCP. Callers and callees sit on different replicas on purpose.
 */
process.env.CALL_MEDIA_MODE = 'remote';
process.env.CALL_MEDIA_NODE_SWEEP_INTERVAL_MS = '200';
process.env.CALL_MEDIA_HEARTBEAT_TTL_MS = '1500';
process.env.MEDIASOUP_WORKERS = '1';
delete process.env.MEDIASOUP_WEBRTC_SERVER_PORT;
process.env.RABBITMQ_URL ||= 'amqp://127.0.0.1:5672';

import type { AuthUser } from '@common/auth/interfaces/auth-user.interface';
import type { INestApplication, INestMicroservice } from '@nestjs/common';
import { Transport } from '@nestjs/microservices';
import { IoAdapter } from '@nestjs/platform-socket.io';
import { Test } from '@nestjs/testing';
import { createAdapter } from '@socket.io/redis-adapter';
import type Redis from 'ioredis';
import { createServer, type AddressInfo } from 'node:net';
import { of, throwError } from 'rxjs';
import type { Server, ServerOptions } from 'socket.io';
import { io, type Socket } from 'socket.io-client';
import {
  callMediaPlacementKey,
  mediaNodeKey,
} from '../../src/media-node/media-node.contract';
import {
  redisServerAvailable,
  startTemporaryRedis,
  type TemporaryRedis,
} from '../support/temporary-redis';

const EVENT_TIMEOUT_MS = 8_000;

const caller: AuthUser = { id: 'caller', email: 'c@x.dev', roles: ['USER'] };
const callee: AuthUser = { id: 'callee', email: 'e@x.dev', roles: ['USER'] };

class FakeAuthClient {
  send(_pattern: string, payload: { token: string }) {
    const users: Record<string, AuthUser> = {
      'caller-token': caller,
      'callee-token': callee,
    };
    return of(users[payload.token] ?? null);
  }
}

class FakeConversationClient {
  send(pattern: string, payload: { id: string; userId: string }) {
    if (pattern !== 'get_conversation_detail') return of(null);
    const conversation = {
      id: 'conv-1',
      participantIds: [caller.id, callee.id],
      isGroup: false,
    };
    return payload.id === conversation.id &&
      conversation.participantIds.includes(payload.userId)
      ? of(conversation)
      : throwError(() => new Error('Conversation not found'));
  }
}

class NullEventPublisher {
  publish() {
    return Promise.resolve();
  }
}

/** The production Redis adapter, wired to the temporary Redis server. */
class TestRedisIoAdapter extends IoAdapter {
  constructor(
    app: INestApplication,
    private readonly pub: Redis,
    private readonly sub: Redis,
  ) {
    super(app);
  }

  createIOServer(port: number, options?: ServerOptions): Server {
    const server = super.createIOServer(port, options) as Server;
    server.adapter(createAdapter(this.pub, this.sub));
    return server;
  }
}

async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const { port } = server.address() as AddressInfo;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

function onceEvent<T>(socket: Socket, event: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      socket.off(event, handler);
      reject(new Error(`Timed out waiting for ${event}`));
    }, EVENT_TIMEOUT_MS);
    const handler = (payload: T) => {
      clearTimeout(timer);
      resolve(payload);
    };
    socket.once(event, handler);
  });
}

(redisServerAvailable ? describe : describe.skip)(
  'Remote media mode across two signaling replicas (real Redis + mediasoup)',
  () => {
    jest.setTimeout(60_000);

    let redis: TemporaryRedis;
    let control: Redis;
    let mediaNode: INestApplication | undefined;
    const replicas: INestApplication[] = [];
    const urls: string[] = [];
    const sockets: Socket[] = [];

    async function startMediaNode(nodeId: string): Promise<INestApplication> {
      // Required lazily: the module reads CALL_MEDIA_MODE when it loads.
      const { MediaNodeModule } =
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        require('../../src/media-node/media-node.module') as typeof import('../../src/media-node/media-node.module');
      const port = await freePort();
      process.env.MEDIA_NODE_ID = nodeId;
      process.env.CALL_MEDIA_RPC_HOST = '127.0.0.1';
      process.env.CALL_MEDIA_RPC_PORT = String(port);
      const moduleRef = await Test.createTestingModule({
        imports: [MediaNodeModule],
      })
        .overrideProvider('REDIS_CLIENT')
        .useValue(await redis.client())
        .overrideProvider('CALL_SERVICE_RMQ')
        .useValue({ emit: () => of(undefined), close: () => undefined })
        .compile();
      const app = moduleRef.createNestApplication();
      app.connectMicroservice<INestMicroservice>({
        transport: Transport.TCP,
        options: { host: '127.0.0.1', port },
      });
      await app.startAllMicroservices();
      await app.listen(0);
      return app;
    }

    async function startReplica(): Promise<void> {
      const { CallServiceModule } =
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        require('../../src/call-service.module') as typeof import('../../src/call-service.module');
      const moduleRef = await Test.createTestingModule({
        imports: [CallServiceModule],
      })
        .overrideProvider('REDIS_CLIENT')
        .useValue(await redis.client())
        .overrideProvider('AUTH_SERVICE_RMQ')
        .useValue(new FakeAuthClient())
        .overrideProvider('CONVERSATION_SERVICE_RMQ')
        .useValue(new FakeConversationClient())
        .overrideProvider('ICallEventPublisher')
        .useValue(new NullEventPublisher())
        .compile();
      const app = moduleRef.createNestApplication();
      app.useWebSocketAdapter(
        new TestRedisIoAdapter(app, await redis.client(), await redis.client()),
      );
      await app.listen(0);
      const { port } = (
        app.getHttpServer() as { address(): AddressInfo }
      ).address();
      replicas.push(app);
      urls.push(`http://127.0.0.1:${port}`);
    }

    async function connect(replica: number, token: string): Promise<Socket> {
      const socket = io(`${urls[replica]}/call`, {
        transports: ['websocket'],
        reconnection: false,
        auth: { token },
      });
      sockets.push(socket);
      await onceEvent(socket, 'call_socket_ready');
      return socket;
    }

    /** Caller on replica 0, callee on replica 1, call answered. */
    async function establishActiveCall() {
      const callerSocket = await connect(0, 'caller-token');
      const calleeSocket = await connect(1, 'callee-token');

      const callerJoined = onceEvent<{ callId: string }>(
        callerSocket,
        'call_joined',
      );
      const incoming = onceEvent<{ callId: string }>(
        calleeSocket,
        'incoming_call',
      );
      callerSocket.emit('initiate_call', {
        conversationId: 'conv-1',
        targetUserId: callee.id,
        callType: 'VIDEO',
      });
      const [{ callId }, incomingCall] = await Promise.all([
        callerJoined,
        incoming,
      ]);
      expect(incomingCall.callId).toBe(callId);

      const calleeJoined = onceEvent(calleeSocket, 'call_joined');
      calleeSocket.emit('join_call', { callId });
      await calleeJoined;

      const answered = onceEvent<{ callId: string }>(
        callerSocket,
        'call_answered',
      );
      calleeSocket.emit('answer_call', { callId });
      await answered;
      return { callerSocket, calleeSocket, callId };
    }

    async function createTransport(
      socket: Socket,
      callId: string,
      direction: 'send' | 'recv',
    ) {
      const created = onceEvent<{
        transportId: string;
        iceCandidates: Array<{ port: number }>;
      }>(socket, 'transport_created');
      socket.emit('create_transport', { callId, direction });
      return created;
    }

    beforeAll(async () => {
      redis = await startTemporaryRedis();
      control = await redis.client();
      mediaNode = await startMediaNode('node-a');
      await startReplica();
      await startReplica();
    });

    afterEach(() => {
      for (const socket of sockets.splice(0)) socket.disconnect();
    });

    afterAll(async () => {
      for (const app of replicas) await app.close().catch(() => undefined);
      await mediaNode?.close().catch(() => undefined);
      await redis?.stop();
    });

    it('signals across replicas and places the room on the media node', async () => {
      const { callerSocket, calleeSocket, callId } =
        await establishActiveCall();

      const placement = JSON.parse(
        (await control.get(callMediaPlacementKey(callId))) ?? 'null',
      ) as { nodeId: string } | null;
      expect(placement?.nodeId).toBe('node-a');

      // Both replicas reach the same room on the same node.
      const send = await createTransport(callerSocket, callId, 'send');
      const recv = await createTransport(calleeSocket, callId, 'recv');
      expect(send.transportId).not.toBe(recv.transportId);
      expect(send.iceCandidates.length).toBeGreaterThan(0);
      expect(
        (await control.keys(`call:${callId}:transport:*`)).sort(),
      ).toHaveLength(2);

      const ended = onceEvent<{ callId: string }>(calleeSocket, 'call_ended');
      callerSocket.emit('leave_call', { callId });
      await expect(ended).resolves.toMatchObject({ callId });
      await new Promise((resolve) => setTimeout(resolve, 300));
      expect(await control.get(callMediaPlacementKey(callId))).toBeNull();
    });

    it('keeps the call when a signaling replica restarts', async () => {
      const { callerSocket, calleeSocket, callId } =
        await establishActiveCall();

      // The caller's replica goes away; its socket drops with it.
      const dropped = new Promise((resolve) =>
        callerSocket.once('disconnect', resolve),
      );
      await replicas[0].close();
      await dropped;

      const session = JSON.parse(
        (await control.get(`call:${callId}:session`)) ?? '{}',
      ) as { status?: string };
      expect(session.status).toBe('active');

      // The callee's replica still drives the media room.
      await createTransport(calleeSocket, callId, 'recv');

      // The caller reconnects through the surviving replica and rejoins.
      replicas[0] = replicas[1];
      urls[0] = urls[1];
      const recovered = await connect(1, 'caller-token');
      const rejoined = onceEvent<{ callId: string }>(
        recovered,
        'call_rejoined',
      );
      recovered.emit('rejoin_call', { callId });
      await expect(rejoined).resolves.toMatchObject({ callId });

      await startReplica();
      const ended = onceEvent(calleeSocket, 'call_ended');
      recovered.emit('leave_call', { callId });
      await ended;
    });

    it('ends calls on a media node that dies, and places new calls on a live one', async () => {
      const { callerSocket, calleeSocket } = await establishActiveCall();
      expect(await control.get(mediaNodeKey('node-a'))).not.toBeNull();

      const callerEnded = onceEvent<{ reason: string }>(
        callerSocket,
        'call_ended',
      );
      const calleeEnded = onceEvent<{ reason: string }>(
        calleeSocket,
        'call_ended',
      );
      await mediaNode?.close();
      mediaNode = undefined;
      await expect(callerEnded).resolves.toMatchObject({
        reason: 'media_unavailable',
      });
      await expect(calleeEnded).resolves.toMatchObject({
        reason: 'media_unavailable',
      });

      // A replacement node takes new calls.
      mediaNode = await startMediaNode('node-b');
      const next = await establishActiveCall();
      const placement = JSON.parse(
        (await control.get(callMediaPlacementKey(next.callId))) ?? 'null',
      ) as { nodeId: string } | null;
      expect(placement?.nodeId).toBe('node-b');
    });
  },
);
