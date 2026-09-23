import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import Redis from 'ioredis';
import { CallSession } from '../../../src/domain/entities/call-session.entity';
import { RedisCallSessionRepository } from '../../../src/infrastructure/repositories/redis-call-session.repository';

const redisAvailable = spawnSync('redis-server', ['--version']).status === 0;

const describeWithRedis = redisAvailable ? describe : describe.skip;

describeWithRedis('Redis group-call transitions', () => {
  let server: ChildProcess;
  let redis: Redis;
  let repository: RedisCallSessionRepository;
  let directory: string;

  beforeAll(async () => {
    // Unix socket paths are short on macOS; os.tmpdir() can exceed that limit.
    directory = mkdtempSync('/tmp/velora-group-redis-');
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
    await redis.ping();
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

  const group = (callId: string, initiatorId = 'host') => {
    const now = new Date();
    return new CallSession({
      callId,
      conversationId: 'conversation',
      initiatorId,
      targetUserId: 'guest',
      invitedUserIds: [initiatorId, 'guest', 'other'],
      isGroupCall: true,
      groupName: 'Team',
      callType: 'VOICE',
      status: 'active',
      participantIds: [initiatorId],
      answeredAt: now,
      expiresAt: new Date(now.getTime() + 30_000),
      createdAt: now,
      updatedAt: now,
    });
  };

  it('reserves the host once and releases every joined user after media restart', async () => {
    expect(await repository.createActiveGroupSession(group('room-1'))).toBe(
      true,
    );
    expect(await repository.createActiveGroupSession(group('room-2'))).toBe(
      false,
    );
    expect(
      (
        await repository.joinParticipant(
          'room-1',
          'guest',
          new Date(),
          'answer-1',
        )
      ).outcome,
    ).toBe('joined');
    expect(
      await repository.confirmGroupInvitationJoin(
        'room-1',
        'guest',
        'answer-1',
        new Date(),
      ),
    ).toBe(true);
    expect(await redis.hget('call:sessions:active-by-user', 'guest')).toBe(
      'room-1',
    );

    const ended = await repository.terminateActiveCallsForMediaRestart(
      new Date(),
      10,
    );
    expect(ended).toHaveLength(1);
    expect(ended[0].status).toBe('ended');
    expect(await redis.hget('call:sessions:active-by-user', 'host')).toBeNull();
    expect(
      await redis.hget('call:sessions:active-by-user', 'guest'),
    ).toBeNull();
    expect(await repository.createActiveGroupSession(group('room-2'))).toBe(
      true,
    );
  });

  it('lets one device win accept and prevents a declined invitation from rejoining', async () => {
    await repository.createActiveGroupSession(group('room-3'));
    const [first, second] = await Promise.all([
      repository.joinParticipant('room-3', 'guest', new Date(), 'device-a'),
      repository.joinParticipant('room-3', 'guest', new Date(), 'device-b'),
    ]);
    expect([first.outcome, second.outcome].sort()).toEqual([
      'answered_elsewhere',
      'joined',
    ]);
    const winner = first.outcome === 'joined' ? 'device-a' : 'device-b';
    expect(
      (await repository.joinParticipant('room-3', 'guest', new Date())).outcome,
    ).toBe('forbidden');
    expect(
      (await repository.joinParticipant('room-3', 'guest', new Date(), winner))
        .outcome,
    ).toBe('joined');
    expect(
      await repository.claimPendingGroupInvitationEvents(new Date(), 10),
    ).toEqual([]);
    expect(
      await repository.confirmGroupInvitationJoin(
        'room-3',
        'guest',
        winner,
        new Date(),
      ),
    ).toBe(true);
    expect(
      await repository.confirmGroupInvitationJoin(
        'room-3',
        'guest',
        winner,
        new Date(),
      ),
    ).toBe(true);
    expect(
      await repository.abortGroupInvitationJoin(
        'room-3',
        'guest',
        winner,
        new Date(),
        'media_unavailable',
      ),
    ).toBe(false);
    expect(
      (
        await repository.rejectGroupInvitation(
          'room-3',
          'other',
          new Date(),
          'rejected',
        )
      ).outcome,
    ).toBe('rejected');
    expect(
      (
        await repository.joinParticipant(
          'room-3',
          'other',
          new Date(),
          'late-action',
        )
      ).outcome,
    ).toBe('declined');
    expect((await repository.findByCallId('room-3'))?.participantIds).toEqual([
      'host',
      'guest',
    ]);

    const events = await repository.claimPendingGroupInvitationEvents(
      new Date(),
      10,
    );
    expect(events).toHaveLength(2);
    expect(events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          event: 'call.answered',
          userId: 'guest',
          actionId: winner,
        }),
        expect.objectContaining({
          event: 'call.rejected',
          userId: 'other',
          reason: 'rejected',
        }),
      ]),
    );
    expect(
      await repository.claimPendingGroupInvitationEvents(new Date(), 10),
    ).toEqual([]);
    await repository.markGroupInvitationEventPublished(events[0].key);
    expect(await redis.zcard('call:sessions:group-invitation-events')).toBe(1);
    const retry = await repository.claimPendingGroupInvitationEvents(
      new Date(Date.now() + 10_001),
      10,
    );
    expect(retry).toHaveLength(1);
    expect(retry[0].key).toBe(events[1].key);
    await repository.markGroupInvitationEventPublished(retry[0].key);
    expect(await redis.zcard('call:sessions:group-invitation-events')).toBe(0);
  });

  it('releases an unconfirmed media failure so another device can answer', async () => {
    await repository.createActiveGroupSession(group('room-failed'));
    expect(
      (
        await repository.joinParticipant(
          'room-failed',
          'guest',
          new Date(),
          'failed-action',
        )
      ).outcome,
    ).toBe('joined');
    expect(
      await repository.abortGroupInvitationJoin(
        'room-failed',
        'guest',
        'failed-action',
        new Date(),
      ),
    ).toBe(true);
    expect(
      await repository.confirmGroupInvitationJoin(
        'room-failed',
        'guest',
        'failed-action',
        new Date(),
      ),
    ).toBe(false);
    expect(
      (await repository.findByCallId('room-failed'))?.participantIds,
    ).toEqual(['host']);
    expect(
      await redis.hget('call:sessions:active-by-user', 'guest'),
    ).toBeNull();
    expect(
      await repository.claimPendingGroupInvitationEvents(new Date(), 10),
    ).toEqual([]);
    expect(
      (
        await repository.joinParticipant(
          'room-failed',
          'guest',
          new Date(),
          'device-b',
        )
      ).outcome,
    ).toBe('joined');
  });

  it('clears a stale active index when its session expired', async () => {
    await repository.createActiveGroupSession(group('expired-room'));
    await redis.del('call:expired-room:session');
    expect(await repository.createActiveGroupSession(group('new-room'))).toBe(
      true,
    );
    await redis.hset('call:sessions:active-by-user', 'guest', 'expired-room');
    expect(
      (
        await repository.joinParticipant(
          'new-room',
          'guest',
          new Date(),
          'device-b',
        )
      ).outcome,
    ).toBe('joined');
  });
});
