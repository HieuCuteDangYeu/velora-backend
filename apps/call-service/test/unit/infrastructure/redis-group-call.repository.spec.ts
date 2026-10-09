import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import Redis from 'ioredis';
import { ChangeCallTypeUseCase } from '../../../src/application/use-cases/change-call-type.use-case';
import { LeaveCallUseCase } from '../../../src/application/use-cases/leave-call.use-case';
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

  it('re-invites atomically with durable delivery, expiry and stale-action fencing', async () => {
    const callId = 'reinvite';
    const now = new Date();
    await repository.save(group(callId));
    const expiry = new Date(now.getTime() + 30_000);
    const invite = await repository.inviteGroupMember(
      callId,
      'host',
      'guest',
      'request-1',
      'invite-1',
      now,
      expiry,
    );
    expect(invite.outcome).toBe('sent');
    expect(
      await repository.inviteGroupMember(
        callId,
        'host',
        'guest',
        'request-1',
        'discarded-id',
        now,
        expiry,
      ),
    ).toMatchObject({ outcome: 'already_sent' });
    expect(
      await repository.inviteGroupMember(
        callId,
        'host',
        'guest',
        'request-2',
        'discarded-id',
        now,
        expiry,
      ),
    ).toMatchObject({ outcome: 'cooldown' });
    expect(await redis.zcard('call:sessions:group-invitation-events')).toBe(1);
    expect(
      (
        await repository.joinParticipant(
          callId,
          'guest',
          now,
          'stale-answer',
          false,
          callId,
        )
      ).outcome,
    ).toBe('invitation_expired');
    expect(
      (
        await repository.rejectGroupInvitation(
          callId,
          'guest',
          now,
          'rejected',
          callId,
        )
      ).outcome,
    ).toBe('terminal');
    expect(
      (
        await repository.rejectGroupInvitation(
          callId,
          'guest',
          now,
          'rejected',
          'invite-1',
        )
      ).outcome,
    ).toBe('rejected');
    const later = new Date(now.getTime() + 11_000);
    const second = await repository.inviteGroupMember(
      callId,
      'host',
      'guest',
      'request-2',
      'invite-2',
      later,
      new Date(later.getTime() + 30_000),
    );
    expect(second.outcome).toBe('sent');
    expect(second.session?.declinedUserIds).not.toContain('guest');
    expect(
      (
        await repository.rejectGroupInvitation(
          callId,
          'guest',
          later,
          'rejected',
          'invite-1',
        )
      ).outcome,
    ).toBe('terminal');
    const joining = await repository.joinParticipant(
      callId,
      'guest',
      later,
      'winner',
      false,
      'invite-2',
    );
    expect(joining.outcome).toBe('joined');
    await repository.confirmGroupInvitationJoin(
      callId,
      'guest',
      'winner',
      later,
    );
    expect(
      (await repository.findByCallId(callId))?.groupInvitations.guest.status,
    ).toBe('in_call');
    expect(
      (await repository.joinParticipant(callId, 'guest', later, 'winner'))
        .outcome,
    ).toBe('joined');
    expect(
      (await repository.findByCallId(callId))?.groupInvitations.guest.status,
    ).toBe('in_call');
    expect(
      (await repository.joinParticipant(callId, 'guest', later, 'other-device'))
        .outcome,
    ).not.toBe('joined');
    expect(
      (
        await repository.joinParticipant(
          callId,
          'guest',
          later,
          'winner',
          false,
          'invite-1',
        )
      ).outcome,
    ).toBe('invitation_expired');
    await repository.transitionToTerminal(
      callId,
      'guest',
      'left',
      later,
      'leave',
      'winner',
    );
    expect(
      (await repository.findByCallId(callId))?.groupInvitations.guest.status,
    ).toBe('left');
    const thirdTime = new Date(later.getTime() + 11_000);
    await repository.inviteGroupMember(
      callId,
      'host',
      'guest',
      'request-3',
      'invite-3',
      thirdTime,
      new Date(thirdTime.getTime() + 1000),
    );
    const expired = await repository.expireGroupInvitations(
      callId,
      new Date(thirdTime.getTime() + 1001),
    );
    expect(expired?.groupInvitations.guest.status).toBe('expired');
    expect(expired?.status).toBe('active');
    expect(expired?.participantIds).toEqual(['host']);
    const replayTime = new Date(thirdTime.getTime() + 11_000);
    expect(
      (
        await repository.inviteGroupMember(
          callId,
          'host',
          'guest',
          'request-1',
          'must-not-ring',
          replayTime,
          new Date(replayTime.getTime() + 30_000),
        )
      ).outcome,
    ).toBe('already_sent');
    expect(
      (await repository.findByCallId(callId))?.groupInvitations.guest
        .invitationId,
    ).toBe('invite-3');
    const events = await repository.claimPendingGroupInvitationEvents(
      new Date(thirdTime.getTime() + 2000),
      100,
    );
    expect(events).toContainEqual(
      expect.objectContaining({
        event: 'call.rejected',
        invitationId: 'invite-1',
      }),
    );
    expect(events).toContainEqual(
      expect.objectContaining({
        event: 'call.rejected',
        invitationId: 'invite-3',
        reason: 'timeout',
      }),
    );
    await repository.transitionToTerminal(
      callId,
      'host',
      'ended',
      thirdTime,
      'leave',
    );
    const terminal = await redis.get(`call:${callId}:session`);
    expect(
      (
        await repository.inviteGroupMember(
          callId,
          'host',
          'guest',
          'late-request',
          'late-id',
          thirdTime,
          expiry,
        )
      ).outcome,
    ).toBe('terminal');
    expect(await redis.get(`call:${callId}:session`)).toBe(terminal);
  });

  it('gives late joiners a private native identity and closes the earlier ringing invitation', async () => {
    const callId = 'late-after-ring',
      now = new Date();
    await repository.save(group(callId));
    await repository.inviteGroupMember(
      callId,
      'host',
      'guest',
      'old-request',
      'old-native',
      now,
      new Date(now.getTime() + 30_000),
    );
    const joined = await repository.joinParticipant(
      callId,
      'guest',
      now,
      'winner-secret',
      true,
      'late-native',
    );
    expect(joined.outcome).toBe('joined');
    expect(joined.session?.groupInvitations.guest.invitationId).toBe(
      'late-native',
    );
    await repository.confirmGroupInvitationJoin(
      callId,
      'guest',
      'winner-secret',
      now,
    );
    expect(
      (await repository.joinParticipant(callId, 'guest', now, 'winner-secret'))
        .outcome,
    ).toBe('joined');
    expect(
      (
        await repository.joinParticipant(
          callId,
          'guest',
          now,
          'winner-secret',
          false,
          'old-native',
        )
      ).outcome,
    ).toBe('invitation_expired');
    expect(
      await repository.claimPendingGroupInvitationEvents(now, 100),
    ).toContainEqual(
      expect.objectContaining({
        event: 'call.rejected',
        invitationId: 'old-native',
        reason: 'answered_elsewhere',
      }),
    );
  });

  it('updates only live group identity and fences stale or terminal snapshots', async () => {
    const callId = 'identity-cas';
    await repository.save(
      new CallSession({
        ...group(callId),
        groupAvatarUrl: 'old-avatar',
        lifecycleRevision: 7,
      }),
    );
    const now = new Date();
    const updated = await repository.refreshGroupIdentity(
      callId,
      0,
      'Renamed',
      null,
      now,
    );
    expect(updated).toMatchObject({
      groupName: 'Renamed',
      groupIdentityRevision: 1,
      lifecycleRevision: 7,
      status: 'active',
      participantIds: ['host'],
    });
    expect(updated?.groupAvatarUrl).toBeUndefined();
    expect(await redis.hget('call:sessions:active-by-user', 'host')).toBe(
      callId,
    );
    expect(
      await repository.refreshGroupIdentity(
        callId,
        0,
        'Stale',
        'stale-avatar',
        now,
      ),
    ).toBeNull();
    // Lost reply or socket event: repeating the authoritative value returns its current revision.
    expect(
      await repository.refreshGroupIdentity(callId, 0, 'Renamed', null, now),
    ).toMatchObject({ groupIdentityRevision: 1 });
    await repository.transitionToTerminal(
      callId,
      'host',
      'ended',
      now,
      'leave',
    );
    const before = await redis.get(`call:${callId}:session`);
    expect(
      await repository.refreshGroupIdentity(callId, 1, 'After end', null, now),
    ).toBeNull();
    expect(await redis.get(`call:${callId}:session`)).toBe(before);
    expect(
      await redis.zscore('call:sessions:terminal-events', callId),
    ).not.toBeNull();
    await repository.save(
      new CallSession({ ...group('direct'), isGroupCall: false }),
    );
    expect(
      await repository.refreshGroupIdentity('direct', 0, 'Wrong', null, now),
    ).toBeNull();
  });

  it('keeps the real terminal tombstone, released reservations and outbox when video cleanup races a hangup', async () => {
    const callId = 'video-hangup';
    await repository.save(
      new CallSession({
        ...group(callId),
        isGroupCall: false,
        callType: 'VIDEO',
        participantIds: ['host', 'guest'],
        lifecycleRevision: 5,
      }),
    );
    let releaseClose!: () => void;
    let enteredClose!: () => void;
    const entered = new Promise<void>((resolve) => {
      enteredClose = resolve;
    });
    const changing = new ChangeCallTypeUseCase(repository, {
      listActiveProducers: jest
        .fn()
        .mockResolvedValue([
          { producerId: 'video', userId: 'host', kind: 'video' },
        ]),
      closeProducer: jest.fn(
        () =>
          new Promise<void>((resolve) => {
            releaseClose = resolve;
            enteredClose();
          }),
      ),
    } as never).execute(callId, 'host', 'VOICE');
    await entered;
    const terminal = await repository.transitionToTerminal(
      callId,
      'host',
      'ended',
      new Date(),
      'leave',
    );
    expect(terminal.outcome).toBe('transitioned');
    releaseClose();
    await expect(changing).rejects.toThrow('Call changed');
    expect((await repository.findByCallId(callId))?.status).toBe('ended');
    expect((await repository.findByCallId(callId))?.lifecycleRevision).toBe(6);
    expect(await redis.hget('call:sessions:active-by-user', 'host')).toBeNull();
    expect(
      await redis.hget('call:sessions:active-by-user', 'guest'),
    ).toBeNull();
    expect(
      await redis.zscore('call:sessions:terminal-events', callId),
    ).not.toBeNull();
  });

  it('changes only the current call type with authorization and revision fencing', async () => {
    const callId = 'type-cas';
    await repository.save(
      new CallSession({
        ...group(callId),
        isGroupCall: false,
        lifecycleRevision: 4,
      }),
    );
    const now = new Date();
    expect(
      await repository.changeCallType(callId, 'outsider', 4, 'VIDEO', now),
    ).toBe(false);
    expect(
      await repository.changeCallType(callId, 'host', 3, 'VIDEO', now),
    ).toBe(false);
    expect(
      await repository.changeCallType(
        callId,
        'host',
        4,
        'INVALID' as never,
        now,
      ),
    ).toBe(false);
    expect(
      await repository.changeCallType(callId, 'host', 4, 'VIDEO', now),
    ).toBe(true);
    expect(
      await repository.changeCallType(callId, 'host', 4, 'VIDEO', now),
    ).toBe(true);
    const updated = await repository.findByCallId(callId);
    expect(updated).toMatchObject({
      status: 'active',
      callType: 'VIDEO',
      lifecycleRevision: 5,
      participantIds: ['host'],
    });
    expect(await redis.hget('call:sessions:active-by-user', 'host')).toBe(
      callId,
    );
    expect(
      await redis.zscore('call:sessions:terminal-events', callId),
    ).toBeNull();
    expect(
      await repository.changeCallType('missing', 'host', 0, 'VIDEO', now),
    ).toBe(false);
    await repository.createActiveGroupSession(
      group('voice-only', 'another-host'),
    );
    expect(
      await repository.changeCallType(
        'voice-only',
        'another-host',
        0,
        'VIDEO',
        now,
      ),
    ).toBe(false);
  });

  it('recovers an ordinary guest leave whose real Redis CAS reply was lost, without evicting other guests', async () => {
    const callId = 'lost-guest-reply';
    await repository.createActiveGroupSession(group(callId));
    for (const userId of ['guest', 'other'])
      await repository.joinParticipant(
        callId,
        userId,
        new Date(),
        `${userId}-answer`,
      );
    const closeParticipant = jest.fn().mockResolvedValue({ producers: [] });
    const useCase = new LeaveCallUseCase(
      repository,
      new RedisCallStateRepository(redis),
      { publish: jest.fn() },
      { closeParticipant } as never,
    );
    const originalTransition = repository.transitionToTerminal;
    const spy = jest
      .spyOn(repository, 'transitionToTerminal')
      .mockImplementationOnce(async (...args) => {
        await originalTransition.call(repository, ...args);
        throw new Error('committed response lost');
      });
    await expect(useCase.execute(callId, 'guest')).rejects.toThrow(
      'committed response lost',
    );
    expect(closeParticipant).not.toHaveBeenCalled();
    await expect(useCase.execute(callId, 'guest')).resolves.toMatchObject({
      shouldEmitPeerLeft: true,
    });
    expect(closeParticipant).toHaveBeenCalledWith(callId, 'guest');
    expect((await repository.findByCallId(callId))?.participantIds).toEqual([
      'host',
      'other',
    ]);
    await expect(useCase.execute(callId, 'outsider')).rejects.toThrow(
      'not part',
    );
    expect(closeParticipant).toHaveBeenCalledTimes(1);
    spy.mockRestore();
  });

  it('atomically revokes live and pending guests with a durable recipient-only notification', async () => {
    await repository.createActiveGroupSession(group('membership-room'));
    await repository.joinParticipant(
      'membership-room',
      'guest',
      new Date(),
      'winner',
    );
    await repository.confirmGroupInvitationJoin(
      'membership-room',
      'guest',
      'winner',
      new Date(),
    );
    const state = new RedisCallStateRepository(redis);
    await state.upsertParticipant(
      new CallParticipant({
        callId: 'membership-room',
        userId: 'guest',
        socketId: 'guest-socket',
        isConnected: true,
      }),
    );
    await state.saveProducerState({
      callId: 'membership-room',
      userId: 'guest',
      producerId: 'guest-audio',
      transportId: 'guest-send',
      kind: 'audio',
    });

    for (const userId of ['guest', 'other']) {
      const result = await repository.transitionToTerminal(
        'membership-room',
        userId,
        'membership_removed',
        new Date(),
        'membership_removed',
      );
      expect(result.outcome).toBe('participant_left');
      expect(result.session?.status).toBe('active');
      expect(result.session?.participantIds).toEqual(['host']);
    }
    expect(
      await redis.hget('call:membership-room:participants', 'guest'),
    ).toBeNull();
    expect(
      await redis.get('call:membership-room:producer:guest-audio'),
    ).toBeNull();
    expect(
      await redis.hget('call:sessions:active-by-user', 'guest'),
    ).toBeNull();
    expect(
      (await repository.findByCallId('membership-room'))?.groupAnswerActionIds
        .guest,
    ).toBeUndefined();
    const notifications = await repository.claimPendingGroupInvitationEvents(
      new Date(),
      100,
    );
    expect(
      notifications.filter((event) => event.event === 'call.rejected'),
    ).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          userId: 'guest',
          reason: 'membership_removed',
        }),
        expect.objectContaining({
          userId: 'other',
          reason: 'membership_removed',
        }),
      ]),
    );
    expect(
      (
        await repository.transitionToTerminal(
          'membership-room',
          'guest',
          'membership_removed',
          new Date(),
          'membership_removed',
        )
      ).outcome,
    ).toBe('already_terminal');
    expect(
      await repository.claimPendingGroupInvitationEvents(new Date(), 100),
    ).toEqual([]);
  });

  it('keeps an uninvited late joiner eligible for idempotent revocation cleanup', async () => {
    const callId = 'late-member-retry';
    await repository.createActiveGroupSession(group(callId));
    expect(
      (
        await repository.joinParticipant(
          callId,
          'late',
          new Date(),
          'late-action',
          true,
        )
      ).outcome,
    ).toBe('joined');
    const revoke = () =>
      repository.transitionToTerminal(
        callId,
        'late',
        'membership_removed',
        new Date(),
        'membership_removed',
      );
    expect((await revoke()).outcome).toBe('participant_left');
    expect(
      (await repository.findByCallId(callId))?.invitedUserIds,
    ).not.toContain('late');
    expect((await revoke()).outcome).toBe('already_terminal');
    expect(await redis.zcard('call:sessions:group-invitation-events')).toBe(1);
  });

  it('finds one live group room per conversation and ignores terminal pointers', async () => {
    expect(await repository.createActiveGroupSession(group('room-first'))).toBe(
      true,
    );
    expect(
      await repository.createActiveGroupSession(group('room-second', 'other')),
    ).toBe(false);
    expect(
      (await repository.findActiveGroupCallByConversationId('conversation'))
        ?.callId,
    ).toBe('room-first');

    expect(
      (
        await repository.joinParticipant(
          'room-first',
          'guest',
          new Date(),
          'guest-action',
        )
      ).outcome,
    ).toBe('joined');
    expect(
      (await repository.findActiveGroupCallByConversationId('conversation'))
        ?.participantIds,
    ).toEqual(['host', 'guest']);
    expect(
      (
        await repository.transitionToTerminal(
          'room-first',
          'guest',
          'left',
          new Date(),
          'leave',
        )
      ).outcome,
    ).toBe('participant_left');
    expect(
      (await repository.findActiveGroupCallByConversationId('conversation'))
        ?.participantIds,
    ).toEqual(['host']);

    await repository.transitionToTerminal(
      'room-first',
      'host',
      'ended',
      new Date(),
      'leave',
    );
    expect(
      await repository.findActiveGroupCallByConversationId('conversation'),
    ).toBeNull();
    expect(
      await repository.createActiveGroupSession(group('room-second', 'other')),
    ).toBe(true);
    expect(
      (await repository.findActiveGroupCallByConversationId('conversation'))
        ?.callId,
    ).toBe('room-second');
  });

  it('scans only active group sessions and skips stale/direct entries', async () => {
    await repository.createActiveGroupSession(group('live-group'));
    await repository.save(
      new CallSession({ ...group('direct'), isGroupCall: false }),
    );
    await redis.zadd('call:sessions:active', Date.now(), 'missing');
    const result = await repository.scanActiveGroupCalls('0');
    expect(result.cursor).toBe('0');
    expect(result.sessions.map((session) => session.callId)).toEqual([
      'live-group',
    ]);
  });

  it('does not partially revoke a guest when the durable notification index is corrupt', async () => {
    await repository.createActiveGroupSession(group('corrupt-outbox'));
    await repository.joinParticipant(
      'corrupt-outbox',
      'guest',
      new Date(),
      'winner',
    );
    await redis.set('call:sessions:group-invitation-events', 'wrong-type');
    await expect(
      repository.transitionToTerminal(
        'corrupt-outbox',
        'guest',
        'membership_removed',
        new Date(),
        'membership_removed',
      ),
    ).rejects.toThrow('Invalid group invitation outbox type');
    expect(
      (await repository.findByCallId('corrupt-outbox'))?.participantIds,
    ).toContain('guest');
  });

  it('admits an explicit late join once, isolates its winning device, and enforces capacity', async () => {
    await repository.createActiveGroupSession(group('room-late'));
    expect(
      (
        await repository.joinParticipant(
          'room-late',
          'new-member',
          new Date(),
          'late-1',
        )
      ).outcome,
    ).toBe('forbidden');
    const first = await repository.joinParticipant(
      'room-late',
      'new-member',
      new Date(),
      'late-1',
      true,
    );
    expect(first.outcome).toBe('joined');
    expect(first.joinedNow).toBe(true);
    const replay = await repository.joinParticipant(
      'room-late',
      'new-member',
      new Date(),
      'late-1',
      true,
    );
    expect(replay.outcome).toBe('joined');
    expect(replay.joinedNow).toBe(false);
    expect(
      (
        await repository.joinParticipant(
          'room-late',
          'new-member',
          new Date(),
          'losing-device',
          true,
        )
      ).outcome,
    ).toBe('answered_elsewhere');
    for (let index = 2; index < 8; index++) {
      expect(
        (
          await repository.joinParticipant(
            'room-late',
            `late-${index}`,
            new Date(),
            `action-${index}`,
            true,
          )
        ).outcome,
      ).toBe('joined');
    }
    expect(
      (
        await repository.joinParticipant(
          'room-late',
          'over-capacity',
          new Date(),
          'action-over',
          true,
        )
      ).outcome,
    ).toBe('full');
    expect(
      (await repository.findByCallId('room-late'))?.participantIds,
    ).toHaveLength(8);
  });

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

    // The starter has no special authority: leaving only removes them, the
    // room stays up for the member who is still in it.
    const hostLeave = await repository.transitionToTerminal(
      'room-leave',
      'host',
      'left',
      new Date(),
      'leave',
    );
    expect(hostLeave.outcome).toBe('participant_left');
    expect(hostLeave.session?.status).toBe('active');
    expect(hostLeave.session?.participantIds).toEqual(['other']);
    expect(await redis.hget('call:sessions:active-by-user', 'host')).toBeNull();
    expect(await redis.hget('call:sessions:active-by-user', 'other')).toBe(
      'room-leave',
    );

    // Only the last member out ends the call.
    const lastLeave = await repository.transitionToTerminal(
      'room-leave',
      'other',
      'left',
      new Date(),
      'leave',
    );
    expect(lastLeave.outcome).toBe('transitioned');
    expect(lastLeave.session?.status).toBe('ended');
    expect(await state.getParticipants('room-leave')).toEqual([]);
    expect(
      await redis.hget('call:sessions:active-by-user', 'other'),
    ).toBeNull();
  });

  it('ends the room exactly once and releases every active index when the last two members leave concurrently', async () => {
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

    const outcomes = (
      await Promise.all(
        ['host', 'guest'].map((userId) =>
          repository.transitionToTerminal(
            'room-terminal-race',
            userId,
            'left',
            new Date(),
            'leave',
          ),
        ),
      )
    ).map((result) => result.outcome);

    expect([...outcomes].sort()).toEqual(['participant_left', 'transitioned']);
    expect((await repository.findByCallId('room-terminal-race'))?.status).toBe(
      'ended',
    );
    for (const userId of ['host', 'guest', 'other']) {
      expect(
        await redis.hget('call:sessions:active-by-user', userId),
      ).toBeNull();
    }
  });

  describe('a group call has no host', () => {
    const joinAndConfirm = async (callId: string, userId: string) => {
      const answer = `${userId}-answer`;
      const joined = await repository.joinParticipant(
        callId,
        userId,
        new Date(),
        answer,
      );
      expect(joined.outcome).toBe('joined');
      expect(
        await repository.confirmGroupInvitationJoin(
          callId,
          userId,
          answer,
          new Date(),
        ),
      ).toBe(true);
    };

    it('lets the starter leave without ending the call for the others', async () => {
      await repository.createActiveGroupSession(group('no-host-leave'));
      await joinAndConfirm('no-host-leave', 'guest');

      const left = await repository.transitionToTerminal(
        'no-host-leave',
        'host',
        'disconnected',
        new Date(),
        'leave',
      );

      expect(left.outcome).toBe('participant_left');
      expect(left.session?.status).toBe('active');
      expect(left.session?.participantIds).toEqual(['guest']);
      expect(
        await redis.hget('call:sessions:active-by-user', 'host'),
      ).toBeNull();
    });

    it('lets a starter who left join late and confirm like any other member', async () => {
      await repository.createActiveGroupSession(group('no-host-rejoin'));
      await joinAndConfirm('no-host-rejoin', 'guest');
      await repository.transitionToTerminal(
        'no-host-rejoin',
        'host',
        'left',
        new Date(),
        'leave',
      );

      const late = await repository.joinParticipant(
        'no-host-rejoin',
        'host',
        new Date(),
        'host-late',
        true,
        'late-invitation',
      );
      expect(late.outcome).toBe('joined');
      expect(late.joinedNow).toBe(true);
      expect(
        await repository.confirmGroupInvitationJoin(
          'no-host-rejoin',
          'host',
          'host-late',
          new Date(),
        ),
      ).toBe(true);

      const session = await repository.findByCallId('no-host-rejoin');
      expect(session?.participantIds.sort()).toEqual(['guest', 'host']);
      expect(session?.groupConfirmedAnswerActionIds.host).toBe('host-late');
      expect(session?.declinedUserIds).not.toContain('host');
      expect(await redis.hget('call:sessions:active-by-user', 'host')).toBe(
        'no-host-rejoin',
      );
    });

    it('treats a starter who left like any member who left, but keeps reconnect working while the seat is occupied', async () => {
      await repository.createActiveGroupSession(group('no-host-proof'));
      await joinAndConfirm('no-host-proof', 'guest');

      // Reconnecting the original seat keeps working without an action id.
      const reconnect = await repository.joinParticipant(
        'no-host-proof',
        'host',
        new Date(),
      );
      expect(reconnect.outcome).toBe('joined');
      expect(reconnect.joinedNow).toBe(false);

      await repository.transitionToTerminal(
        'no-host-proof',
        'host',
        'left',
        new Date(),
        'leave',
      );
      // Same outcome a guest who left gets without the late-join flow.
      const withoutLateJoin = await repository.joinParticipant(
        'no-host-proof',
        'host',
        new Date(),
      );
      expect(withoutLateJoin.outcome).toBe('declined');
    });

    it('ends the call when the last participant is removed from the group', async () => {
      await repository.createActiveGroupSession(group('no-host-removed'));
      await joinAndConfirm('no-host-removed', 'guest');

      const first = await repository.transitionToTerminal(
        'no-host-removed',
        'guest',
        'membership_removed',
        new Date(),
        'membership_removed',
      );
      expect(first.outcome).toBe('participant_left');

      const last = await repository.transitionToTerminal(
        'no-host-removed',
        'host',
        'membership_removed',
        new Date(),
        'membership_removed',
      );
      expect(last.outcome).toBe('transitioned');
      expect(last.session?.status).toBe('ended');
      expect(last.session?.terminalReason).toBe('membership_removed');
      expect(
        await redis.hget('call:sessions:active-by-user', 'host'),
      ).toBeNull();
    });
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

  it('removes only the matching router after an ambiguous room save', async () => {
    const stateRepository = new RedisCallStateRepository(redis);
    await stateRepository.saveRoom({
      callId: 'ambiguous-room',
      routerId: 'router-new',
      workerId: 'worker-new',
    });

    await stateRepository.removeRoomIfRouterId('ambiguous-room', 'router-old');
    expect((await stateRepository.getRoom('ambiguous-room'))?.routerId).toBe(
      'router-new',
    );

    await stateRepository.removeRoomIfRouterId('ambiguous-room', 'router-new');
    expect(await stateRepository.getRoom('ambiguous-room')).toBeNull();
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
    const outbox = new PublishCallTerminalOutboxUseCase(
      repository,
      publisher,
      {
        clearCallState: cleanup,
      } as never,
      { closeRoom: jest.fn().mockResolvedValue(undefined) } as never,
    );

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
