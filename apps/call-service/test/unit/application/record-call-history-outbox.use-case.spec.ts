import { RecordCallHistoryOutboxUseCase } from '../../../src/application/use-cases/record-call-history-outbox.use-case';
import { CallSession } from '../../../src/domain/entities/call-session.entity';

describe('RecordCallHistoryOutboxUseCase', () => {
  const now = new Date('2026-10-22T10:05:00.000Z');
  const answered = new CallSession({
    callId: 'call-answered',
    conversationId: 'conversation-1',
    initiatorId: 'caller',
    targetUserId: 'callee',
    participantIds: ['caller', 'callee'],
    invitedUserIds: ['callee'],
    callType: 'VIDEO',
    status: 'ended',
    terminalReason: 'ended',
    lifecycleRevision: 6,
    createdAt: new Date('2026-10-22T10:00:00.000Z'),
    answeredAt: new Date('2026-10-22T10:00:05.000Z'),
    endedAt: new Date('2026-10-22T10:01:05.000Z'),
  });

  const setup = (
    overrides: {
      record?: jest.Mock;
      publish?: jest.Mock;
    } = {},
  ) => {
    const sessionRepository = {
      claimPendingHistoryEvents: jest.fn().mockResolvedValue([answered]),
      markHistoryRecorded: jest.fn().mockResolvedValue(undefined),
    };
    const historyRepository = {
      record: overrides.record ?? jest.fn().mockResolvedValue(undefined),
    };
    const callLogPublisher = {
      publish: overrides.publish ?? jest.fn().mockResolvedValue(undefined),
    };
    const useCase = new RecordCallHistoryOutboxUseCase(
      sessionRepository as never,
      historyRepository as never,
      callLogPublisher,
    );
    return { useCase, sessionRepository, historyRepository, callLogPublisher };
  };

  it('records the call, publishes the chat log and acknowledges the outbox', async () => {
    const { useCase, sessionRepository, historyRepository, callLogPublisher } =
      setup();

    await expect(useCase.execute(now)).resolves.toBe(1);

    expect(historyRepository.record).toHaveBeenCalledWith(
      expect.objectContaining({
        callId: 'call-answered',
        outcome: 'COMPLETED',
        durationSec: 60,
        startedAt: answered.createdAt,
        endedAt: answered.endedAt,
        lifecycleRevision: 6,
        participants: [
          { userId: 'caller', role: 'CALLER', result: 'ANSWERED' },
          { userId: 'callee', role: 'CALLEE', result: 'ANSWERED' },
        ],
      }),
    );
    expect(callLogPublisher.publish).toHaveBeenCalledWith({
      callId: 'call-answered',
      conversationId: 'conversation-1',
      callType: 'VIDEO',
      isGroupCall: false,
      initiatorId: 'caller',
      outcome: 'COMPLETED',
      terminalReason: 'ended',
      durationSec: 60,
      startedAt: '2026-10-22T10:00:00.000Z',
      endedAt: '2026-10-22T10:01:05.000Z',
      participants: [
        { userId: 'caller', role: 'CALLER', result: 'ANSWERED' },
        { userId: 'callee', role: 'CALLEE', result: 'ANSWERED' },
      ],
    });
    expect(sessionRepository.markHistoryRecorded).toHaveBeenCalledWith(
      'call-answered',
    );
  });

  it('leaves the call claimed for retry when the history database fails', async () => {
    const { useCase, sessionRepository, callLogPublisher } = setup({
      record: jest.fn().mockRejectedValue(new Error('database unavailable')),
    });

    await expect(useCase.execute(now)).resolves.toBe(1);

    expect(callLogPublisher.publish).not.toHaveBeenCalled();
    expect(sessionRepository.markHistoryRecorded).not.toHaveBeenCalled();
  });

  it('retries when the chat log cannot be published', async () => {
    const { useCase, sessionRepository } = setup({
      publish: jest.fn().mockRejectedValue(new Error('broker unavailable')),
    });

    await useCase.execute(now);

    expect(sessionRepository.markHistoryRecorded).not.toHaveBeenCalled();
  });
});
