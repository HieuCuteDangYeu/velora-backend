import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import Redis from 'ioredis';
import { CallParticipant } from '../../../src/domain/entities/call-participant.entity';
import { RedisCallStateRepository } from '../../../src/infrastructure/repositories/redis-call-state.repository';

const redisAvailable = spawnSync('redis-server', ['--version']).status === 0;

const describeWithRedis = redisAvailable ? describe : describe.skip;

describeWithRedis('RedisCallStateRepository reconnect index', () => {
  let server: ChildProcess;
  let redis: Redis;
  let repository: RedisCallStateRepository;
  let directory: string;

  beforeAll(async () => {
    // Unix socket paths are short on macOS; os.tmpdir() can exceed that limit.
    directory = mkdtempSync('/tmp/velora-state-redis-');
    const socket = join(directory, 'redis.sock');
    server = spawn(
      'redis-server',
      [
        '--port',
        '0',
        '--unixsocket',
        socket,
        '--save',
        '',
        '--appendonly',
        'no',
      ],
      { stdio: 'ignore' },
    );
    for (let attempt = 0; attempt < 100 && !existsSync(socket); attempt++) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    if (!existsSync(socket)) throw new Error('Temporary Redis did not start');
    redis = new Redis({
      path: socket,
      lazyConnect: true,
      retryStrategy: () => 20,
    });
    await redis.connect();
    repository = new RedisCallStateRepository(redis);
  });

  beforeEach(async () => {
    await redis.flushall();
  });

  afterAll(async () => {
    redis?.disconnect();
    if (server && server.exitCode === null && server.signalCode === null) {
      server.kill();
      await once(server, 'exit');
    }
    if (directory) rmSync(directory, { recursive: true, force: true });
  });

  const participant = (
    userId: string,
    overrides: Partial<CallParticipant> = {},
  ) =>
    new CallParticipant({
      userId,
      callId: 'call-1',
      role: 'guest',
      socketIds: [],
      isConnected: false,
      joinedAt: new Date('2026-01-01T00:00:00.000Z'),
      ...overrides,
    });

  const disconnected = (
    userId: string,
    deadlineMs: number,
    callId = 'call-1',
  ) =>
    participant(userId, {
      callId,
      reconnectDeadlineAt: new Date(deadlineMs),
    });

  it('lists only participants whose reconnect deadline has passed, oldest first', async () => {
    await repository.upsertParticipant(disconnected('late', 5_000));
    await repository.upsertParticipant(disconnected('early', 1_000));
    await repository.upsertParticipant(disconnected('future', 9_000));

    await expect(
      repository.listExpiredReconnects(new Date(5_000), 10),
    ).resolves.toEqual([
      { callId: 'call-1', userId: 'early' },
      { callId: 'call-1', userId: 'late' },
    ]);
    await expect(
      repository.listExpiredReconnects(new Date(5_000), 1),
    ).resolves.toEqual([{ callId: 'call-1', userId: 'early' }]);
  });

  it('drops a participant from the index when it reconnects or is removed', async () => {
    await repository.upsertParticipant(disconnected('a', 1_000));
    await repository.upsertParticipant(disconnected('b', 1_000));
    await repository.upsertParticipant(disconnected('c', 1_000));

    await repository.upsertParticipant(
      participant('a', {
        socketId: 'socket-a',
        socketIds: ['socket-a'],
        isConnected: true,
        reconnectDeadlineAt: undefined,
      }),
    );
    await repository.removeParticipant('call-1', 'b');
    await repository.removeParticipantSocket('call-1', 'c', 'unknown-socket');

    await expect(
      repository.listExpiredReconnects(new Date(10_000), 10),
    ).resolves.toEqual([]);
  });

  it('forgets reconnect entries when the call state is cleared, per call', async () => {
    await repository.upsertParticipant(disconnected('a', 1_000, 'call-1'));
    await repository.upsertParticipant(disconnected('b', 1_000, 'call-1'));
    await repository.upsertParticipant(disconnected('a', 1_000, 'call-2'));

    await repository.clearCallState('call-1');

    await expect(
      repository.listExpiredReconnects(new Date(10_000), 10),
    ).resolves.toEqual([{ callId: 'call-2', userId: 'a' }]);
  });

  it('forgetReconnect removes a single entry without touching the participant', async () => {
    await repository.upsertParticipant(disconnected('a', 1_000));

    await repository.forgetReconnect('call-1', 'a');

    await expect(
      repository.listExpiredReconnects(new Date(10_000), 10),
    ).resolves.toEqual([]);
    await expect(
      repository.getParticipant('call-1', 'a'),
    ).resolves.not.toBeNull();
  });
});
