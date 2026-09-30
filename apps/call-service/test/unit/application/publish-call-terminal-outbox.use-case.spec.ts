import { PublishCallTerminalOutboxUseCase } from '../../../src/application/use-cases/publish-call-terminal-outbox.use-case';
import { CallSession } from '../../../src/domain/entities/call-session.entity';
import { RabbitCallEventPublisher } from '../../../src/infrastructure/publishers/rabbit-call-event.publisher';
import { of, Subject } from 'rxjs';

describe('PublishCallTerminalOutboxUseCase', () => {
  const endedAt = new Date('2026-09-07T04:00:00.000Z');

  const createTerminalSession = (
    callId: string,
    status: 'cancelled' | 'ended' | 'rejected',
    terminalReason: string,
    terminalActorId: string,
  ) =>
    new CallSession({
      callId,
      conversationId: `conversation-${callId}`,
      initiatorId: 'user-a',
      targetUserId: 'user-b',
      callType: 'VOICE',
      status,
      participantIds: ['user-a', 'user-b'],
      terminalReason,
      terminalActorId,
      lifecycleRevision: 7,
      endedAt,
      createdAt: endedAt,
      updatedAt: endedAt,
    });

  it('continues after one terminal event cannot be published', async () => {
    const failedSession = createTerminalSession(
      'call-failed',
      'cancelled',
      'cancelled',
      'user-a',
    );
    const rejectedSession = createTerminalSession(
      'call-rejected',
      'rejected',
      'rejected',
      'user-b',
    );
    const sessionRepository = {
      claimPendingTerminalEvents: jest.fn().mockResolvedValue([
        {
          session: failedSession,
          event: 'call.ended',
          reason: 'cancelled',
          userId: 'user-a',
        },
        {
          session: rejectedSession,
          event: 'call.rejected',
          reason: 'rejected',
          userId: 'user-b',
        },
      ]),
      markTerminalEventPublished: jest.fn(),
    };
    const eventPublisher = {
      publish: jest
        .fn()
        .mockRejectedValueOnce(new Error('broker unavailable'))
        .mockResolvedValueOnce(undefined),
    };
    const useCase = new PublishCallTerminalOutboxUseCase(
      sessionRepository as never,
      eventPublisher,
      { clearCallState: jest.fn().mockResolvedValue(undefined) } as never,
      { closeRoom: jest.fn().mockResolvedValue(undefined) } as never,
    );

    await expect(useCase.execute(endedAt)).resolves.toBe(2);

    expect(eventPublisher.publish).toHaveBeenNthCalledWith(
      1,
      'call.ended',
      expect.objectContaining({
        callId: 'call-failed',
        reason: 'cancelled',
        userId: 'user-a',
        lifecycleRevision: 7,
      }),
    );
    expect(eventPublisher.publish).toHaveBeenNthCalledWith(
      2,
      'call.rejected',
      expect.objectContaining({
        callId: 'call-rejected',
        reason: 'rejected',
        userId: 'user-b',
        lifecycleRevision: 7,
      }),
    );
    expect(sessionRepository.markTerminalEventPublished).toHaveBeenCalledTimes(
      1,
    );
    expect(sessionRepository.markTerminalEventPublished).toHaveBeenCalledWith(
      'call-rejected',
      7,
      expect.any(Date),
    );
  });

  it('preserves group capability routing on terminal outbox retries', async () => {
    const session = new CallSession({
      ...createTerminalSession(
        'group-ended',
        'ended',
        'membership_removed',
        'user-a',
      ),
      isGroupCall: true,
      groupName: 'Team',
      invitedUserIds: ['user-a', 'user-b', 'user-c'],
    });
    const publish = jest.fn();
    const useCase = new PublishCallTerminalOutboxUseCase(
      {
        claimPendingTerminalEvents: jest.fn().mockResolvedValue([
          {
            session,
            event: 'call.ended',
            reason: 'membership_removed',
            userId: 'user-a',
          },
        ]),
        markTerminalEventPublished: jest.fn(),
      } as never,
      { publish },
      { clearCallState: jest.fn() } as never,
      { closeRoom: jest.fn().mockResolvedValue(undefined) } as never,
    );
    await useCase.execute();
    expect(publish).toHaveBeenCalledWith(
      'call.ended',
      expect.objectContaining({
        isGroupCall: true,
        groupName: 'Team',
        invitedUserIds: ['user-a', 'user-b', 'user-c'],
      }),
    );
  });

  it('leaves a failed publication eligible for a later retry', async () => {
    const session = createTerminalSession(
      'call-1',
      'ended',
      'no_answer',
      'user-a',
    );
    const event = {
      session,
      event: 'call.ended' as const,
      reason: 'no_answer',
      userId: 'user-a',
    };
    const sessionRepository = {
      claimPendingTerminalEvents: jest.fn().mockResolvedValue([event]),
      markTerminalEventPublished: jest
        .fn()
        .mockRejectedValueOnce(new Error('redis unavailable'))
        .mockResolvedValueOnce(undefined),
    };
    const eventPublisher = { publish: jest.fn().mockResolvedValue(undefined) };
    const useCase = new PublishCallTerminalOutboxUseCase(
      sessionRepository as never,
      eventPublisher,
      { clearCallState: jest.fn().mockResolvedValue(undefined) } as never,
      { closeRoom: jest.fn().mockResolvedValue(undefined) } as never,
    );

    await expect(useCase.execute(endedAt)).resolves.toBe(1);
    await expect(useCase.execute(endedAt)).resolves.toBe(1);

    expect(eventPublisher.publish).toHaveBeenCalledTimes(2);
    expect(sessionRepository.markTerminalEventPublished).toHaveBeenCalledTimes(
      2,
    );
  });

  it('retries terminal Redis cleanup before acknowledging the outbox event', async () => {
    const session = createTerminalSession(
      'call-cleanup',
      'ended',
      'ended',
      'user-a',
    );
    const sessionRepository = {
      claimPendingTerminalEvents: jest
        .fn()
        .mockResolvedValue([
          { session, event: 'call.ended', reason: 'ended', userId: 'user-a' },
        ]),
      markTerminalEventPublished: jest.fn().mockResolvedValue(undefined),
    };
    const stateRepository = {
      clearCallState: jest
        .fn()
        .mockRejectedValueOnce(new Error('Redis temporarily unavailable'))
        .mockResolvedValueOnce(undefined),
    };
    const eventPublisher = { publish: jest.fn().mockResolvedValue(undefined) };
    const useCase = new PublishCallTerminalOutboxUseCase(
      sessionRepository as never,
      eventPublisher,
      stateRepository as never,
      { closeRoom: jest.fn().mockResolvedValue(undefined) } as never,
    );

    await useCase.execute(endedAt);
    expect(sessionRepository.markTerminalEventPublished).not.toHaveBeenCalled();
    await useCase.execute(endedAt);
    expect(stateRepository.clearCallState).toHaveBeenCalledTimes(2);
    expect(sessionRepository.markTerminalEventPublished).toHaveBeenCalledTimes(
      1,
    );
  });

  it('retains the outbox until local media cleanup succeeds, even after successful publication', async () => {
    const session = createTerminalSession(
      'media-retry',
      'ended',
      'ended',
      'user-a',
    );
    const markTerminalEventPublished = jest.fn();
    const closeRoom = jest
      .fn()
      .mockRejectedValueOnce(new Error('media unavailable'))
      .mockResolvedValue(undefined);
    const useCase = new PublishCallTerminalOutboxUseCase(
      {
        claimPendingTerminalEvents: jest
          .fn()
          .mockResolvedValue([
            { session, event: 'call.ended', reason: 'ended', userId: 'user-a' },
          ]),
        markTerminalEventPublished,
      } as never,
      { publish: jest.fn().mockResolvedValue(undefined) },
      { clearCallState: jest.fn().mockResolvedValue(undefined) } as never,
      { closeRoom } as never,
    );
    await useCase.execute(endedAt);
    expect(markTerminalEventPublished).not.toHaveBeenCalled();
    await useCase.execute(endedAt);
    expect(closeRoom).toHaveBeenCalledTimes(2);
    expect(markTerminalEventPublished).toHaveBeenCalledTimes(1);
  });

  it('bounds a stalled real publisher so the next terminal room is cleaned and timed-out work remains retryable', async () => {
    jest.useFakeTimers();
    const stalled = new Subject<void>();
    const first = createTerminalSession('stalled', 'ended', 'ended', 'user-a');
    const second = createTerminalSession('next', 'ended', 'ended', 'user-a');
    const markTerminalEventPublished = jest.fn();
    const closeRoom = jest.fn().mockResolvedValue(undefined);
    const emit = jest
      .fn()
      .mockReturnValueOnce(stalled)
      .mockReturnValue(of(undefined));
    const claim = jest
      .fn()
      .mockResolvedValueOnce(
        [first, second].map((session) => ({
          session,
          event: 'call.ended',
          reason: 'ended',
          userId: 'user-a',
        })),
      )
      .mockResolvedValue([
        {
          session: first,
          event: 'call.ended',
          reason: 'ended',
          userId: 'user-a',
        },
      ]);
    const useCase = new PublishCallTerminalOutboxUseCase(
      {
        claimPendingTerminalEvents: claim,
        markTerminalEventPublished,
      } as never,
      new RabbitCallEventPublisher({ emit } as never),
      { clearCallState: jest.fn().mockResolvedValue(undefined) } as never,
      { closeRoom } as never,
    );
    try {
      const draining = useCase.execute(endedAt);
      await jest.advanceTimersByTimeAsync(4999);
      expect(closeRoom).toHaveBeenCalledWith('stalled');
      expect(markTerminalEventPublished).not.toHaveBeenCalled();
      await jest.advanceTimersByTimeAsync(1);
      await expect(draining).resolves.toBe(2);
      expect(closeRoom).toHaveBeenCalledWith('next');
      expect(markTerminalEventPublished).toHaveBeenCalledTimes(1);
      expect(markTerminalEventPublished).toHaveBeenCalledWith(
        'next',
        7,
        expect.any(Date),
      );
      expect(stalled.observed).toBe(false);
      stalled.next(); // A late reply cannot ACK the timed-out attempt.
      expect(markTerminalEventPublished).toHaveBeenCalledTimes(1);
      await useCase.execute(endedAt);
      expect(markTerminalEventPublished).toHaveBeenCalledWith(
        'stalled',
        7,
        expect.any(Date),
      );
    } finally {
      stalled.complete();
      jest.useRealTimers();
    }
  });
});
