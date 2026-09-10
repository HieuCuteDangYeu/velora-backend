import { RedisCallSessionRepository } from '../../../src/infrastructure/repositories/redis-call-session.repository';

describe('RedisCallSessionRepository', () => {
  it('uses a numeric Redis sorted-set cutoff while preserving an ISO lifecycle timestamp', async () => {
    const redis = {
      eval: jest.fn().mockResolvedValue([]),
    };
    const repository = new RedisCallSessionRepository(redis as never);
    const now = new Date('2026-09-07T00:00:00.000Z');

    await repository.expireDueCalls(now, 10);

    expect(redis.eval).toHaveBeenCalledWith(
      expect.stringContaining('local nowMs = ARGV[1]'),
      5,
      'call:sessions:expiring',
      'call:sessions:answer-events',
      'call:sessions:active',
      'call:sessions:active-by-user',
      'call:sessions:terminal-events',
      String(now.getTime()),
      now.toISOString(),
      '10',
      'call:',
      ':session',
    );
  });

  it('queues a terminal event in the same CAS transition as its tombstone', async () => {
    const redis = {
      eval: jest.fn().mockResolvedValue([
        'transitioned',
        JSON.stringify({
          callId: 'call-1',
          conversationId: 'conversation-1',
          initiatorId: 'user-a',
          targetUserId: 'user-b',
          callType: 'VOICE',
          status: 'cancelled',
          participantIds: ['user-a'],
          terminalReason: 'cancelled',
          terminalActorId: 'user-a',
          lifecycleRevision: 4,
          endedAt: '2026-09-07T00:00:00.000Z',
          createdAt: '2026-09-07T00:00:00.000Z',
          updatedAt: '2026-09-07T00:00:00.000Z',
        }),
        'cancelled',
        '0',
      ]),
    };
    const repository = new RedisCallSessionRepository(redis as never);
    const now = new Date('2026-09-07T00:00:00.000Z');

    await repository.transitionToTerminal(
      'call-1',
      'user-a',
      'cancelled',
      now,
      'leave',
    );

    expect(redis.eval).toHaveBeenCalledWith(
      expect.stringContaining('session.terminalEventPublishedAt = cjson.null'),
      6,
      'call:call-1:session',
      'call:sessions:expiring',
      'call:sessions:answer-events',
      'call:sessions:active',
      'call:sessions:active-by-user',
      'call:sessions:terminal-events',
      'user-a',
      'cancelled',
      now.toISOString(),
      'leave',
      String(now.getTime()),
      '',
    );
  });

  it('guards a media setup failure with the exact accepting action id', async () => {
    const redis = {
      eval: jest.fn().mockResolvedValue([
        'active',
        JSON.stringify({
          callId: 'call-1',
          conversationId: 'conversation-1',
          initiatorId: 'user-a',
          targetUserId: 'user-b',
          callType: 'VOICE',
          status: 'active',
          participantIds: ['user-a', 'user-b'],
          answerActionId: 'native-answer-1',
          createdAt: '2026-09-07T00:00:00.000Z',
          updatedAt: '2026-09-07T00:00:00.000Z',
        }),
        '',
        '1',
      ]),
    };
    const repository = new RedisCallSessionRepository(redis as never);
    const now = new Date('2026-09-07T00:00:00.000Z');

    await expect(
      repository.transitionToTerminal(
        'call-1',
        'user-b',
        'media_unavailable',
        now,
        'accept_failure',
        'native-answer-1',
      ),
    ).resolves.toEqual(
      expect.objectContaining({
        outcome: 'active',
        session: expect.objectContaining({ status: 'active' }),
        wasActive: true,
      }),
    );
    expect(redis.eval).toHaveBeenCalledWith(
      expect.stringContaining(
        "session.status ~= 'accepting' or session.answerActionId ~= expectedAnswerActionId",
      ),
      6,
      'call:call-1:session',
      'call:sessions:expiring',
      'call:sessions:answer-events',
      'call:sessions:active',
      'call:sessions:active-by-user',
      'call:sessions:terminal-events',
      'user-b',
      'media_unavailable',
      now.toISOString(),
      'accept_failure',
      String(now.getTime()),
      'native-answer-1',
    );
  });

  it('maps a leased terminal tombstone to its exact lifecycle event', async () => {
    const now = new Date('2026-09-07T00:00:00.000Z');
    const redis = {
      eval: jest.fn().mockResolvedValue([
        JSON.stringify({
          callId: 'call-1',
          conversationId: 'conversation-1',
          initiatorId: 'user-a',
          targetUserId: 'user-b',
          callType: 'VOICE',
          status: 'rejected',
          participantIds: ['user-a', 'user-b'],
          terminalReason: 'rejected',
          terminalActorId: 'user-b',
          lifecycleRevision: 4,
          endedAt: now.toISOString(),
          createdAt: now.toISOString(),
          updatedAt: now.toISOString(),
        }),
      ]),
    };
    const repository = new RedisCallSessionRepository(redis as never);

    await expect(
      repository.claimPendingTerminalEvents(now, 10),
    ).resolves.toEqual([
      expect.objectContaining({
        event: 'call.rejected',
        reason: 'rejected',
        userId: 'user-b',
      }),
    ]);
    expect(redis.eval).toHaveBeenCalledWith(
      expect.stringContaining('terminalEventPublishLeaseUntil'),
      1,
      'call:sessions:terminal-events',
      String(now.getTime()),
      now.toISOString(),
      String(now.getTime() + 10_000),
      new Date(now.getTime() + 10_000).toISOString(),
      '10',
      'call:',
      ':session',
    );
  });
});
