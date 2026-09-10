import { PublishCallAnswerOutboxUseCase } from '../../../src/application/use-cases/publish-call-answer-outbox.use-case';
import { CallSession } from '../../../src/domain/entities/call-session.entity';

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
});
