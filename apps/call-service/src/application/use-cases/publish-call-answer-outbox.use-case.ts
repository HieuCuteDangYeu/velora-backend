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

    const groupEvents =
      await this.sessionRepository.claimPendingGroupInvitationEvents(
        now,
        limit,
      );
    for (const event of groupEvents) {
      try {
        const session = await this.sessionRepository.findByCallId(event.callId);
        if (session) {
          await this.eventPublisher.publish(event.event, {
            callId: event.callId,
            conversationId: session.conversationId,
            initiatorId: session.initiatorId,
            targetUserId: event.userId,
            userId: event.userId,
            callType: session.callType,
            ...buildCallLifecycleMetadata(session, new Date(event.at)),
            recipientUserId: event.userId,
            invitedUserIds: [event.userId],
            isGroupCall: true,
            lifecycleRevision: event.lifecycleRevision,
            ...(event.actionId ? { answerActionId: event.actionId } : {}),
            ...(event.reason ? { reason: event.reason } : {}),
            at: event.at,
          });
        }
        await this.sessionRepository.markGroupInvitationEventPublished(
          event.key,
        );
      } catch (error) {
        this.logger.warn(
          `group invitation event publish failed call=${event.callId} user=${event.userId}: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
    }

    return events.length + groupEvents.length;
  }
}
