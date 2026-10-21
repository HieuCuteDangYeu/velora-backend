import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import Redis from 'ioredis';
import { CallSession } from '../../../src/domain/entities/call-session.entity';
import { RedisCallSessionRepository } from '../../../src/infrastructure/repositories/redis-call-session.repository';

const redisAvailable = spawnSync('redis-server', ['--version']).status === 0;
const describeWithRedis = redisAvailable ? describe : describe.skip;
const HISTORY_KEY = 'call:sessions:history-events';

describeWithRedis('Redis call history outbox', () => {
  let server: ChildProcess;
  let redis: Redis;
  let repository: RedisCallSessionRepository;
  let directory: string;

  beforeAll(async () => {
    directory = mkdtempSync('/tmp/velora-history-redis-');
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
    repository = new RedisCallSessionRepository(redis);
  });

  afterEach(async () => redis.flushdb());

  afterAll(async () => {
    if (redis?.status === 'ready') await redis.quit();
    if (server && server.exitCode === null && server.signalCode === null) {
      server.kill();
      await once(server, 'exit');
    }
    if (directory) rmSync(directory, { recursive: true, force: true });
  });

  /** A ringing 1-1 call that the caller then cancels. */
  const endRingingCall = async (callId: string, now: Date) => {
    await repository.save(
      new CallSession({
        callId,
        conversationId: 'conversation',
        initiatorId: 'caller',
        targetUserId: 'callee',
        invitedUserIds: ['callee'],
        callType: 'VOICE',
        status: 'ringing',
        participantIds: ['caller'],
        expiresAt: new Date(now.getTime() + 30_000),
        lifecycleRevision: 0,
        createdAt: now,
        updatedAt: now,
      }),
    );
    const transition = await repository.transitionToTerminal(
      callId,
      'caller',
      undefined,
      now,
      'leave',
    );
    expect(transition.outcome).toBe('transitioned');
    return transition.session!;
  };

  it('enqueues history only once the terminal event is published', async () => {
    const now = new Date();
    const session = await endRingingCall('call-1', now);

    expect(await redis.zscore(HISTORY_KEY, 'call-1')).toBeNull();
    await expect(
      repository.claimPendingHistoryEvents(now, 10),
    ).resolves.toEqual([]);

    await repository.markTerminalEventPublished(
      'call-1',
      session.lifecycleRevision,
      now,
    );

    expect(Number(await redis.zscore(HISTORY_KEY, 'call-1'))).toBe(
      now.getTime(),
    );
    const claimed = await repository.claimPendingHistoryEvents(now, 10);
    expect(claimed.map((s) => [s.callId, s.status, s.terminalReason])).toEqual([
      ['call-1', 'cancelled', 'cancelled'],
    ]);
  });

  it('leases a claimed call until it is recorded and never re-enqueues it', async () => {
    const now = new Date();
    const session = await endRingingCall('call-2', now);
    await repository.markTerminalEventPublished(
      'call-2',
      session.lifecycleRevision,
      now,
    );

    expect(await repository.claimPendingHistoryEvents(now, 10)).toHaveLength(1);
    // Still leased: not claimable again until the lease ends.
    expect(await repository.claimPendingHistoryEvents(now, 10)).toHaveLength(0);
    const afterLease = new Date(now.getTime() + 31_000);
    expect(
      await repository.claimPendingHistoryEvents(afterLease, 10),
    ).toHaveLength(1);

    await repository.markHistoryRecorded('call-2');
    expect(await redis.zcard(HISTORY_KEY)).toBe(0);

    // A repeated terminal acknowledgement is a no-op and does not re-enqueue.
    await repository.markTerminalEventPublished(
      'call-2',
      session.lifecycleRevision,
      now,
    );
    expect(await redis.zcard(HISTORY_KEY)).toBe(0);
  });

  it('drops a call whose session has already expired', async () => {
    const now = new Date();
    const session = await endRingingCall('call-3', now);
    await repository.markTerminalEventPublished(
      'call-3',
      session.lifecycleRevision,
      now,
    );
    await redis.del('call:call-3:session');

    await expect(
      repository.claimPendingHistoryEvents(now, 10),
    ).resolves.toEqual([]);
    expect(await redis.zcard(HISTORY_KEY)).toBe(0);
  });
});
