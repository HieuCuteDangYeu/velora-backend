import { CallSession } from '../entities/call-session.entity';

export type CallJoinTransition = {
  outcome:
    | 'joined'
    | 'terminal'
    | 'expired'
    | 'invitation_expired'
    | 'busy'
    | 'declined'
    | 'answered_elsewhere'
    | 'forbidden'
    | 'not_found';
  session: CallSession | null;
  joinedNow: boolean;
};

export type CallAnswerTransition = {
  outcome:
    | 'accepted'
    | 'already_accepted'
    | 'answered_elsewhere'
    | 'terminal'
    | 'expired'
    | 'busy'
    | 'forbidden'
    | 'not_found';
  session: CallSession | null;
  shouldPublishEvent: boolean;
};

export type CallActivationTransition = {
  outcome:
    | 'accepted'
    | 'already_accepted'
    | 'answered_elsewhere'
    | 'terminal'
    | 'expired'
    | 'busy'
    | 'forbidden'
    | 'not_found';
  session: CallSession | null;
};

export type CallTerminalTransition = {
  outcome:
    | 'transitioned'
    | 'already_terminal'
    | 'active'
    | 'participant_left'
    | 'stale'
    | 'forbidden'
    | 'not_found';
  session: CallSession | null;
  reason?: string;
  wasActive: boolean;
};

export type CallExpiryTransition = {
  session: CallSession;
  reason: 'no_answer' | 'media_unavailable';
};

export type GroupInvitationRejection = {
  outcome:
    | 'rejected'
    | 'already_rejected'
    | 'active'
    | 'terminal'
    | 'forbidden'
    | 'not_found';
  session: CallSession | null;
};

export type CallAnswerOutboxEvent = {
  session: CallSession;
  actionId: string;
};

export type CallTerminalOutboxEvent = {
  session: CallSession;
  event: 'call.ended' | 'call.rejected';
  reason: string;
  userId: string;
};

export type GroupInvitationOutboxEvent = {
  key: string;
  event: 'call.answered' | 'call.rejected';
  callId: string;
  userId: string;
  lifecycleRevision: number;
  at: string;
  actionId?: string;
  reason?: string;
};

export abstract class ICallSessionRepository {
  abstract save(session: CallSession): Promise<CallSession>;
  /** Atomically reserves the initiator's active-call slot for a new group room. */
  abstract createActiveGroupSession(session: CallSession): Promise<boolean>;
  abstract findByCallId(callId: string): Promise<CallSession | null>;
  abstract delete(callId: string): Promise<void>;
  abstract joinParticipant(
    callId: string,
    userId: string,
    now: Date,
    actionId?: string,
  ): Promise<CallJoinTransition>;
  abstract rejectGroupInvitation(
    callId: string,
    userId: string,
    now: Date,
    reason: string,
  ): Promise<GroupInvitationRejection>;
  abstract confirmGroupInvitationJoin(
    callId: string,
    userId: string,
    actionId: string,
    now: Date,
  ): Promise<boolean>;
  abstract abortGroupInvitationJoin(
    callId: string,
    userId: string,
    actionId: string,
    now: Date,
  ): Promise<boolean>;
  abstract claimIncomingAnswer(
    callId: string,
    userId: string,
    actionId: string,
    now: Date,
  ): Promise<CallAnswerTransition>;
  /**
   * Commits an already-claimed answer only if its action is still the winner.
   * The implementation must enqueue the call.answered outbox record in the
   * same atomic transition as `accepting -> active`.
   */
  abstract activateIncomingAnswer(
    callId: string,
    userId: string,
    actionId: string,
    now: Date,
  ): Promise<CallActivationTransition>;
  /** Claims durable call.answered outbox work without blocking answer ACKs. */
  abstract claimPendingAnswerEvents(
    now: Date,
    limit: number,
  ): Promise<CallAnswerOutboxEvent[]>;
  abstract markAnswerEventPublished(
    callId: string,
    actionId: string,
    now: Date,
  ): Promise<void>;
  abstract claimPendingGroupInvitationEvents(
    now: Date,
    limit: number,
  ): Promise<GroupInvitationOutboxEvent[]>;
  abstract markGroupInvitationEventPublished(key: string): Promise<void>;
  /**
   * Claims terminal lifecycle notifications that were committed in the same
   * Redis transition as their tombstone. This protects offline CallKit cleanup
   * when RabbitMQ is unavailable at the moment a call ends.
   */
  abstract claimPendingTerminalEvents(
    now: Date,
    limit: number,
  ): Promise<CallTerminalOutboxEvent[]>;
  abstract markTerminalEventPublished(
    callId: string,
    lifecycleRevision: number,
    now: Date,
  ): Promise<void>;
  abstract transitionToTerminal(
    callId: string,
    userId: string,
    requestedReason: string | undefined,
    now: Date,
    mode: 'leave' | 'reject' | 'accept_failure',
    expectedAnswerActionId?: string,
  ): Promise<CallTerminalTransition>;
  /**
   * Claims and terminalizes expired ringing sessions so restart recovery does
   * not depend on an in-memory gateway timer surviving a deploy.
   */
  abstract expireDueCalls(
    now: Date,
    limit: number,
  ): Promise<CallExpiryTransition[]>;
  /**
   * A Mediasoup room lives in process memory. At a single-instance service
   * restart, existing active sessions cannot be truthfully recovered, so they
   * must become terminal instead of accepting media work against an empty room.
   */
  abstract terminateActiveCallsForMediaRestart(
    now: Date,
    limit: number,
  ): Promise<CallSession[]>;
}
