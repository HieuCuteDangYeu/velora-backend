import {
  ForbiddenException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { buildCallLifecycleMetadata } from './call-lifecycle-payload';
import type { CallSession } from '../../domain/entities/call-session.entity';
import { ICallEventPublisher } from '../../domain/interfaces/call-event.publisher.interface';
import { ICallMediaEngine } from '../../domain/interfaces/call-media.engine.interface';
import { ICallSessionRepository } from '../../domain/interfaces/call-session.repository.interface';
import { ICallStateRepository } from '../../domain/interfaces/call-state.repository.interface';

export interface RejectCallResult {
  session: CallSession;
  reason: string;
  didTransition: boolean;
}

@Injectable()
export class RejectCallUseCase {
  private readonly logger = new Logger(RejectCallUseCase.name);

  constructor(
    @Inject('ICallSessionRepository')
    private readonly sessionRepository: ICallSessionRepository,
    @Inject('ICallStateRepository')
    private readonly stateRepository: ICallStateRepository,
    @Inject('ICallEventPublisher')
    private readonly eventPublisher: ICallEventPublisher,
    @Inject('ICallMediaEngine') private readonly mediaEngine: ICallMediaEngine,
  ) {}

  async execute(
    callId: string,
    userId: string,
    reason = 'rejected',
  ): Promise<RejectCallResult> {
    const transition = await this.sessionRepository.transitionToTerminal(
      callId,
      userId,
      reason,
      new Date(),
      'reject',
    );
    const session = transition.session;

    if (transition.outcome === 'not_found' || !session) {
      throw new NotFoundException('Call not found');
    }
    if (transition.outcome === 'forbidden') {
      throw new ForbiddenException('Only the callee can reject this call');
    }
    if (transition.outcome === 'active') {
      throw new ForbiddenException('Active calls cannot be rejected');
    }
    if (transition.outcome === 'already_terminal') {
      return {
        session,
        reason: transition.reason ?? reason,
        didTransition: false,
      };
    }

    const now = session.endedAt ?? new Date();
    const terminalReason = transition.reason ?? reason;

    try {
      await this.eventPublisher.publish('call.rejected', {
        callId,
        conversationId: session.conversationId,
        initiatorId: session.initiatorId,
        targetUserId: session.targetUserId,
        userId,
        callType: session.callType,
        ...buildCallLifecycleMetadata(session, now),
        reason: terminalReason,
        at: now.toISOString(),
      });
    } catch (error) {
      this.logger.warn(
        `Failed to publish rejection for ${callId}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }

    const cleanupResults = await Promise.allSettled([
      this.mediaEngine.closeRoom(callId),
      this.stateRepository.clearCallState(callId),
    ]);
    for (const result of cleanupResults) {
      if (result.status === 'rejected') {
        this.logger.warn(
          `Rejected call cleanup failed for ${callId}: ${
            result.reason instanceof Error
              ? result.reason.message
              : String(result.reason)
          }`,
        );
      }
    }

    return { session, reason: terminalReason, didTransition: true };
  }
}
