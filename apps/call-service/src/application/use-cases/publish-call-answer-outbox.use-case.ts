import { Inject, Injectable, Logger } from '@nestjs/common';

import { buildCallLifecycleMetadata } from './call-lifecycle-payload';
import type { ICallEventPublisher } from '../../domain/interfaces/call-event.publisher.interface';
import type { ICallSessionRepository } from '../../domain/interfaces/call-session.repository.interface';

/**
 * Publishes only events that were durably committed with `accepting -> active`.
 * A failed message stays lease-retryable in Redis; one poisoned event never
 * prevents later call events from being attempted.
 */
@Injectable()
export class PublishCallAnswerOutboxUseCase {
  private readonly logger = new Logger(PublishCallAnswerOutboxUseCase.name);

  constructor(
    @Inject('ICallSessionRepository')
    private readonly sessionRepository: ICallSessionRepository,
    @Inject('ICallEventPublisher')
    private readonly eventPublisher: ICallEventPublisher,
  ) {}

  async execute(now = new Date(), limit = 100): Promise<number> {
    const events = await this.sessionRepository.claimPendingAnswerEvents(
      now,
      limit,
    );

    for (const { session, actionId } of events) {
      try {
        const at = session.updatedAt ?? now;
        await this.eventPublisher.publish('call.answered', {
          callId: session.callId,
          conversationId: session.conversationId,
          initiatorId: session.initiatorId,
          targetUserId: session.targetUserId,
          userId: session.targetUserId,
          callType: session.callType,
          answerActionId: actionId,
          ...buildCallLifecycleMetadata(session, at),
          at: at.toISOString(),
        });
        await this.sessionRepository.markAnswerEventPublished(
          session.callId,
          actionId,
          new Date(),
        );
      } catch (error) {
        // The Redis lease will make this event eligible again. Continue the
        // batch so a single telemetry/publisher failure is quarantined.
        this.logger.warn(
          `call.answered outbox publish failed call=${session.callId}: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
    }

    return events.length;
  }
}
