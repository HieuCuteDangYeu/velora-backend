import { CallSession } from '../../../src/domain/entities/call-session.entity';

describe('CallSession Redis hydration', () => {
  it('normalizes Lua cjson empty tables back to arrays', () => {
    const session = new CallSession({
      callId: 'call-1',
      conversationId: 'conversation-1',
      initiatorId: 'host',
      targetUserId: 'guest',
      callType: 'VOICE',
      status: 'active',
      participantIds: {} as string[],
      invitedUserIds: {} as string[],
      declinedUserIds: {} as string[],
    });
    expect(session.participantIds).toEqual([]);
    expect(session.invitedUserIds).toEqual(['host', 'guest']);
    expect(session.declinedUserIds).toEqual([]);
  });
});
