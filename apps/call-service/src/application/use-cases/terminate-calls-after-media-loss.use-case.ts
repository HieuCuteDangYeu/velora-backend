import { Inject, Injectable, Logger } from '@nestjs/common';

import type { CallSession } from '../../domain/entities/call-session.entity';
import type { ICallSessionRepository } from '../../domain/interfaces/call-session.repository.interface';
import {
  safeCallErrorCode,
  shortCallIdentifier,
} from '../../infrastructure/gateways/call-debug';

/**
 * A mediasoup worker process died, taking the routers of its calls with it.
 * Those calls can never carry media again, so end them visibly instead of
 * leaving an `active` session (and "busy" users) behind. The terminal
 * transition enqueues the durable `call.ended` push and the room/state
 * cleanup, so this only has to win the Redis transition.
 */
@Injectable()
export class TerminateCallsAfterMediaLossUseCase {
  private readonly logger = new Logger(
    TerminateCallsAfterMediaLossUseCase.name,
  );

  constructor(
    @Inject('ICallSessionRepository')
    private readonly sessionRepository: ICallSessionRepository,
  ) {}

  /** Returns the sessions this call actually moved to a terminal state. */
  async execute(callIds: string[], now = new Date()): Promise<CallSession[]> {
    const ended: CallSession[] = [];
    for (const callId of callIds) {
      try {
        const session = await this.sessionRepository.findByCallId(callId);
        if (!session) continue;
        const transition = await this.sessionRepository.transitionToTerminal(
          callId,
          session.initiatorId,
          'media_unavailable',
          now,
          'leave',
        );
        if (transition.outcome === 'transitioned' && transition.session) {
          ended.push(transition.session);
        }
      } catch (error) {
        // Other calls on the dead worker must still be ended.
        this.logger.warn(
          `Failed to end call after media loss call=${shortCallIdentifier(callId)} errorCode=${safeCallErrorCode(error)}`,
        );
      }
    }
    return ended;
  }
}
