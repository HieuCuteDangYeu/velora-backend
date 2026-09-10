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
    this.participantIds = partial.participantIds ?? [];
    this.lifecycleRevision = partial.lifecycleRevision ?? 0;
  }

  private toDate(value?: Date | string): Date | undefined {
    if (!value) return undefined;
    return value instanceof Date ? value : new Date(value);
  }
}
