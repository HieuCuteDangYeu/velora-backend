import {
  isMissedGroupInvitationReason,
  summarizeCallOutcome,
} from '../../../src/domain/call-outcome';
import {
  CallSession,
  type GroupInvitation,
} from '../../../src/domain/entities/call-session.entity';

const startedAt = new Date('2026-10-22T10:00:00.000Z');

const directCall = (overrides: Partial<CallSession> = {}) =>
  new CallSession({
    callId: 'call-1',
    conversationId: 'conversation-1',
    initiatorId: 'caller',
    targetUserId: 'callee',
    participantIds: ['caller'],
    invitedUserIds: ['callee'],
    callType: 'VOICE',
    status: 'ended',
    lifecycleRevision: 3,
    createdAt: startedAt,
    endedAt: new Date('2026-10-22T10:00:30.000Z'),
    ...overrides,
  });

const invitation = (status: GroupInvitation['status']): GroupInvitation => ({
  invitationId: `invite-${status}`,
  sentAt: startedAt.toISOString(),
  expiresAt: startedAt.toISOString(),
  status,
});

describe('summarizeCallOutcome (1-1)', () => {
  it('treats an answered call as completed with its duration', () => {
    const summary = summarizeCallOutcome(
      directCall({
        participantIds: ['caller', 'callee'],
        answeredAt: new Date('2026-10-22T10:00:10.000Z'),
        endedAt: new Date('2026-10-22T10:03:22.400Z'),
        terminalReason: 'ended',
      }),
    );

    expect(summary).toEqual({
      outcome: 'COMPLETED',
      durationSec: 192,
      participants: [
        { userId: 'caller', role: 'CALLER', result: 'ANSWERED' },
        { userId: 'callee', role: 'CALLEE', result: 'ANSWERED' },
      ],
      missedUserIds: [],
    });
  });

  it.each(['no_answer', 'cancelled', 'ended', 'app_closed'])(
    'marks an unanswered call ending with %s as missed by the callee',
    (terminalReason) => {
      const summary = summarizeCallOutcome(
        directCall({
          status: terminalReason === 'cancelled' ? 'cancelled' : 'ended',
          terminalReason,
        }),
      );

      expect(summary.outcome).toBe('MISSED');
      expect(summary.durationSec).toBeUndefined();
      expect(summary.participants).toEqual([
        { userId: 'caller', role: 'CALLER', result: 'CANCELLED' },
        { userId: 'callee', role: 'CALLEE', result: 'MISSED' },
      ]);
      expect(summary.missedUserIds).toEqual(['callee']);
    },
  );

  it('marks a declined call without notifying anyone', () => {
    const summary = summarizeCallOutcome(
      directCall({ status: 'rejected', terminalReason: 'rejected' }),
    );

    expect(summary.outcome).toBe('DECLINED');
    expect(summary.participants.map((p) => p.result)).toEqual([
      'DECLINED',
      'DECLINED',
    ]);
    expect(summary.missedUserIds).toEqual([]);
  });

  it('counts a busy callee as a missed call', () => {
    const summary = summarizeCallOutcome(
      directCall({ status: 'rejected', terminalReason: 'busy' }),
    );

    expect(summary.outcome).toBe('MISSED');
    expect(summary.missedUserIds).toEqual(['callee']);
  });

  it.each([
    'media_unavailable',
    'remote_accept_failed',
    'mic_permission_denied',
  ])('marks a %s ending as failed even after the answer', (terminalReason) => {
    const summary = summarizeCallOutcome(
      directCall({
        answeredAt: new Date('2026-10-22T10:00:10.000Z'),
        terminalReason,
      }),
    );

    expect(summary.outcome).toBe('FAILED');
    expect(summary.durationSec).toBeUndefined();
    expect(summary.missedUserIds).toEqual([]);
  });
});

describe('summarizeCallOutcome (group)', () => {
  const groupCall = (
    groupInvitations: Record<string, GroupInvitation>,
    invitedUserIds = Object.keys(groupInvitations),
  ) =>
    new CallSession({
      callId: 'group-call',
      conversationId: 'group-1',
      initiatorId: 'starter',
      targetUserId: invitedUserIds[0] ?? 'starter',
      isGroupCall: true,
      participantIds: [],
      invitedUserIds,
      groupInvitations,
      callType: 'VOICE',
      status: 'ended',
      terminalReason: 'ended',
      lifecycleRevision: 9,
      createdAt: startedAt,
      answeredAt: startedAt,
      endedAt: new Date('2026-10-22T10:10:00.000Z'),
    });

  it('classifies each invitee and only notifies those still ringing', () => {
    const summary = summarizeCallOutcome(
      groupCall({
        joined: invitation('left'),
        declined: invitation('declined'),
        expired: invitation('expired'),
        busy: invitation('busy'),
        ringing: invitation('ringing'),
      }),
    );

    expect(summary.outcome).toBe('COMPLETED');
    expect(summary.durationSec).toBe(600);
    expect(summary.participants).toEqual([
      { userId: 'starter', role: 'CALLER', result: 'ANSWERED' },
      { userId: 'joined', role: 'CALLEE', result: 'ANSWERED' },
      { userId: 'declined', role: 'CALLEE', result: 'DECLINED' },
      { userId: 'expired', role: 'CALLEE', result: 'MISSED' },
      { userId: 'busy', role: 'CALLEE', result: 'MISSED' },
      { userId: 'ringing', role: 'CALLEE', result: 'MISSED' },
    ]);
    expect(summary.missedUserIds).toEqual(['ringing']);
  });

  it('is missed when nobody joined and declined when everybody declined', () => {
    expect(
      summarizeCallOutcome(
        groupCall({ a: invitation('expired'), b: invitation('declined') }),
      ).outcome,
    ).toBe('MISSED');
    expect(
      summarizeCallOutcome(
        groupCall({ a: invitation('declined'), b: invitation('declined') }),
      ).outcome,
    ).toBe('DECLINED');
  });

  it('includes invited users without an invitation record as missed', () => {
    const summary = summarizeCallOutcome(groupCall({}, ['late']));

    expect(summary.participants[1]).toEqual({
      userId: 'late',
      role: 'CALLEE',
      result: 'MISSED',
    });
    expect(summary.missedUserIds).toEqual(['late']);
  });
});

describe('isMissedGroupInvitationReason', () => {
  it('only treats timeout and busy as missed', () => {
    expect(isMissedGroupInvitationReason('timeout')).toBe(true);
    expect(isMissedGroupInvitationReason('busy')).toBe(true);
    expect(isMissedGroupInvitationReason('declined')).toBe(false);
    expect(isMissedGroupInvitationReason('answered_elsewhere')).toBe(false);
    expect(isMissedGroupInvitationReason(undefined)).toBe(false);
  });
});
