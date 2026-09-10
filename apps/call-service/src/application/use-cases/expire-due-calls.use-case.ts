import { Inject, Injectable, Logger } from '@nestjs/common';

import { buildCallLifecycleMetadata } from './call-lifecycle-payload';
import type { ICallEventPublisher } from '../../domain/interfaces/call-event.publisher.interface';
import type { ICallMediaEngine } from '../../domain/interfaces/call-media.engine.interface';
import type { ICallSessionRepository } from '../../domain/interfaces/call-session.repository.interface';
import type { ICallStateRepository } from '../../domain/interfaces/call-state.repository.interface';

@Injectable()
export class ExpireDueCallsUseCase {
  private readonly logger = new Logger(ExpireDueCallsUseCase.name);

  constructor(
    @Inject('ICallSessionRepository')
    private readonly sessionRepository: ICallSessionRepository,
    @Inject('ICallStateRepository')
    private readonly stateRepository: ICallStateRepository,
    @Inject('ICallEventPublisher')
    private readonly eventPublisher: ICallEventPublisher,
    @Inject('ICallMediaEngine') private readonly mediaEngine: ICallMediaEngine,
  ) {}

  async execute(now = new Date(), limit = 100) {
    const expiredCalls = await this.sessionRepository.expireDueCalls(
      now,
      limit,
    );

    for (const { session, reason } of expiredCalls) {
      const endedAt = session.endedAt ?? now;
      const cleanupResults = await Promise.allSettled([
        this.mediaEngine.closeRoom(session.callId),
        this.stateRepository.clearCallState(session.callId),
      ]);
      for (const result of cleanupResults) {
        if (result.status === 'rejected') {
          this.logger.warn(
            `Expired call cleanup failed for ${session.callId}: ${
              result.reason instanceof Error
                ? result.reason.message
                : String(result.reason)
            }`,
          );
        }
      }

      try {
        await this.eventPublisher.publish('call.ended', {
          callId: session.callId,
          conversationId: session.conversationId,
          initiatorId: session.initiatorId,
          targetUserId: session.targetUserId,
          userId: session.initiatorId,
          callType: session.callType,
          ...buildCallLifecycleMetadata(session, endedAt),
          reason,
          at: endedAt.toISOString(),
        });
      } catch (error) {
        this.logger.warn(
          `Failed to publish no-answer state for ${session.callId}: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
    }

    return expiredCalls;
  }
}
