export type CallSessionStatus =
  | 'initiated'
  | 'ringing'
  /**
   * A callee won the answer CAS, but media preparation has not yet committed
   * the call as usable. This state is deliberately durable so a terminal
   * update can still beat a late media result.
   */
  | 'accepting'
  | 'active'
  | 'cancelled'
  | 'ended'
  | 'rejected';

export type CallType = 'VOICE' | 'VIDEO';

export class CallSession {
  callId!: string;
  conversationId!: string;
  initiatorId!: string;
  targetUserId!: string;
  isGroupCall?: boolean;
  invitedUserIds!: string[];
  declinedUserIds!: string[];
  groupAnswerActionIds!: Record<string, string>;
  groupConfirmedAnswerActionIds!: Record<string, string>;
  groupName?: string;
  groupAvatarUrl?: string;
  initiatorDisplayName?: string;
  initiatorAvatarUrl?: string;
  ringTimeoutMs?: number;
  expiresAt?: Date;
  callType!: CallType;
  status!: CallSessionStatus;
  participantIds!: string[];
  lifecycleRevision!: number;
  answerActionId?: string;
  answerLeaseExpiresAt?: Date;
  answerEventPublishedAt?: Date;
  answerEventPublishLeaseUntil?: Date;
  /** Durable terminal notification handoff; terminal sessions stay tombstoned. */
  terminalEventPublishedAt?: Date;
  terminalEventPublishLeaseUntil?: Date;
  /** The participant or system actor that committed the terminal transition. */
  terminalActorId?: string;
  terminalReason?: string;
  answeredAt?: Date;
  endedAt?: Date;
  createdAt!: Date;
  updatedAt!: Date;

  constructor(partial: Partial<CallSession>) {
    Object.assign(this, partial);
    this.createdAt = this.toDate(partial.createdAt) ?? new Date();
    this.updatedAt = this.toDate(partial.updatedAt) ?? new Date();
    this.answeredAt = this.toDate(partial.answeredAt);
    this.answerLeaseExpiresAt = this.toDate(partial.answerLeaseExpiresAt);
    this.answerEventPublishedAt = this.toDate(partial.answerEventPublishedAt);
    this.answerEventPublishLeaseUntil = this.toDate(
      partial.answerEventPublishLeaseUntil,
    );
    this.terminalEventPublishedAt = this.toDate(
      partial.terminalEventPublishedAt,
    );
    this.terminalEventPublishLeaseUntil = this.toDate(
      partial.terminalEventPublishLeaseUntil,
    );
    this.endedAt = this.toDate(partial.endedAt);
    this.expiresAt = this.toDate(partial.expiresAt);
    this.participantIds = Array.isArray(partial.participantIds)
      ? partial.participantIds
      : [];
    this.invitedUserIds = Array.isArray(partial.invitedUserIds)
      ? partial.invitedUserIds
      : [
          ...new Set(
            [partial.initiatorId, partial.targetUserId].filter(
              (userId): userId is string => Boolean(userId),
            ),
          ),
        ];
    this.declinedUserIds = Array.isArray(partial.declinedUserIds)
      ? partial.declinedUserIds
      : [];
    this.groupAnswerActionIds = partial.groupAnswerActionIds ?? {};
    this.groupConfirmedAnswerActionIds =
      partial.groupConfirmedAnswerActionIds ?? {};
    this.lifecycleRevision = partial.lifecycleRevision ?? 0;
  }

  private toDate(value?: Date | string): Date | undefined {
    if (!value) return undefined;
    return value instanceof Date ? value : new Date(value);
  }
}
