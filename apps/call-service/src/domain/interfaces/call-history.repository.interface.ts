import type {
  CallHistoryPage,
  CallLogParticipant,
  CallRecordOutcome,
} from '@common/calls/call-history.types';
import type { CallType } from '../entities/call-session.entity';

export interface CallHistoryRecord {
  callId: string;
  conversationId: string;
  isGroupCall: boolean;
  callType: CallType;
  groupName?: string;
  groupAvatarUrl?: string;
  initiatorId: string;
  outcome: CallRecordOutcome;
  terminalReason?: string;
  startedAt: Date;
  answeredAt?: Date;
  endedAt: Date;
  durationSec?: number;
  lifecycleRevision: number;
  participants: CallLogParticipant[];
}

export class InvalidCallHistoryCursorError extends Error {
  constructor() {
    super('Invalid call history cursor');
  }
}

export abstract class ICallHistoryRepository {
  /** False when no history database is configured. */
  abstract isEnabled(): boolean;
  /** Idempotent per callId; an older lifecycleRevision never overwrites. */
  abstract record(record: CallHistoryRecord): Promise<void>;
  /** Throws InvalidCallHistoryCursorError for a malformed cursor. */
  abstract listForUser(
    userId: string,
    options: { cursor?: string; limit: number },
  ): Promise<CallHistoryPage>;
  abstract countUnseenMissed(userId: string): Promise<number>;
  /** Marks every unseen missed call of the user as seen; returns the count. */
  abstract markMissedSeen(userId: string, seenAt: Date): Promise<number>;
}
