import { Inject, Injectable, Logger } from '@nestjs/common';
import type { CallLoggedEvent } from '@common/calls/call-history.types';

import { summarizeCallOutcome } from '../../domain/call-outcome';
import type { CallSession } from '../../domain/entities/call-session.entity';
import type { ICallHistoryRepository } from '../../domain/interfaces/call-history.repository.interface';
import type { ICallLogPublisher } from '../../domain/interfaces/call-log.publisher.interface';
import type { ICallSessionRepository } from '../../domain/interfaces/call-session.repository.interface';
import {
  safeCallErrorCode,
  shortCallIdentifier,
} from '../../infrastructure/gateways/call-debug';

/**
 * Turns finished calls into call history and a chat call log. Runs after the
 * terminal notification is published, in its own outbox, so a history
 * database outage never delays the push that stops other devices ringing.
 * Both writes are idempotent per callId; a failure leaves the call claimed
 * until its lease ends and it is retried.
 */
@Injectable()
export class RecordCallHistoryOutboxUseCase {
  private readonly logger = new Logger(RecordCallHistoryOutboxUseCase.name);

  constructor(
    @Inject('ICallSessionRepository')
    private readonly sessionRepository: ICallSessionRepository,
    @Inject('ICallHistoryRepository')
    private readonly historyRepository: ICallHistoryRepository,
    @Inject('ICallLogPublisher')
    private readonly callLogPublisher: ICallLogPublisher,
  ) {}

  async execute(now = new Date(), limit = 50): Promise<number> {
    const sessions = await this.sessionRepository.claimPendingHistoryEvents(
      now,
      limit,
    );

    for (const session of sessions) {
      try {
        await this.recordSession(session, now);
        await this.sessionRepository.markHistoryRecorded(session.callId);
      } catch (error) {
        this.logger.warn(
          `call history outbox failed call=${shortCallIdentifier(session.callId)} errorCode=${safeCallErrorCode(error)}`,
        );
      }
    }

    return sessions.length;
  }

  private async recordSession(session: CallSession, now: Date) {
    const summary = summarizeCallOutcome(session);
    const endedAt = session.endedAt ?? now;

    await this.historyRepository.record({
      callId: session.callId,
      conversationId: session.conversationId,
      isGroupCall: session.isGroupCall === true,
      callType: session.callType,
      ...(session.isGroupCall && session.groupName
        ? { groupName: session.groupName }
        : {}),
      ...(session.isGroupCall && session.groupAvatarUrl
        ? { groupAvatarUrl: session.groupAvatarUrl }
        : {}),
      initiatorId: session.initiatorId,
      outcome: summary.outcome,
      ...(session.terminalReason
        ? { terminalReason: session.terminalReason }
        : {}),
      startedAt: session.createdAt,
      ...(session.answeredAt ? { answeredAt: session.answeredAt } : {}),
      endedAt,
      ...(summary.durationSec !== undefined
        ? { durationSec: summary.durationSec }
        : {}),
      lifecycleRevision: session.lifecycleRevision ?? 0,
      participants: summary.participants,
    });

    const event: CallLoggedEvent = {
      callId: session.callId,
      conversationId: session.conversationId,
      callType: session.callType,
      isGroupCall: session.isGroupCall === true,
      initiatorId: session.initiatorId,
      outcome: summary.outcome,
      ...(session.terminalReason
        ? { terminalReason: session.terminalReason }
        : {}),
      ...(summary.durationSec !== undefined
        ? { durationSec: summary.durationSec }
        : {}),
      startedAt: session.createdAt.toISOString(),
      endedAt: endedAt.toISOString(),
      participants: summary.participants,
    };
    await this.callLogPublisher.publish(event);
  }
}
