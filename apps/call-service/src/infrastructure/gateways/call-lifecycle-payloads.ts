export type InitiateCallPayload = {
  conversationId: string;
  targetUserId?: string;
  selectedInviteeIds?: string[];
  callType: 'VOICE' | 'VIDEO';
};

export type JoinCallPayload = {
  callId: string;
};

export type LegacyAnswerCallPayload = JoinCallPayload & {
  /**
   * Optional so existing clients keep their original answer_call contract.
   * A rollback-capable new client sends its native action id, which lets the
   * active state update distinguish its own winner from another device.
   */
  actionId?: string;
};

export type AcceptIncomingCallPayload = JoinCallPayload & {
  actionId: string;
  invitationId?: string;
};

export type RejoinCallPayload = {
  callId: string;
  actionId?: string;
};

export type LeaveCallPayload = {
  callId: string;
  invitationId?: string;
  reason?: string;
  /** A supplied winner action must match; it never grants socket permission. */
  actionId?: string;
};
