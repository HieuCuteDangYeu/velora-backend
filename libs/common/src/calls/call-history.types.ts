/**
 * Contracts shared by call-service (owner of call history), conversation-service
 * (call log rows in chat) and api-gateway (history API).
 */

export type CallHistoryCallType = 'VOICE' | 'VIDEO';

/** Outcome of the whole call. */
export type CallRecordOutcome = 'COMPLETED' | 'MISSED' | 'DECLINED' | 'FAILED';

/** What the call was for one participant. */
export type CallParticipantResult =
  | 'ANSWERED'
  | 'MISSED'
  | 'DECLINED'
  | 'CANCELLED'
  | 'FAILED';

export type CallParticipantRole = 'CALLER' | 'CALLEE';

export interface CallLogParticipant {
  userId: string;
  role: CallParticipantRole;
  result: CallParticipantResult;
}

/** RabbitMQ event `call.logged`, sent to conversation_queue once per call. */
export interface CallLoggedEvent {
  callId: string;
  conversationId: string;
  callType: CallHistoryCallType;
  isGroupCall: boolean;
  initiatorId: string;
  outcome: CallRecordOutcome;
  terminalReason?: string;
  durationSec?: number;
  startedAt: string;
  endedAt: string;
  participants: CallLogParticipant[];
}

export interface CallHistoryItem {
  callId: string;
  conversationId: string;
  callType: CallHistoryCallType;
  isGroupCall: boolean;
  groupName?: string;
  groupAvatarUrl?: string;
  initiatorId: string;
  outcome: CallRecordOutcome;
  terminalReason?: string;
  /** The requesting user's role and result in this call. */
  role: CallParticipantRole;
  result: CallParticipantResult;
  startedAt: string;
  endedAt: string;
  durationSec?: number;
  /** Other participants' user ids, the caller first. */
  peerUserIds: string[];
}

export interface CallHistoryPage {
  items: CallHistoryItem[];
  nextCursor: string | null;
}
