import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { createServer, type AddressInfo } from 'node:net';
import { ForbiddenException, type INestApplication } from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import { of } from 'rxjs';
import { createAdapter } from '@socket.io/redis-adapter';
import Redis from 'ioredis';
import { io, type Socket as ClientSocket } from 'socket.io-client';
import { SendMessageUseCase } from '../../application/use-cases/send-message.use-case';
import { TriggerBotReplyUseCase } from '../../application/use-cases/trigger-bot-reply.use-case';
import { ConversationPrometheusMetricsService } from '../metrics/conversation-prometheus-metrics.service';
import { ChatGateway } from './chat.gateway';
import { RedisIoAdapter } from './redis-io.apdater';

const redisAvailable = spawnSync('redis-server', ['--version']).status === 0;
const describeWithRedis = redisAvailable ? describe : describe.skip;

const CONVERSATION_ID = '507f1f77bcf86cd799439011';
const users = {
  'token-a': { id: 'user-a', email: 'a@example.com' },
  'token-b': { id: 'user-b', email: 'b@example.com' },
  'token-c': { id: 'user-c', email: 'c@example.com' },
} as const;

/**
 * The production adapter with clients this test can close. RedisIoAdapter
 * never quits its pub/sub clients, which would keep Jest from exiting.
 */
class ClosableRedisIoAdapter extends RedisIoAdapter {
  readonly clients: Redis[] = [];

  constructor(
    app: INestApplication,
    private readonly port: number,
  ) {
    super(app, {} as ConfigService);
  }

  override connectToRedis(): Promise<void> {
    const pubClient = new Redis(this.port, '127.0.0.1');
    const subClient = pubClient.duplicate();
    this.clients.push(pubClient, subClient);
    (this as unknown as { adapterConstructor: unknown }).adapterConstructor =
      createAdapter(pubClient, subClient);
    return Promise.resolve();
  }
}

const freePort = () =>
  new Promise<number>((resolve) => {
    const server = createServer();
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as AddressInfo;
      server.close(() => resolve(port));
    });
  });

const waitFor = async (check: () => Promise<boolean>, timeoutMs = 3000) => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error('Condition was not met in time');
};

const nextEvent = <T>(socket: ClientSocket, event: string, timeoutMs = 3000) =>
  new Promise<T>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`Timed out waiting for ${event}`)),
      timeoutMs,
    );
    socket.once(event, (payload: T) => {
      clearTimeout(timer);
      resolve(payload);
    });
  });

const noEvent = (socket: ClientSocket, event: string, windowMs = 400) =>
  new Promise<unknown>((resolve) => {
    const handler = (payload: unknown) => {
      clearTimeout(timer);
      resolve(payload);
    };
    const timer = setTimeout(() => {
      socket.off(event, handler);
      resolve(null);
    }, windowMs);
    socket.once(event, handler);
  });

/**
 * Real Socket.IO servers with the production Redis adapter, two instances
 * sharing one Redis. Typing is authorized by conversation-room membership, so
 * this proves the room really is a reliable authorization boundary: joins are
 * checked, outsiders are dropped, and eviction from another instance takes
 * effect on the instance that holds the socket.
 */
describeWithRedis(
  'ChatGateway typing authorized by room membership (real Socket.IO + Redis adapter)',
  () => {
    let redisServer: ChildProcess;
    let redisPort: number;
    const apps: INestApplication[] = [];
    const redisClients: Redis[] = [];
    const gateways: ChatGateway[] = [];
    const urls: string[] = [];
    const clients: ClientSocket[] = [];
    const members = new Set(['user-a', 'user-b']);
    const assertConversationParticipant = jest.fn(
      (conversationId: string, userId: string) => {
        if (conversationId !== CONVERSATION_ID || !members.has(userId)) {
          return Promise.reject(new ForbiddenException('Not a participant'));
        }
        return Promise.resolve();
      },
    );

    const startInstance = async () => {
      const moduleRef = await Test.createTestingModule({
        providers: [
          ChatGateway,
          { provide: SendMessageUseCase, useValue: {} },
          { provide: TriggerBotReplyUseCase, useValue: {} },
          {
            provide: ConversationPrometheusMetricsService,
            useValue: {
              measurePhase: (_phase: string, task: () => unknown) => task(),
            },
          },
          {
            provide: 'IChatRepository',
            useValue: {
              assertConversationParticipant,
              findPresenceAudienceUserIds: () => Promise.resolve([]),
            },
          },
          {
            provide: 'AUTH_SERVICE_RMQ',
            useValue: {
              send: (_pattern: string, { token }: { token: string }) =>
                of(users[token as keyof typeof users] ?? null),
            },
          },
          {
            provide: 'REDIS_CLIENT',
            useValue: {
              get: () => Promise.resolve(null),
              set: () => Promise.resolve('OK'),
              del: () => Promise.resolve(1),
            },
          },
        ],
      }).compile();
      const app = moduleRef.createNestApplication();
      const adapter = new ClosableRedisIoAdapter(app, redisPort);
      await adapter.connectToRedis();
      redisClients.push(...adapter.clients);
      app.useWebSocketAdapter(adapter);
      await app.listen(0, '127.0.0.1');
      const { port } = (
        app.getHttpServer() as { address(): AddressInfo }
      ).address();
      apps.push(app);
      gateways.push(app.get(ChatGateway));
      urls.push(`http://127.0.0.1:${port}`);
    };

    const connect = async (instance: number, token: keyof typeof users) => {
      const socket = io(urls[instance], {
        transports: ['websocket'],
        reconnection: false,
        auth: { token },
      });
      clients.push(socket);
      await nextEvent(socket, 'connect');
      // The server joins the user rooms asynchronously after authenticating.
      await waitFor(async () => {
        const sockets = await gateways[instance].server
          .in(`user:${users[token].id}`)
          .fetchSockets();
        return sockets.some((candidate) => candidate.id === socket.id);
      });
      return socket;
    };

    const conversationSockets = async () =>
      (
        await gateways[0].server
          .in(`conversation:${CONVERSATION_ID}`)
          .fetchSockets()
      ).map((socket) => socket.id);

    beforeAll(async () => {
      redisPort = await freePort();
      redisServer = spawn(
        'redis-server',
        ['--port', String(redisPort), '--save', '', '--appendonly', 'no'],
        { stdio: 'ignore' },
      );
      // Wait with the client library itself, so only redis-server is required.
      const probe = new Redis(redisPort, '127.0.0.1', {
        lazyConnect: true,
        maxRetriesPerRequest: 0,
        retryStrategy: () => null,
      });
      try {
        await waitFor(async () => {
          try {
            if (probe.status !== 'ready') await probe.connect();
            return (await probe.ping()) === 'PONG';
          } catch {
            probe.disconnect();
            return false;
          }
        }, 5000);
      } finally {
        probe.disconnect();
      }
      await startInstance();
      await startInstance();
    }, 30_000);

    afterAll(async () => {
      clients.forEach((socket) => socket.disconnect());
      for (const app of apps) await app.close();
      redisClients.forEach((client) => client.disconnect());
      if (redisServer && redisServer.exitCode === null) {
        redisServer.kill();
        await once(redisServer, 'exit');
      }
    });

    it('relays typing only from joined members, stops at eviction (from another instance), and resumes after re-joining', async () => {
      const a = await connect(0, 'token-a');
      const b = await connect(0, 'token-b');
      const outsider = await connect(0, 'token-c');

      // Before joining, a member's typing is dropped (no room yet).
      const earlyTyping = noEvent(b, 'user_typing');
      a.emit('typing_start', CONVERSATION_ID);
      await expect(earlyTyping).resolves.toBeNull();

      a.emit('join_conversation', CONVERSATION_ID);
      b.emit('join_conversation', CONVERSATION_ID);
      await waitFor(async () => (await conversationSockets()).length === 2);

      // 1. Joined member -> other member, both directions, start and stop.
      const started = nextEvent(b, 'user_typing');
      a.emit('typing_start', CONVERSATION_ID);
      await expect(started).resolves.toEqual({
        conversationId: CONVERSATION_ID,
        userId: 'user-a',
        isTyping: true,
      });
      const stopped = nextEvent(b, 'user_typing');
      a.emit('typing_stop', CONVERSATION_ID);
      await expect(stopped).resolves.toEqual({
        conversationId: CONVERSATION_ID,
        userId: 'user-a',
        isTyping: false,
      });
      const reverse = nextEvent(a, 'user_typing');
      b.emit('typing_start', CONVERSATION_ID);
      await expect(reverse).resolves.toEqual(
        expect.objectContaining({ userId: 'user-b', isTyping: true }),
      );

      // 2. An outsider's join is rejected, so their typing never reaches members.
      const rejected = nextEvent(outsider, 'conversation_removed');
      outsider.emit('join_conversation', CONVERSATION_ID);
      await rejected;
      const outsiderTyping = noEvent(b, 'user_typing');
      outsider.emit('typing_start', CONVERSATION_ID);
      outsider.emit('typing_stop', CONVERSATION_ID);
      await expect(outsiderTyping).resolves.toBeNull();

      // 3. Removal is applied on instance 1 while the socket lives on instance 0.
      members.delete('user-a');
      const removedNotice = nextEvent(a, 'conversation_removed');
      gateways[1].evictConversationMember({
        conversationId: CONVERSATION_ID,
        userId: 'user-a',
        reason: 'removed',
      });
      await removedNotice;
      await waitFor(async () => !(await conversationSockets()).includes(a.id!));
      const afterEviction = noEvent(b, 'user_typing');
      a.emit('typing_start', CONVERSATION_ID);
      await expect(afterEviction).resolves.toBeNull();

      // 4. A former member reconnecting cannot get back in.
      const aAgain = await connect(1, 'token-a');
      const stillOut = nextEvent(aAgain, 'conversation_removed');
      aAgain.emit('join_conversation', CONVERSATION_ID);
      await stillOut;
      const formerTyping = noEvent(b, 'user_typing');
      aAgain.emit('typing_start', CONVERSATION_ID);
      await expect(formerTyping).resolves.toBeNull();

      // 5. Re-added: joining again restores typing, across instances.
      members.add('user-a');
      aAgain.emit('join_conversation', CONVERSATION_ID);
      await waitFor(async () =>
        (await conversationSockets()).includes(aAgain.id!),
      );
      const resumed = nextEvent(b, 'user_typing');
      aAgain.emit('typing_start', CONVERSATION_ID);
      await expect(resumed).resolves.toEqual(
        expect.objectContaining({ userId: 'user-a', isTyping: true }),
      );

      // 6. A typing_stop flushed by a reconnecting member before its new socket
      //    re-joins the room still clears the indicator for everyone else.
      const aReconnecting = await connect(0, 'token-a');
      const clearedAfterReconnect = nextEvent(b, 'user_typing');
      aReconnecting.emit('typing_stop', CONVERSATION_ID);
      await expect(clearedAfterReconnect).resolves.toEqual(
        expect.objectContaining({ userId: 'user-a', isTyping: false }),
      );

      // Typing never reads the database, except that rare stop fallback (and the
      // outsider's rejected stop). Everything else was the 5 join attempts.
      expect(assertConversationParticipant).toHaveBeenCalledTimes(5 + 2);
    }, 30_000);
  },
);
