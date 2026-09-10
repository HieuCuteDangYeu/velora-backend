import { RecoverActiveCallsAfterMediaRestartUseCase } from '../../../src/application/use-cases/recover-active-calls-after-media-restart.use-case';
import { CallSession } from '../../../src/domain/entities/call-session.entity';

function activeSession(callId: string) {
  return new CallSession({
    callId,
    conversationId: `conversation-${callId}`,
    initiatorId: 'initiator-id',
    targetUserId: 'target-id',
    callType: 'VOICE',
    status: 'active',
    participantIds: ['initiator-id', 'target-id'],
    endedAt: new Date('2026-09-05T00:00:00.000Z'),
  });
}

describe('RecoverActiveCallsAfterMediaRestartUseCase', () => {
  it('drains every full batch so active calls beyond the first limit are terminated', async () => {
    const firstBatch = [activeSession('call-1'), activeSession('call-2')];
    const secondBatch = [activeSession('call-3')];
    const sessionRepository = {
      terminateActiveCallsForMediaRestart: jest
        .fn()
        .mockResolvedValueOnce(firstBatch)
        .mockResolvedValueOnce(secondBatch),
    };
    const stateRepository = {
      clearCallState: jest.fn().mockResolvedValue(undefined),
    };
    const mediaEngine = { closeRoom: jest.fn().mockResolvedValue(undefined) };
    const eventPublisher = { publish: jest.fn().mockResolvedValue(undefined) };
    const useCase = new RecoverActiveCallsAfterMediaRestartUseCase(
      sessionRepository as never,
      stateRepository as never,
      mediaEngine as never,
      eventPublisher,
    );

    const result = await useCase.execute(
      new Date('2026-09-05T00:00:00.000Z'),
      2,
    );

    expect(result.map((session) => session.callId)).toEqual([
      'call-1',
      'call-2',
      'call-3',
    ]);
    expect(
      sessionRepository.terminateActiveCallsForMediaRestart,
    ).toHaveBeenCalledTimes(2);
    expect(
      sessionRepository.terminateActiveCallsForMediaRestart,
    ).toHaveBeenNthCalledWith(1, expect.any(Date), 2);
    expect(mediaEngine.closeRoom).toHaveBeenCalledTimes(3);
    expect(stateRepository.clearCallState).toHaveBeenCalledTimes(3);
    expect(eventPublisher.publish).toHaveBeenCalledTimes(3);
  });

  it('normalizes a zero limit to one and stops once the repository is empty', async () => {
    const sessionRepository = {
      terminateActiveCallsForMediaRestart: jest.fn().mockResolvedValue([]),
    };
    const useCase = new RecoverActiveCallsAfterMediaRestartUseCase(
      sessionRepository as never,
      { clearCallState: jest.fn() } as never,
      { closeRoom: jest.fn() } as never,
      { publish: jest.fn() },
    );

    await expect(useCase.execute(new Date(), 0)).resolves.toEqual([]);
    expect(
      sessionRepository.terminateActiveCallsForMediaRestart,
    ).toHaveBeenCalledWith(expect.any(Date), 1);
  });
});
