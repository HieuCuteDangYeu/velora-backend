import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import Redis from 'ioredis';
import { CallSession } from '../../../src/domain/entities/call-session.entity';
import { RedisCallSessionRepository } from '../../../src/infrastructure/repositories/redis-call-session.repository';

const redisAvailable = spawnSync('redis-server', ['--version']).status === 0;
const describeWithRedis = redisAvailable ? describe : describe.skip;

/** Deterministic PRNG so a failing seed reproduces exactly. */
const createRandom = (seed: number) => () => {
  seed = (seed + 0x6d2b79f5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};

const USERS = ['host', 'u1', 'u2', 'u3', 'u4', 'u5', 'u6'];
const EPOCH = Date.parse('2026-01-01T00:00:00.000Z');

/**
 * Drives random group-call lifecycles through the real Redis scripts and checks
 * the properties users feel when they break: nobody stuck "busy", nobody shown
 * as in a call they left, no empty call left running, and the call ending when
 * - and only when - the last participant goes.
 */
describeWithRedis('Redis group-call invariants under random lifecycles', () => {
  let server: ChildProcess;
  let redis: Redis;
  let repository: RedisCallSessionRepository;
  let directory: string;

  beforeAll(async () => {
    // Unix socket paths are short on macOS; os.tmpdir() can exceed that limit.
    directory = mkdtempSync('/tmp/velora-invariants-redis-');
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
    redis = new Redis({ path: socket, lazyConnect: true });
    await redis.connect();
    repository = new RedisCallSessionRepository(redis);
  });

  afterAll(async () => {
    if (redis?.status === 'ready') await redis.quit();
    if (server && server.exitCode === null && server.signalCode === null) {
      server.kill();
      await once(server, 'exit');
    }
    if (directory) rmSync(directory, { recursive: true, force: true });
  });

  const readSessions = async () => {
    const sessions: CallSession[] = [];
    for (const key of await redis.keys('call:*:session')) {
      const raw = await redis.get(key);
      if (raw)
        sessions.push(new CallSession(JSON.parse(raw) as Partial<CallSession>));
    }
    return sessions;
  };

  const violations = async (lastRevision: Map<string, number>) => {
    const problems: string[] = [];
    const sessions = await readSessions();
    const busyIndex = await redis.hgetall('call:sessions:active-by-user');
    const activeCallsByUser = new Map<string, string[]>();

    for (const session of sessions) {
      const previous = lastRevision.get(session.callId) ?? -1;
      if (session.lifecycleRevision < previous) {
        problems.push(`revision went backwards in ${session.callId}`);
      }
      lastRevision.set(session.callId, session.lifecycleRevision);
      if (
        new Set(session.participantIds).size !== session.participantIds.length
      ) {
        problems.push(`duplicate participants in ${session.callId}`);
      }
      if (session.status !== 'active') continue;

      if (session.participantIds.length === 0) {
        problems.push(`active call with nobody in it ${session.callId}`);
      }
      if (session.participantIds.length > 8) {
        problems.push(`participant cap exceeded in ${session.callId}`);
      }
      for (const userId of session.participantIds) {
        activeCallsByUser.set(userId, [
          ...(activeCallsByUser.get(userId) ?? []),
          session.callId,
        ]);
        if (busyIndex[userId] !== session.callId) {
          problems.push(
            `${userId} is in ${session.callId} but not marked busy for it`,
          );
        }
        if (session.declinedUserIds.includes(userId)) {
          problems.push(`${userId} is both departed and in ${session.callId}`);
        }
        const invitation = session.groupInvitations[userId];
        if (
          invitation &&
          invitation.status !== 'joining' &&
          invitation.status !== 'in_call'
        ) {
          problems.push(
            `${userId} is in ${session.callId} but invitation says ${invitation.status}`,
          );
        }
      }
      for (const [userId, invitation] of Object.entries(
        session.groupInvitations,
      )) {
        if (
          invitation.status === 'in_call' &&
          !session.participantIds.includes(userId)
        ) {
          problems.push(
            `${userId} shown in call ${session.callId} after leaving`,
          );
        }
      }
    }

    for (const [userId, callIds] of activeCallsByUser) {
      if (callIds.length > 1) {
        problems.push(`${userId} is in ${callIds.length} active calls at once`);
      }
    }
    for (const [userId, callId] of Object.entries(busyIndex)) {
      const session = sessions.find((candidate) => candidate.callId === callId);
      if (
        session?.status === 'active' &&
        !session.participantIds.includes(userId)
      ) {
        problems.push(`${userId} is marked busy for ${callId} but not in it`);
      }
    }
    return problems;
  };

  const runSeed = async (seed: number, steps: number): Promise<string[]> => {
    await redis.flushdb();
    const random = createRandom(seed);
    const pick = <T>(items: T[]) => items[Math.floor(random() * items.length)];
    const trace: string[] = [];
    const lastRevision = new Map<string, number>();
    const calls: string[] = [];
    let now = EPOCH;
    let counter = 0;

    const startCall = async (hostId: string, conversationId: string) => {
      const callId = `c${++counter}`;
      const invited = USERS.filter((id) => id !== hostId && random() < 0.8);
      if (invited.length === 0) return;
      const createdAt = new Date(now);
      const expiresAt = new Date(now + 30_000);
      const created = await repository.createActiveGroupSession(
        new CallSession({
          callId,
          conversationId,
          initiatorId: hostId,
          targetUserId: invited[0],
          isGroupCall: true,
          invitedUserIds: [hostId, ...invited],
          groupName: 'Group',
          callType: 'VOICE',
          status: 'active',
          participantIds: [hostId],
          answeredAt: createdAt,
          expiresAt,
          createdAt,
          updatedAt: createdAt,
          groupInvitations: Object.fromEntries(
            invited.map((id) => [
              id,
              {
                invitationId: callId,
                expiresAt: expiresAt.toISOString(),
                sentAt: createdAt.toISOString(),
                status: 'ringing' as const,
              },
            ]),
          ),
        }),
      );
      trace.push(`start ${callId} by ${hostId} -> ${created}`);
      if (created) calls.push(callId);
    };

    for (let step = 0; step < steps; step++) {
      const at = new Date(now);
      const roll = random();
      const callId = calls.length ? pick(calls) : undefined;
      const userId = pick(USERS);
      try {
        if (!callId || roll < 0.08) {
          await startCall(
            pick(USERS),
            `conversation-${1 + Math.floor(random() * 2)}`,
          );
        } else if (roll < 0.3) {
          const session = await repository.findByCallId(callId);
          const invitationId = session?.groupInvitations[userId]?.invitationId;
          const actionId = `answer-${++counter}`;
          const result = await repository.joinParticipant(
            callId,
            userId,
            at,
            actionId,
            false,
            invitationId,
          );
          trace.push(`accept ${callId} ${userId} -> ${result.outcome}`);
          if (result.outcome === 'joined') {
            const confirmed =
              random() < 0.15
                ? !(await repository.abortGroupInvitationJoin(
                    callId,
                    userId,
                    actionId,
                    at,
                  ))
                : await repository.confirmGroupInvitationJoin(
                    callId,
                    userId,
                    actionId,
                    at,
                  );
            trace.push(`  ${confirmed ? 'confirmed' : 'aborted'}`);
          }
        } else if (roll < 0.42) {
          const actionId = `late-${++counter}`;
          const result = await repository.joinParticipant(
            callId,
            userId,
            at,
            actionId,
            true,
            `late-invitation-${counter}`,
          );
          trace.push(`late-join ${callId} ${userId} -> ${result.outcome}`);
          if (result.outcome === 'joined') {
            await repository.confirmGroupInvitationJoin(
              callId,
              userId,
              actionId,
              at,
            );
          }
        } else if (roll < 0.54) {
          const session = await repository.findByCallId(callId);
          const result = await repository.rejectGroupInvitation(
            callId,
            userId,
            at,
            'rejected',
            session?.groupInvitations[userId]?.invitationId,
          );
          trace.push(`decline ${callId} ${userId} -> ${result.outcome}`);
        } else if (roll < 0.68) {
          const before = await repository.findByCallId(callId);
          const result = await repository.transitionToTerminal(
            callId,
            userId,
            'left',
            at,
            'leave',
          );
          trace.push(`leave ${callId} ${userId} -> ${result.outcome}`);
          const wasLast =
            before?.status === 'active' &&
            before.participantIds.length === 1 &&
            before.participantIds[0] === userId;
          if (wasLast && result.outcome !== 'transitioned') {
            trace.push('!! the last participant left but the call did not end');
            return trace;
          }
          const stillOthers =
            before?.status === 'active' &&
            before.participantIds.some((id) => id !== userId) &&
            before.participantIds.includes(userId);
          if (stillOthers && result.outcome === 'transitioned') {
            trace.push('!! the call ended while other participants remained');
            return trace;
          }
        } else if (roll < 0.74) {
          const result = await repository.transitionToTerminal(
            callId,
            userId,
            'membership_removed',
            at,
            'membership_removed',
          );
          trace.push(`removed ${callId} ${userId} -> ${result.outcome}`);
        } else if (roll < 0.84) {
          const session = await repository.findByCallId(callId);
          const actor = session?.participantIds.length
            ? pick(session.participantIds)
            : 'host';
          const result = await repository.inviteGroupMember(
            callId,
            actor,
            userId,
            `request-${++counter}`,
            `invite-${counter}`,
            at,
            new Date(now + 30_000),
          );
          trace.push(
            `invite ${callId} ${actor}->${userId} -> ${result.outcome}`,
          );
        } else if (roll < 0.94) {
          now += Math.floor(random() * 45_000);
          await repository.expireGroupInvitations(callId, new Date(now));
          trace.push(`time +${now - EPOCH}ms, expire ${callId}`);
        } else if (roll < 0.97) {
          const before = await repository.findByCallId(callId);
          const result = await repository.transitionToTerminal(
            callId,
            before?.initiatorId ?? 'host',
            'media_unavailable',
            at,
            'media_lost',
          );
          trace.push(`media lost ${callId} -> ${result.outcome}`);
          if (
            before?.status === 'active' &&
            result.outcome !== 'transitioned'
          ) {
            trace.push('!! media loss left an active call running');
            return trace;
          }
        } else {
          const ended = await repository.terminateActiveCallsForMediaRestart(
            at,
            100,
          );
          trace.push(`media restart ended ${ended.length}`);
        }
      } catch (error) {
        trace.push(`error ${(error as Error).message}`);
      }
      const problems = await violations(lastRevision);
      if (problems.length > 0)
        return [...trace.slice(-12), ...problems.map((p) => `!! ${p}`)];
    }
    return [];
  };

  it('detects a planted inconsistency, so a clean run means something', async () => {
    await redis.flushdb();
    const createdAt = new Date(EPOCH);
    const expiresAt = new Date(EPOCH + 30_000).toISOString();
    expect(
      await repository.createActiveGroupSession(
        new CallSession({
          callId: 'planted',
          conversationId: 'conversation',
          initiatorId: 'host',
          targetUserId: 'u1',
          isGroupCall: true,
          invitedUserIds: ['host', 'u1'],
          callType: 'VOICE',
          status: 'active',
          participantIds: ['host'],
          createdAt,
          updatedAt: createdAt,
          expiresAt: new Date(expiresAt),
          groupInvitations: {
            u1: {
              invitationId: 'planted',
              expiresAt,
              sentAt: createdAt.toISOString(),
              status: 'ringing',
            },
          },
        }),
      ),
    ).toBe(true);
    expect(await violations(new Map())).toEqual([]);

    await redis.hset('call:sessions:active-by-user', 'u1', 'planted');
    const stored = JSON.parse((await redis.get('call:planted:session'))!);
    stored.groupInvitations.u1.status = 'in_call';
    await redis.set('call:planted:session', JSON.stringify(stored));

    const found = await violations(new Map());
    expect(found.some((problem) => problem.includes('marked busy'))).toBe(true);
    expect(found.some((problem) => problem.includes('after leaving'))).toBe(
      true,
    );
  });

  it('keeps every invariant across 150 random lifecycles', async () => {
    const failures: string[] = [];
    for (let seed = 1; seed <= 150 && failures.length === 0; seed++) {
      const failure = await runSeed(seed, 60);
      if (failure.length > 0)
        failures.push(`seed ${seed}:\n${failure.join('\n')}`);
    }
    expect(failures).toEqual([]);
  }, 120_000);
});
