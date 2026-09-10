import { PublishCallTerminalOutboxUseCase } from '../../../src/application/use-cases/publish-call-terminal-outbox.use-case';
import { CallSession } from '../../../src/domain/entities/call-session.entity';

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
    );

    await expect(useCase.execute(endedAt)).resolves.toBe(1);
    await expect(useCase.execute(endedAt)).resolves.toBe(1);

    expect(eventPublisher.publish).toHaveBeenCalledTimes(2);
    expect(sessionRepository.markTerminalEventPublished).toHaveBeenCalledTimes(
      2,
    );
  });
});
