import { CallStateController } from '../../../src/infrastructure/controllers/call-state.controller';
import { CallSession } from '../../../src/domain/entities/call-session.entity';
import { of, throwError } from 'rxjs';
import { ServiceUnavailableException } from '@nestjs/common';

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
    const conversationClient = {
      send: jest.fn().mockReturnValue(
        of({
          id: foundSession?.conversationId,
          isGroup: true,
          participantIds: ['user-a', 'user-b', 'user-c'],
        }),
      ),
    };

    return {
      controller: new CallStateController(
        sessionRepository as never,
        conversationClient as never,
      ),
      sessionRepository,
      conversationClient,
    };
  };

  it('does not expose group metadata to a member removed after invitation', async () => {
    const groupSession = new CallSession({
      ...session,
      status: 'active',
      isGroupCall: true,
      groupName: 'Private team',
      invitedUserIds: ['user-a', 'user-b'],
      participantIds: ['user-a'],
    });
    const { controller, conversationClient } = createController(groupSession);
    conversationClient.send.mockReturnValue(
      of({ id: 'conv-1', isGroup: true, participantIds: ['user-a'] }),
    );

    await expect(
      controller.getCallState({ callId: 'call-1', userId: 'user-b' }),
    ).resolves.toEqual({ found: true, authorized: false });
    expect(conversationClient.send).toHaveBeenCalledWith(
      'get_conversation_detail',
      { id: 'conv-1', userId: 'user-b' },
    );
  });

  it('fails closed but remains retryable when current group membership is unavailable', async () => {
    const groupSession = new CallSession({
      ...session,
      status: 'active',
      isGroupCall: true,
      invitedUserIds: ['user-a', 'user-b'],
    });
    const { controller, conversationClient } = createController(groupSession);
    conversationClient.send.mockReturnValue(
      throwError(() => new Error('conversation service unavailable')),
    );

    await expect(
      controller.getCallState({ callId: 'call-1', userId: 'user-b' }),
    ).rejects.toBeInstanceOf(ServiceUnavailableException);
  });

  it('rejects a mismatched conversation response without leaking call metadata', async () => {
    const groupSession = new CallSession({
      ...session,
      status: 'active',
      isGroupCall: true,
      invitedUserIds: ['user-a', 'user-b'],
    });
    const { controller, conversationClient } = createController(groupSession);
    conversationClient.send.mockReturnValue(
      of({
        id: 'other-conversation',
        isGroup: true,
        participantIds: ['user-b'],
      }),
    );

    await expect(
      controller.getCallState({ callId: 'call-1', userId: 'user-b' }),
    ).resolves.toEqual({ found: true, authorized: false });
  });

  it('does not expose group metadata when conversation service rejects former membership', async () => {
    const groupSession = new CallSession({
      ...session,
      status: 'active',
      isGroupCall: true,
      invitedUserIds: ['user-a', 'user-b'],
    });
    const { controller, conversationClient } = createController(groupSession);
    conversationClient.send.mockReturnValue(
      throwError(
        () => new Error('You are not a participant of this conversation'),
      ),
    );

    await expect(
      controller.getCallState({ callId: 'call-1', userId: 'user-b' }),
    ).resolves.toEqual({ found: true, authorized: false });
  });

  it('returns ringing call state for participants', async () => {
    const { controller, conversationClient } = createController(session);

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
    expect(conversationClient.send).not.toHaveBeenCalled();
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

  it('keeps an invited group member ringing until they join the active room', async () => {
    const groupSession = new CallSession({
      ...session,
      status: 'active',
      isGroupCall: true,
      groupName: 'Core team',
      expiresAt: new Date('2099-01-01T00:00:30.000Z'),
      invitedUserIds: ['user-a', 'user-b', 'user-c'],
      participantIds: ['user-a'],
    });
    const { controller } = createController(groupSession);

    await expect(
      controller.getCallState({ callId: 'call-1', userId: 'user-c' }),
    ).resolves.toEqual({
      found: true,
      authorized: true,
      call: expect.objectContaining({
        status: 'ringing',
        recipientUserId: 'user-c',
        isGroupCall: true,
        groupName: 'Core team',
      }),
    });
  });

  it('reports a declined invite as rejected without ending the room for others', async () => {
    const groupSession = new CallSession({
      ...session,
      status: 'active',
      isGroupCall: true,
      invitedUserIds: ['user-a', 'user-b', 'user-c'],
      participantIds: ['user-a'],
      declinedUserIds: ['user-b'],
      expiresAt: new Date('2099-01-01T00:00:30.000Z'),
    });
    const { controller } = createController(groupSession);

    expect(
      (await controller.getCallState({ callId: 'call-1', userId: 'user-b' }))
        .call?.status,
    ).toBe('rejected');
    expect(
      (await controller.getCallState({ callId: 'call-1', userId: 'user-c' }))
        .call?.status,
    ).toBe('ringing');
  });

  it('does not resurrect an unjoined invite after its deadline', async () => {
    const groupSession = new CallSession({
      ...session,
      status: 'active',
      isGroupCall: true,
      invitedUserIds: ['user-a', 'user-b'],
      participantIds: ['user-a'],
      expiresAt: new Date('2020-01-01T00:00:00.000Z'),
    });
    const { controller } = createController(groupSession);

    expect(
      (await controller.getCallState({ callId: 'call-1', userId: 'user-b' }))
        .call?.status,
    ).toBe('ended');
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
