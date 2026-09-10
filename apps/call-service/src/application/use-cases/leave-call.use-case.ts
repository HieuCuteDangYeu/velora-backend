import {
  ForbiddenException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { buildCallLifecycleMetadata } from './call-lifecycle-payload';
import { CallSession } from '../../domain/entities/call-session.entity';
import { ICallEventPublisher } from '../../domain/interfaces/call-event.publisher.interface';
import { ICallMediaEngine } from '../../domain/interfaces/call-media.engine.interface';
import { ICallSessionRepository } from '../../domain/interfaces/call-session.repository.interface';
import { ICallStateRepository } from '../../domain/interfaces/call-state.repository.interface';

export interface LeaveCallResult {
  session: CallSession;
  endedReason: string;
  shouldEmitPeerLeft: boolean;
  didTransition: boolean;
}

@Injectable()
export class LeaveCallUseCase {
  private readonly logger = new Logger(LeaveCallUseCase.name);

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
    requestedReason?: string,
  ): Promise<LeaveCallResult> {
    const transition = await this.sessionRepository.transitionToTerminal(
      callId,
      userId,
      requestedReason,
      new Date(),
      'leave',
    );
    const session = transition.session;

    if (transition.outcome === 'not_found' || !session) {
      throw new NotFoundException('Call not found');
    }
    if (transition.outcome === 'forbidden') {
      throw new ForbiddenException('You are not part of this call');
    }
    if (transition.outcome === 'already_terminal') {
      return {
        session,
        endedReason: transition.reason ?? 'ended',
        shouldEmitPeerLeft: false,
        didTransition: false,
      };
    }

    const now = session.endedAt ?? new Date();
    const endedReason = transition.reason ?? 'ended';

    try {
      await this.eventPublisher.publish('call.ended', {
        callId,
        conversationId: session.conversationId,
        initiatorId: session.initiatorId,
        targetUserId: session.targetUserId,
        userId,
        callType: session.callType,
        ...buildCallLifecycleMetadata(session, now),
        reason: endedReason,
        at: now.toISOString(),
      });
    } catch (error) {
      this.logger.warn(
        `Failed to publish terminal state for ${callId}: ${
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
          `Call cleanup failed for ${callId}: ${
            result.reason instanceof Error
              ? result.reason.message
              : String(result.reason)
          }`,
        );
      }
    }

    return {
      session,
      endedReason,
      shouldEmitPeerLeft: transition.wasActive,
      didTransition: true,
    };
  }
}
