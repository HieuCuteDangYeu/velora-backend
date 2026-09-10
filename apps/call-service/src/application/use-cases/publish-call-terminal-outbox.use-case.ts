import { Inject, Injectable, Logger } from '@nestjs/common';

import { buildCallLifecycleMetadata } from './call-lifecycle-payload';
import type { ICallEventPublisher } from '../../domain/interfaces/call-event.publisher.interface';
import type { ICallSessionRepository } from '../../domain/interfaces/call-session.repository.interface';

/**
 * Terminal transitions are already durable in Redis. Publish their
 * notification separately with a lease so a RabbitMQ outage cannot leave a
 * cold or offline device with stale native call UI.
 */
@Injectable()
export class PublishCallTerminalOutboxUseCase {
  private readonly logger = new Logger(PublishCallTerminalOutboxUseCase.name);

  constructor(
    @Inject('ICallSessionRepository')
    private readonly sessionRepository: ICallSessionRepository,
    @Inject('ICallEventPublisher')
    private readonly eventPublisher: ICallEventPublisher,
  ) {}

  async execute(now = new Date(), limit = 100): Promise<number> {
    const events = await this.sessionRepository.claimPendingTerminalEvents(
      now,
      limit,
    );

    for (const { session, event, reason, userId } of events) {
      try {
        const at = session.endedAt ?? now;
        await this.eventPublisher.publish(event, {
          callId: session.callId,
          conversationId: session.conversationId,
          initiatorId: session.initiatorId,
          targetUserId: session.targetUserId,
          userId,
          callType: session.callType,
          ...buildCallLifecycleMetadata(session, at),
          reason,
          at: at.toISOString(),
        });
        await this.sessionRepository.markTerminalEventPublished(
          session.callId,
          session.lifecycleRevision,
          new Date(),
        );
      } catch (error) {
        // Keep the leased entry retryable and continue the batch. A poisoned
        // terminal event must not block cleanup for another call.
        this.logger.warn(
          `terminal call outbox publish failed call=${session.callId}: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
    }

    return events.length;
  }
}
