import { PublishCallAnswerOutboxUseCase } from '../../../src/application/use-cases/publish-call-answer-outbox.use-case';
import { CallSession } from '../../../src/domain/entities/call-session.entity';
import { createHash } from 'node:crypto';
import { Logger } from '@nestjs/common';

describe('PublishCallAnswerOutboxUseCase', () => {
  const answeredAt = new Date('2026-01-01T00:00:02.000Z');

  const createActiveSession = (callId: string, actionId: string) =>
    new CallSession({
      callId,
      conversationId: `conversation-${callId}`,
      initiatorId: 'user-a',
      targetUserId: 'user-b',
      callType: 'VIDEO',
      status: 'active',
      participantIds: ['user-a', 'user-b'],
      answerActionId: actionId,
      answeredAt,
      createdAt: answeredAt,
      updatedAt: answeredAt,
    });

  it('continues publishing later calls when one outbox event fails', async () => {
    const failedSession = createActiveSession('call-failed', 'action-failed');
    const successfulSession = createActiveSession(
      'call-success',
      'action-success',
    );
    const sessionRepository = {
      claimPendingAnswerEvents: jest.fn().mockResolvedValue([
        { session: failedSession, actionId: 'action-failed' },
        { session: successfulSession, actionId: 'action-success' },
      ]),
      claimPendingGroupInvitationEvents: jest.fn().mockResolvedValue([]),
      markAnswerEventPublished: jest.fn(),
    };
    const eventPublisher = {
      publish: jest
        .fn()
        .mockRejectedValueOnce(new Error('broker unavailable'))
        .mockResolvedValueOnce(undefined),
    };
    const useCase = new PublishCallAnswerOutboxUseCase(
      sessionRepository as never,
      eventPublisher,
    );

    await expect(useCase.execute(answeredAt)).resolves.toBe(2);

    expect(eventPublisher.publish).toHaveBeenNthCalledWith(
      1,
      'call.answered',
      expect.objectContaining({
        callId: 'call-failed',
        answerActionId: 'action-failed',
      }),
    );
    expect(eventPublisher.publish).toHaveBeenNthCalledWith(
      2,
      'call.answered',
      expect.objectContaining({
        callId: 'call-success',
        answerActionId: 'action-success',
      }),
    );
    expect(sessionRepository.markAnswerEventPublished).toHaveBeenCalledTimes(1);
    expect(sessionRepository.markAnswerEventPublished).toHaveBeenCalledWith(
      'call-success',
      'action-success',
      expect.any(Date),
    );
  });

  it('leaves an event eligible for at-least-once retry when marking it published fails', async () => {
    const session = createActiveSession('call-1', 'action-1');
    const sessionRepository = {
      claimPendingAnswerEvents: jest
        .fn()
        .mockResolvedValueOnce([{ session, actionId: 'action-1' }])
        .mockResolvedValueOnce([{ session, actionId: 'action-1' }]),
      claimPendingGroupInvitationEvents: jest.fn().mockResolvedValue([]),
      markAnswerEventPublished: jest
        .fn()
        .mockRejectedValueOnce(new Error('redis unavailable'))
        .mockResolvedValueOnce(undefined),
    };
    const eventPublisher = { publish: jest.fn().mockResolvedValue(undefined) };
    const useCase = new PublishCallAnswerOutboxUseCase(
      sessionRepository as never,
      eventPublisher,
    );

    await expect(useCase.execute(answeredAt)).resolves.toBe(1);
    await expect(useCase.execute(answeredAt)).resolves.toBe(1);

    expect(eventPublisher.publish).toHaveBeenCalledTimes(2);
    expect(eventPublisher.publish).toHaveBeenNthCalledWith(
      1,
      'call.answered',
      expect.objectContaining({ answerActionId: 'action-1' }),
    );
    expect(eventPublisher.publish).toHaveBeenNthCalledWith(
      2,
      'call.answered',
      expect.objectContaining({ answerActionId: 'action-1' }),
    );
  });

  it('publishes group outcomes only to the affected account and retries a failed event', async () => {
    const warning = jest.spyOn(Logger.prototype, 'warn').mockImplementation();
    const session = new CallSession({
      ...createActiveSession('group-1', 'unused'),
      isGroupCall: true,
      callType: 'VOICE',
      invitedUserIds: ['user-a', 'user-b', 'user-c'],
      groupName: 'Team',
      ringTimeoutMs: 30_000,
      expiresAt: new Date('2026-01-01T00:00:30.000Z'),
    });
    const groupEvents = [
      {
        key: 'accepted-event',
        event: 'call.answered' as const,
        callId: 'group-1',
        userId: 'user-b',
        actionId: 'device-b',
        lifecycleRevision: 2,
        at: answeredAt.toISOString(),
      },
      {
        key: 'rejected-event',
        event: 'call.rejected' as const,
        callId: 'group-1',
        userId: 'user-c',
        reason: 'rejected',
        lifecycleRevision: 3,
        at: answeredAt.toISOString(),
      },
    ];
    const sessionRepository = {
      claimPendingAnswerEvents: jest.fn().mockResolvedValue([]),
      claimPendingGroupInvitationEvents: jest
        .fn()
        .mockResolvedValue(groupEvents),
      findByCallId: jest.fn().mockResolvedValue(session),
      markGroupInvitationEventPublished: jest.fn(),
    };
    const eventPublisher = {
      publish: jest
        .fn()
        .mockRejectedValueOnce(
          new Error('user-b answer-action-secret broker unavailable'),
        )
        .mockResolvedValue(undefined),
    };
    const useCase = new PublishCallAnswerOutboxUseCase(
      sessionRepository as never,
      eventPublisher,
    );

    await expect(useCase.execute(answeredAt)).resolves.toBe(2);

    expect(eventPublisher.publish).toHaveBeenNthCalledWith(
      1,
      'call.answered',
      expect.objectContaining({
        targetUserId: 'user-b',
        recipientUserId: 'user-b',
        invitedUserIds: ['user-b'],
        answerActionHash: createHash('sha256').update('device-b').digest('hex'),
        lifecycleRevision: 2,
      }),
    );
    expect(eventPublisher.publish.mock.calls[0][1]).not.toHaveProperty(
      'answerActionId',
    );
    expect(eventPublisher.publish).toHaveBeenNthCalledWith(
      2,
      'call.rejected',
      expect.objectContaining({
        targetUserId: 'user-c',
        recipientUserId: 'user-c',
        invitedUserIds: ['user-c'],
        lifecycleRevision: 3,
      }),
    );
    expect(
      sessionRepository.markGroupInvitationEventPublished,
    ).toHaveBeenCalledTimes(1);
    expect(
      sessionRepository.markGroupInvitationEventPublished,
    ).toHaveBeenCalledWith('rejected-event');
    expect(warning).toHaveBeenCalledWith(
      `group invitation event publish failed call=${createHash('sha256').update('group-1').digest('hex').slice(0, 12)} errorCode=unknown_error`,
    );
    warning.mockRestore();
  });
});
