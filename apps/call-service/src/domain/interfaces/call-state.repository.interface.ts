import { CallParticipant } from '../entities/call-participant.entity';
export abstract class ICallStateRepository {
  abstract upsertParticipant(participant: CallParticipant): Promise<void>;
  abstract removeParticipant(callId: string, userId: string): Promise<void>;
  abstract removeParticipantSocket(
    callId: string,
    userId: string,
    socketId: string,
  ): Promise<CallParticipant | null>;
  abstract getParticipants(callId: string): Promise<CallParticipant[]>;
  abstract getParticipant(
    callId: string,
    userId: string,
  ): Promise<CallParticipant | null>;
  abstract clearCallState(callId: string): Promise<void>;
  /**
   * Participants whose reconnect deadline is at or before `deadlineBefore`.
   * Durable counterpart of the gateway's in-process reconnect timers.
   */
  abstract listExpiredReconnects(
    deadlineBefore: Date,
    limit: number,
  ): Promise<Array<{ callId: string; userId: string }>>;
  abstract forgetReconnect(callId: string, userId: string): Promise<void>;
}
