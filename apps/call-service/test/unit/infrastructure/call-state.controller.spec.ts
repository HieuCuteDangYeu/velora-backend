import { CallStateController } from '../../../src/infrastructure/controllers/call-state.controller';
import { CallSession } from '../../../src/domain/entities/call-session.entity';

describe('CallStateController', () => {
  const session = new CallSession({
    callId: 'call-1',
    conversationId: 'conv-1',
    initiatorId: 'user-a',
    targetUserId: 'user-b',
    initiatorDisplayName: 'Ada',
    initiatorAvatarUrl: 'https://cdn.example/ada.png',
    ringTimeoutMs: 30000,
    expiresAt: new Date('2026-01-01T00:00:30.000Z'),
    callType: 'VOICE',
    status: 'ringing',
    participantIds: ['user-a', 'user-b'],
  });

  const createController = (foundSession: CallSession | null) => {
    const sessionRepository = {
      findByCallId: jest.fn().mockResolvedValue(foundSession),
    };

    return {
      controller: new CallStateController(sessionRepository as never),
      sessionRepository,
    };
  };

  it('returns ringing call state for participants', async () => {
    const { controller } = createController(session);

    await expect(
      controller.getCallState({ callId: 'call-1', userId: 'user-b' }),
    ).resolves.toEqual({
      found: true,
      authorized: true,
      call: expect.objectContaining({
        callId: 'call-1',
        status: 'ringing',
        recipientUserId: 'user-b',
        initiatorDisplayName: 'Ada',
        initiatorAvatarUrl: 'https://cdn.example/ada.png',
        ringTimeoutMs: 30000,
        expiresAt: '2026-01-01T00:00:30.000Z',
      }),
    });
  });

  it('returns not found when the call session is gone', async () => {
    const { controller } = createController(null);

    await expect(
      controller.getCallState({ callId: 'missing-call', userId: 'user-b' }),
    ).resolves.toEqual({
      found: false,
      authorized: false,
    });
  });

  it('rejects users outside the call', async () => {
    const { controller } = createController(session);

    await expect(
      controller.getCallState({ callId: 'call-1', userId: 'outsider' }),
    ).resolves.toEqual({
      found: true,
      authorized: false,
    });
  });
});
