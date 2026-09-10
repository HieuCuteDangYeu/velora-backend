import { Inject, Injectable, Logger } from '@nestjs/common';

import { buildCallLifecycleMetadata } from './call-lifecycle-payload';
import type { CallSession } from '../../domain/entities/call-session.entity';
import type { ICallEventPublisher } from '../../domain/interfaces/call-event.publisher.interface';
import type { ICallMediaEngine } from '../../domain/interfaces/call-media.engine.interface';
import type { ICallSessionRepository } from '../../domain/interfaces/call-session.repository.interface';
import type { ICallStateRepository } from '../../domain/interfaces/call-state.repository.interface';

/**
 * Mediasoup routers and transports are process-local. In the single-instance
 * deployment profile, an active session found on process startup therefore
 * cannot be restored safely and must end visibly for both participants.
 */
@Injectable()
export class RecoverActiveCallsAfterMediaRestartUseCase {
  private readonly logger = new Logger(
    RecoverActiveCallsAfterMediaRestartUseCase.name,
  );

  constructor(
    @Inject('ICallSessionRepository')
    private readonly sessionRepository: ICallSessionRepository,
    @Inject('ICallStateRepository')
    private readonly stateRepository: ICallStateRepository,
    @Inject('ICallMediaEngine') private readonly mediaEngine: ICallMediaEngine,
    @Inject('ICallEventPublisher')
    private readonly eventPublisher: ICallEventPublisher,
  ) {}

  async execute(now = new Date(), limit = 100): Promise<CallSession[]> {
    const batchLimit = Math.max(1, limit);
    const terminatedSessions: CallSession[] = [];

    // The Redis transition removes every examined item from ACTIVE_CALLS_KEY.
    // Drain every full batch so a restart never leaves the 101st active call
    // claiming that its process-local Mediasoup room survived.
    while (true) {
      const sessions =
        await this.sessionRepository.terminateActiveCallsForMediaRestart(
          now,
          batchLimit,
        );
      terminatedSessions.push(...sessions);

      for (const session of sessions) {
        const at = session.endedAt ?? now;
        await Promise.allSettled([
          this.mediaEngine.closeRoom(session.callId),
          this.stateRepository.clearCallState(session.callId),
        ]);
        try {
          await this.eventPublisher.publish('call.ended', {
            callId: session.callId,
            conversationId: session.conversationId,
            initiatorId: session.initiatorId,
            targetUserId: session.targetUserId,
            userId: session.initiatorId,
            callType: session.callType,
            ...buildCallLifecycleMetadata(session, at),
            reason: 'media_unavailable',
            at: at.toISOString(),
          });
        } catch (error) {
          this.logger.warn(
            `Failed to publish restarted-media terminal event call=${session.callId}: ${
              error instanceof Error ? error.message : String(error)
            }`,
          );
        }
      }

      if (sessions.length < batchLimit) {
        return terminatedSessions;
      }
    }
  }
}
