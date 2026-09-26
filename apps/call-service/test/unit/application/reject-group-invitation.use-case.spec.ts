import { RejectCallUseCase } from '../../../src/application/use-cases/reject-call.use-case';
import { CallSession } from '../../../src/domain/entities/call-session.entity';

it('declines one group invite without terminating the shared call', async () => {
  const session = new CallSession({
    callId: 'room-1',
    conversationId: 'conversation-1',
    initiatorId: 'host',
    targetUserId: 'guest',
    invitedUserIds: ['host', 'guest', 'other'],
    declinedUserIds: ['guest'],
    isGroupCall: true,
    callType: 'VOICE',
    status: 'active',
    participantIds: ['host'],
    lifecycleRevision: 2,
    updatedAt: new Date(),
  });
  const sessionRepository = {
    findByCallId: jest.fn().mockResolvedValue(session),
    rejectGroupInvitation: jest
      .fn()
      .mockResolvedValue({ outcome: 'rejected', session }),
    transitionToTerminal: jest.fn(),
  };
  const mediaEngine = { closeRoom: jest.fn() };
  const eventPublisher = { publish: jest.fn().mockResolvedValue(undefined) };
  const useCase = new RejectCallUseCase(
    sessionRepository as never,
    { clearCallState: jest.fn() } as never,
    eventPublisher,
    mediaEngine as never,
  );

  const result = await useCase.execute(
    'room-1',
    'guest',
    'answer-action-secret',
  );

  expect(result).toMatchObject({
    didTransition: true,
    isGroupInvitation: true,
    reason: 'rejected',
  });
  expect(sessionRepository.rejectGroupInvitation).toHaveBeenCalledWith(
    'room-1',
    'guest',
    expect.any(Date),
    'rejected',
  );
  expect(eventPublisher.publish).not.toHaveBeenCalled();
  expect(sessionRepository.transitionToTerminal).not.toHaveBeenCalled();
  expect(mediaEngine.closeRoom).not.toHaveBeenCalled();
});
