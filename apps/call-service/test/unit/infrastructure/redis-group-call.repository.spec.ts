import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import Redis from 'ioredis';
import { PublishCallTerminalOutboxUseCase } from '../../../src/application/use-cases/publish-call-terminal-outbox.use-case';
import { CallParticipant } from '../../../src/domain/entities/call-participant.entity';
import { CallSession } from '../../../src/domain/entities/call-session.entity';
import { RedisCallSessionRepository } from '../../../src/infrastructure/repositories/redis-call-session.repository';
import { RedisCallStateRepository } from '../../../src/infrastructure/repositories/redis-call-state.repository';

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

  it('keeps the room and remaining guests active when one guest leaves', async () => {
    await repository.createActiveGroupSession(group('room-leave'));
    const state = new RedisCallStateRepository(redis);
    for (const userId of ['host', 'guest', 'other']) {
      await state.upsertParticipant(
        new CallParticipant({
          callId: 'room-leave',
          userId,
          role: userId === 'host' ? 'host' : 'guest',
          socketIds: [`socket-${userId}`],
          isConnected: true,
        }),
      );
    }
    for (const userId of ['guest', 'other']) {
      expect(
        (
          await repository.joinParticipant(
            'room-leave',
            userId,
            new Date(),
            `${userId}-answer`,
          )
        ).outcome,
      ).toBe('joined');
      expect(
        await repository.confirmGroupInvitationJoin(
          'room-leave',
          userId,
          `${userId}-answer`,
          new Date(),
        ),
      ).toBe(true);
      await state.saveTransportState({
        callId: 'room-leave',
        userId,
        transportId: `transport-${userId}`,
        direction: 'send',
        connected: true,
      });
      await state.saveProducerState({
        callId: 'room-leave',
        userId,
        producerId: `producer-${userId}`,
        transportId: `transport-${userId}`,
        kind: 'audio',
      });
    }
    await redis.set(
      'call:foreign:producer:guest:foreign',
      JSON.stringify({ userId: 'guest' }),
    );
    await redis.sadd(
      'call:room-leave:producer-index',
      'call:foreign:producer:guest:foreign',
    );

    const leave = await repository.transitionToTerminal(
      'room-leave',
      'guest',
      'left',
      new Date(),
      'leave',
    );
    expect(leave.outcome).toBe('participant_left');
    expect(leave.session?.status).toBe('active');
    expect(leave.session?.participantIds).toEqual(['host', 'other']);
    expect(await state.getParticipant('room-leave', 'guest')).toBeNull();
    expect(await state.getTransport('room-leave', 'guest', 'send')).toBeNull();
    expect(
      await redis.get('call:room-leave:producer:guest:producer-guest'),
    ).toBeNull();
    expect(
      await state.getTransport('room-leave', 'other', 'send'),
    ).not.toBeNull();
    expect(
      await redis.get('call:room-leave:producer:other:producer-other'),
    ).not.toBeNull();
    expect(
      await redis.get('call:foreign:producer:guest:foreign'),
    ).not.toBeNull();
    expect(
      (await state.getParticipants('room-leave')).map((p) => p.userId).sort(),
    ).toEqual(['host', 'other']);
    expect(
      await redis.hget('call:sessions:active-by-user', 'guest'),
    ).toBeNull();
    expect(await redis.hget('call:sessions:active-by-user', 'host')).toBe(
      'room-leave',
    );
    expect(await redis.hget('call:sessions:active-by-user', 'other')).toBe(
      'room-leave',
    );
    expect(
      (
        await repository.joinParticipant(
          'room-leave',
          'guest',
          new Date(),
          'late-answer',
        )
      ).outcome,
    ).toBe('declined');

    expect(
      (
        await repository.transitionToTerminal(
          'room-leave',
          'host',
          'ended',
          new Date(),
          'leave',
        )
      ).outcome,
    ).toBe('transitioned');
    expect(await redis.hget('call:sessions:active-by-user', 'host')).toBeNull();
    expect(await state.getParticipants('room-leave')).toEqual([]);
    expect(
      await redis.hget('call:sessions:active-by-user', 'other'),
    ).toBeNull();
  });

  it('releases every active index when host end races guest leave', async () => {
    await repository.createActiveGroupSession(group('room-terminal-race'));
    expect(
      (
        await repository.joinParticipant(
          'room-terminal-race',
          'guest',
          new Date(),
          'guest-answer',
        )
      ).outcome,
    ).toBe('joined');
    expect(
      await repository.confirmGroupInvitationJoin(
        'room-terminal-race',
        'guest',
        'guest-answer',
        new Date(),
      ),
    ).toBe(true);

    const [hostEnd, guestLeave] = await Promise.all([
      repository.transitionToTerminal(
        'room-terminal-race',
        'host',
        'ended',
        new Date(),
        'leave',
      ),
      repository.transitionToTerminal(
        'room-terminal-race',
        'guest',
        'left',
        new Date(),
        'leave',
      ),
    ]);
    expect(hostEnd.outcome).toBe('transitioned');
    expect(['participant_left', 'already_terminal']).toContain(
      guestLeave.outcome,
    );
    expect((await repository.findByCallId('room-terminal-race'))?.status).toBe(
      'ended',
    );
    for (const userId of ['host', 'guest', 'other']) {
      expect(
        await redis.hget('call:sessions:active-by-user', userId),
      ).toBeNull();
    }
  });

  it('does not change the session when participant state is corrupt at guest leave', async () => {
    await repository.createActiveGroupSession(group('room-corrupt-state'));
    await repository.joinParticipant(
      'room-corrupt-state',
      'guest',
      new Date(),
      'guest-answer',
    );
    await repository.confirmGroupInvitationJoin(
      'room-corrupt-state',
      'guest',
      'guest-answer',
      new Date(),
    );
    await redis.set('call:room-corrupt-state:participants', 'not-a-hash');

    await expect(
      repository.transitionToTerminal(
        'room-corrupt-state',
        'guest',
        'left',
        new Date(),
        'leave',
      ),
    ).rejects.toThrow('Invalid call participant state type');
    expect(
      (await repository.findByCallId('room-corrupt-state'))?.participantIds,
    ).toContain('guest');
    expect(await redis.hget('call:sessions:active-by-user', 'guest')).toBe(
      'room-corrupt-state',
    );
  });

  it('does not remove a guest when its media index is corrupt', async () => {
    await repository.createActiveGroupSession(group('room-corrupt-media'));
    await repository.joinParticipant(
      'room-corrupt-media',
      'guest',
      new Date(),
      'guest-answer',
    );
    const state = new RedisCallStateRepository(redis);
    await state.saveTransportState({
      callId: 'room-corrupt-media',
      userId: 'guest',
      transportId: 'transport-guest',
      direction: 'send',
      connected: true,
    });
    await redis.del('call:room-corrupt-media:transport-index');
    await redis.set('call:room-corrupt-media:transport-index', 'invalid');

    await expect(
      repository.transitionToTerminal(
        'room-corrupt-media',
        'guest',
        'left',
        new Date(),
        'leave',
      ),
    ).rejects.toThrow('Invalid call media index type');
    expect(
      (await repository.findByCallId('room-corrupt-media'))?.participantIds,
    ).toContain('guest');
    expect(
      await state.getTransport('room-corrupt-media', 'guest', 'send'),
    ).not.toBeNull();
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

  it('does not remove a newer transport while compensating an older failed one', async () => {
    const stateRepository = new RedisCallStateRepository(redis);
    await repository.createActiveGroupSession(group('room-transport'));
    await repository.joinParticipant(
      'room-transport',
      'guest',
      new Date(),
      'guest-answer',
    );
    const state = {
      callId: 'room-transport',
      userId: 'guest',
      direction: 'send' as const,
      connected: false,
    };
    await stateRepository.saveTransportState({ ...state, transportId: 'old' });
    await stateRepository.saveTransportState({ ...state, transportId: 'new' });

    await stateRepository.removeTransportState(
      state.callId,
      state.userId,
      state.direction,
      'old',
    );
    expect(
      await stateRepository.getTransport(
        state.callId,
        state.userId,
        state.direction,
      ),
    ).toEqual({ ...state, transportId: 'new' });

    await stateRepository.removeTransportState(
      state.callId,
      state.userId,
      state.direction,
      'new',
    );
    expect(
      await stateRepository.getTransport(
        state.callId,
        state.userId,
        state.direction,
      ),
    ).toBeNull();
    expect(await redis.smembers('call:room-transport:transport-index')).toEqual(
      [],
    );
  });

  it('does not persist media state when its Redis index is invalid', async () => {
    const stateRepository = new RedisCallStateRepository(redis);
    await redis.set('call:broken-media:transport-index', 'invalid');
    await redis.set('call:broken-media:producer-index', 'invalid');

    await expect(
      stateRepository.saveTransportState({
        callId: 'broken-media',
        userId: 'guest',
        transportId: 'transport-1',
        direction: 'send',
        connected: false,
      }),
    ).rejects.toThrow('Invalid call state index type');
    await expect(
      stateRepository.saveProducerState({
        callId: 'broken-media',
        userId: 'guest',
        producerId: 'producer-1',
        transportId: 'transport-1',
        kind: 'audio',
      }),
    ).rejects.toThrow('Invalid call state index type');

    expect(
      await redis.get('call:broken-media:transport:guest:send'),
    ).toBeNull();
    expect(
      await redis.get('call:broken-media:producer:guest:producer-1'),
    ).toBeNull();
  });

  it('does not half-remove media state when its Redis index is invalid', async () => {
    const stateRepository = new RedisCallStateRepository(redis);
    await repository.createActiveGroupSession(group('broken-removal'));
    await repository.joinParticipant(
      'broken-removal',
      'guest',
      new Date(),
      'guest-answer',
    );
    await stateRepository.saveTransportState({
      callId: 'broken-removal',
      userId: 'guest',
      transportId: 'transport-1',
      direction: 'send',
      connected: true,
    });
    await stateRepository.saveProducerState({
      callId: 'broken-removal',
      userId: 'guest',
      producerId: 'producer-1',
      transportId: 'transport-1',
      kind: 'audio',
    });
    await redis.del('call:broken-removal:transport-index');
    await redis.del('call:broken-removal:producer-index');
    await redis.set('call:broken-removal:transport-index', 'invalid');
    await redis.set('call:broken-removal:producer-index', 'invalid');

    await expect(
      stateRepository.removeTransportState(
        'broken-removal',
        'guest',
        'send',
        'transport-1',
      ),
    ).rejects.toThrow();
    await expect(
      stateRepository.removeProducerState(
        'broken-removal',
        'guest',
        'producer-1',
      ),
    ).rejects.toThrow();
    expect(
      await redis.get('call:broken-removal:transport:guest:send'),
    ).not.toBeNull();
    expect(
      await redis.get('call:broken-removal:producer:guest:producer-1'),
    ).not.toBeNull();
  });

  it('does not delete another call through a poisoned media index', async () => {
    const stateRepository = new RedisCallStateRepository(redis);
    await redis.set('call:foreign:producer:guest:foreign', 'foreign-state');
    await redis.sadd(
      'call:target:producer-index',
      'call:foreign:producer:guest:foreign',
    );

    await stateRepository.clearCallState('target');

    expect(await redis.get('call:foreign:producer:guest:foreign')).toBe(
      'foreign-state',
    );
  });

  it('rejects late media writes after guest leave or host terminal', async () => {
    const callId = 'room-late-media';
    const stateRepository = new RedisCallStateRepository(redis);
    await repository.createActiveGroupSession(group(callId));
    await repository.joinParticipant(
      callId,
      'guest',
      new Date(),
      'guest-answer',
    );
    await repository.confirmGroupInvitationJoin(
      callId,
      'guest',
      'guest-answer',
      new Date(),
    );
    await repository.transitionToTerminal(
      callId,
      'guest',
      'left',
      new Date(),
      'leave',
    );

    await expect(
      stateRepository.saveProducerState({
        callId,
        userId: 'guest',
        producerId: 'late-producer',
        transportId: 'old-transport',
        kind: 'audio',
      }),
    ).rejects.toThrow('Call media admission denied');
    expect(
      await redis.get(`call:${callId}:producer:guest:late-producer`),
    ).toBeNull();

    await repository.transitionToTerminal(
      callId,
      'host',
      'ended',
      new Date(),
      'leave',
    );
    await expect(
      stateRepository.saveTransportState({
        callId,
        userId: 'host',
        transportId: 'late-transport',
        direction: 'send',
        connected: false,
      }),
    ).rejects.toThrow('Call media admission denied');
    expect(
      await stateRepository.getTransport(callId, 'host', 'send'),
    ).toBeNull();
  });

  it('allows active 1:1 media but rejects a write after its terminal transition', async () => {
    const callId = 'direct-media-fence';
    const now = new Date();
    await repository.save(
      new CallSession({
        callId,
        conversationId: 'direct-conversation',
        initiatorId: 'host',
        targetUserId: 'guest',
        callType: 'VOICE',
        status: 'active',
        participantIds: ['host', 'guest'],
        answeredAt: now,
        createdAt: now,
        updatedAt: now,
      }),
    );
    const stateRepository = new RedisCallStateRepository(redis);
    const transport = {
      callId,
      userId: 'host',
      transportId: 'transport-1',
      direction: 'send' as const,
      connected: true,
    };
    await expect(
      stateRepository.saveTransportState(transport),
    ).resolves.toBeUndefined();
    await repository.transitionToTerminal(
      callId,
      'host',
      'ended',
      new Date(),
      'leave',
    );
    await expect(
      stateRepository.saveTransportState({ ...transport, transportId: 'late' }),
    ).rejects.toThrow('Call media admission denied');
  });

  it('does not partially clear a call when a media index is corrupt', async () => {
    const stateRepository = new RedisCallStateRepository(redis);
    await repository.createActiveGroupSession(group('broken-clear'));
    await repository.joinParticipant(
      'broken-clear',
      'guest',
      new Date(),
      'guest-answer',
    );
    await stateRepository.saveRoom({
      callId: 'broken-clear',
      routerId: 'router-1',
      workerId: 'worker-1',
    });
    await stateRepository.saveTransportState({
      callId: 'broken-clear',
      userId: 'guest',
      transportId: 'transport-1',
      direction: 'send',
      connected: true,
    });
    await redis.set('call:broken-clear:producer-index', 'invalid');

    await expect(
      stateRepository.clearCallState('broken-clear'),
    ).rejects.toThrow('Invalid call state index type');
    expect(await stateRepository.getRoom('broken-clear')).not.toBeNull();
    expect(
      await stateRepository.getTransport('broken-clear', 'guest', 'send'),
    ).not.toBeNull();
  });

  it('clears terminal media keys in one atomic Redis operation', async () => {
    const stateRepository = new RedisCallStateRepository(redis);
    await stateRepository.saveRoom({
      callId: 'atomic-clear',
      routerId: 'router-1',
      workerId: 'worker-1',
    });
    const evalSpy = jest.spyOn(redis, 'eval');

    await stateRepository.clearCallState('atomic-clear');

    expect(evalSpy).toHaveBeenCalledTimes(1);
    expect(await stateRepository.getRoom('atomic-clear')).toBeNull();
    evalSpy.mockRestore();
  });

  it('retries terminal state cleanup from the durable outbox after Redis recovers', async () => {
    const callId = 'room-cleanup-retry';
    const stateRepository = new RedisCallStateRepository(redis);
    await repository.createActiveGroupSession(group(callId));
    await stateRepository.saveRoom({
      callId,
      routerId: 'router-1',
      workerId: 'worker-1',
    });
    const now = new Date();
    await repository.transitionToTerminal(
      callId,
      'host',
      'ended',
      now,
      'leave',
    );
    const publisher = { publish: jest.fn().mockResolvedValue(undefined) };
    const cleanup = jest
      .fn()
      .mockRejectedValueOnce(new Error('Redis temporarily unavailable'))
      .mockImplementation((id: string) => stateRepository.clearCallState(id));
    const outbox = new PublishCallTerminalOutboxUseCase(repository, publisher, {
      clearCallState: cleanup,
    } as never);

    await outbox.execute(now);
    expect(await stateRepository.getRoom(callId)).not.toBeNull();
    expect(
      (await repository.findByCallId(callId))?.terminalEventPublishedAt,
    ).toBeUndefined();
    await outbox.execute(new Date(now.getTime() + 11_000));
    expect(await stateRepository.getRoom(callId)).toBeNull();
    expect(
      (await repository.findByCallId(callId))?.terminalEventPublishedAt,
    ).toBeInstanceOf(Date);
    expect(cleanup).toHaveBeenCalledTimes(2);
    expect(publisher.publish).toHaveBeenCalledTimes(2);
  });
});
