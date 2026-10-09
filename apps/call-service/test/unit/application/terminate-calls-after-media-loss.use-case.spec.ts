import { TerminateCallsAfterMediaLossUseCase } from '../../../src/application/use-cases/terminate-calls-after-media-loss.use-case';
import { CallSession } from '../../../src/domain/entities/call-session.entity';

const session = (callId: string, initiatorId = 'host') =>
  new CallSession({
    callId,
    conversationId: 'conv',
    initiatorId,
    targetUserId: 'guest',
    callType: 'VOICE',
    status: 'active',
    participantIds: [initiatorId, 'guest'],
  });

describe('TerminateCallsAfterMediaLossUseCase', () => {
  const now = new Date('2026-01-01T00:00:00.000Z');

  it('ends each lost call as media_unavailable on behalf of its initiator', async () => {
    const ended = session('call-a', 'host-a');
    const repository = {
      findByCallId: jest
        .fn()
        .mockImplementation((callId: string) =>
          Promise.resolve(session(callId, `host-${callId.slice(-1)}`)),
        ),
      transitionToTerminal: jest
        .fn()
        .mockResolvedValue({ outcome: 'transitioned', session: ended }),
    };
    const useCase = new TerminateCallsAfterMediaLossUseCase(
      repository as never,
    );

    await expect(useCase.execute(['call-a', 'call-b'], now)).resolves.toEqual([
      ended,
      ended,
    ]);

    expect(repository.transitionToTerminal).toHaveBeenNthCalledWith(
      1,
      'call-a',
      'host-a',
      'media_unavailable',
      now,
      'media_lost',
    );
    expect(repository.transitionToTerminal).toHaveBeenNthCalledWith(
      2,
      'call-b',
      'host-b',
      'media_unavailable',
      now,
      'media_lost',
    );
  });

  it('skips calls that are unknown or already finished', async () => {
    const repository = {
      findByCallId: jest
        .fn()
        .mockResolvedValueOnce(null)
        .mockResolvedValue(session('call-b')),
      transitionToTerminal: jest.fn().mockResolvedValue({
        outcome: 'already_terminal',
        session: session('call-b'),
      }),
    };
    const useCase = new TerminateCallsAfterMediaLossUseCase(
      repository as never,
    );

    await expect(useCase.execute(['gone', 'call-b'], now)).resolves.toEqual([]);
    expect(repository.transitionToTerminal).toHaveBeenCalledTimes(1);
  });

  it('keeps ending the remaining calls when one of them fails', async () => {
    const ended = session('call-c');
    const repository = {
      findByCallId: jest
        .fn()
        .mockRejectedValueOnce(new Error('Redis unavailable'))
        .mockResolvedValue(session('call-c')),
      transitionToTerminal: jest
        .fn()
        .mockResolvedValue({ outcome: 'transitioned', session: ended }),
    };
    const useCase = new TerminateCallsAfterMediaLossUseCase(
      repository as never,
    );

    await expect(useCase.execute(['call-b', 'call-c'], now)).resolves.toEqual([
      ended,
    ]);
  });
});
