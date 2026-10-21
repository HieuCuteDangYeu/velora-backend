import type {
  CallLogParticipant,
  CallParticipantResult,
  CallRecordOutcome,
} from '@common/calls/call-history.types';
import type { CallSession } from './entities/call-session.entity';

/**
 * The single place that decides what a finished call was for each participant
 * and who missed it. Call history, the chat call log and missed-call pushes all
 * derive from this, so they never disagree.
 */
export interface CallOutcomeSummary {
  outcome: CallRecordOutcome;
  durationSec?: number;
  participants: CallLogParticipant[];
  /** Callees who should get a "missed call" notification for this session. */
  missedUserIds: string[];
}

/** Reasons meaning the call could not be set up, not that someone missed it. */
const FAILURE_REASONS = new Set([
  'media_unavailable',
  'mic_permission_denied',
  'camera_permission_denied',
  'remote_audio_not_ready',
  'remote_accept_failed',
]);

/** Group invitation rejections that mean the invitee missed the call. */
const MISSED_INVITATION_REASONS = new Set(['timeout', 'busy']);

export function isMissedGroupInvitationReason(reason?: string): boolean {
  return reason !== undefined && MISSED_INVITATION_REASONS.has(reason);
}

export function summarizeCallOutcome(session: CallSession): CallOutcomeSummary {
  return session.isGroupCall
    ? summarizeGroupCall(session)
    : summarizeDirectCall(session);
}

function summarizeDirectCall(session: CallSession): CallOutcomeSummary {
  const reason = session.terminalReason;
  const caller = session.initiatorId;
  const callee = session.targetUserId;
  const both = (
    callerResult: CallParticipantResult,
    calleeResult: CallParticipantResult,
  ): CallLogParticipant[] => [
    { userId: caller, role: 'CALLER', result: callerResult },
    { userId: callee, role: 'CALLEE', result: calleeResult },
  ];

  if (session.status === 'rejected') {
    if (reason === 'busy') {
      return {
        outcome: 'MISSED',
        participants: both('CANCELLED', 'MISSED'),
        missedUserIds: [callee],
      };
    }
    return {
      outcome: 'DECLINED',
      participants: both('DECLINED', 'DECLINED'),
      missedUserIds: [],
    };
  }

  if (reason && FAILURE_REASONS.has(reason)) {
    return {
      outcome: 'FAILED',
      participants: both('FAILED', 'FAILED'),
      missedUserIds: [],
    };
  }

  // answeredAt is set when the callee wins the answer, so any other ending
  // after it is a completed conversation.
  if (session.answeredAt) {
    return {
      outcome: 'COMPLETED',
      durationSec: durationSec(session.answeredAt, session.endedAt),
      participants: both('ANSWERED', 'ANSWERED'),
      missedUserIds: [],
    };
  }

  // Not answered, not declined, not a setup failure: the caller gave up or the
  // ring timed out (no_answer, cancelled, ended, app_closed, ...).
  return {
    outcome: 'MISSED',
    participants: both('CANCELLED', 'MISSED'),
    missedUserIds: [callee],
  };
}

function summarizeGroupCall(session: CallSession): CallOutcomeSummary {
  const invitations = session.groupInvitations ?? {};
  const calleeIds = [
    ...new Set([
      ...(session.invitedUserIds ?? []),
      ...Object.keys(invitations),
    ]),
  ].filter((userId) => userId && userId !== session.initiatorId);

  const participants: CallLogParticipant[] = [
    { userId: session.initiatorId, role: 'CALLER', result: 'ANSWERED' },
  ];
  // Invitees whose invitation expired or was busy were already notified by
  // their own invitation event; only those still ringing when the whole call
  // ended are missed here.
  const missedUserIds: string[] = [];

  for (const userId of calleeIds) {
    const status = invitations[userId]?.status;
    let result: CallParticipantResult;
    switch (status) {
      case 'in_call':
      case 'left':
      case 'joining':
        result = 'ANSWERED';
        break;
      case 'declined':
        result = 'DECLINED';
        break;
      case 'busy':
      case 'expired':
        result = 'MISSED';
        break;
      default:
        result = 'MISSED';
        missedUserIds.push(userId);
    }
    participants.push({ userId, role: 'CALLEE', result });
  }

  const callees = participants.slice(1);
  const outcome: CallRecordOutcome = callees.some(
    (participant) => participant.result === 'ANSWERED',
  )
    ? 'COMPLETED'
    : callees.length > 0 &&
        callees.every((participant) => participant.result === 'DECLINED')
      ? 'DECLINED'
      : 'MISSED';

  return {
    outcome,
    ...(outcome === 'COMPLETED'
      ? {
          durationSec: durationSec(
            session.answeredAt ?? session.createdAt,
            session.endedAt,
          ),
        }
      : {}),
    participants,
    missedUserIds,
  };
}

function durationSec(from: Date, to?: Date): number | undefined {
  if (!to) return undefined;
  return Math.max(0, Math.round((to.getTime() - from.getTime()) / 1000));
}
