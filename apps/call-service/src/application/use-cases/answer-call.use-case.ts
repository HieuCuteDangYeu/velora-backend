import {
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import type { CallSession } from '../../domain/entities/call-session.entity';
import { ICallSessionRepository } from '../../domain/interfaces/call-session.repository.interface';

export interface AnswerCallResult {
  session: CallSession;
  outcome:
    | 'accepted'
    | 'already_accepted'
    | 'answered_elsewhere'
    | 'terminal'
    | 'expired'
    | 'busy';
}

@Injectable()
export class AnswerCallUseCase {
  constructor(
    @Inject('ICallSessionRepository')
    private readonly sessionRepository: ICallSessionRepository,
  ) {}

  async execute(
    callId: string,
    userId: string,
    actionId: string,
  ): Promise<AnswerCallResult> {
    const now = new Date();
    const transition = await this.sessionRepository.claimIncomingAnswer(
      callId,
      userId,
      actionId,
      now,
    );
    const session = transition.session;

    if (transition.outcome === 'not_found' || !session) {
      throw new NotFoundException('Call not found');
    }
    if (transition.outcome === 'forbidden') {
      throw new ForbiddenException('Only the callee can answer this call');
    }
    if (
      transition.outcome === 'expired' ||
      transition.outcome === 'terminal' ||
      transition.outcome === 'answered_elsewhere' ||
      transition.outcome === 'busy'
    ) {
      return { session, outcome: transition.outcome };
    }

    return {
      session,
      outcome:
        transition.outcome === 'already_accepted'
          ? 'already_accepted'
          : 'accepted',
    };
  }
}
