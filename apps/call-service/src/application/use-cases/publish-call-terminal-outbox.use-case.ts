import { Inject, Injectable, Logger } from '@nestjs/common';

import { buildCallLifecycleMetadata } from './call-lifecycle-payload';
import type { ICallEventPublisher } from '../../domain/interfaces/call-event.publisher.interface';
import type { ICallSessionRepository } from '../../domain/interfaces/call-session.repository.interface';
import type { ICallStateRepository } from '../../domain/interfaces/call-state.repository.interface';
import {
  safeCallErrorCode,
  shortCallIdentifier,
} from '../../infrastructure/gateways/call-debug';

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
    @Inject('ICallStateRepository')
    private readonly stateRepository: ICallStateRepository,
  ) {}

  async execute(now = new Date(), limit = 100): Promise<number> {
    const events = await this.sessionRepository.claimPendingTerminalEvents(
      now,
      limit,
    );

    for (const { session, event, reason, userId } of events) {
      let published = false;
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
        published = true;
      } catch (error) {
        this.logger.warn(
          `terminal call outbox publish failed call=${shortCallIdentifier(session.callId)} errorCode=${safeCallErrorCode(error)}`,
        );
      }

      let cleaned = false;
      try {
        await this.stateRepository.clearCallState(session.callId);
        cleaned = true;
      } catch (error) {
        this.logger.warn(
          `terminal call state cleanup failed call=${shortCallIdentifier(session.callId)} errorCode=${safeCallErrorCode(error)}`,
        );
      }

      if (!published || !cleaned) continue;
      try {
        await this.sessionRepository.markTerminalEventPublished(
          session.callId,
          session.lifecycleRevision,
          new Date(),
        );
      } catch (error) {
        // Publication and cleanup are idempotent; retry if the outbox ACK fails.
        this.logger.warn(
          `terminal call outbox ack failed call=${shortCallIdentifier(session.callId)} errorCode=${safeCallErrorCode(error)}`,
        );
      }
    }

    return events.length;
  }
}
