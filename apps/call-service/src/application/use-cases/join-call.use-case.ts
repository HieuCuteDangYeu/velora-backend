import {
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { CallParticipant } from '../../domain/entities/call-participant.entity';
import { CallSession } from '../../domain/entities/call-session.entity';
import {
  ICallMediaEngine,
  type RouterRtpCapabilitiesResult,
} from '../../domain/interfaces/call-media.engine.interface';
import { ICallSessionRepository } from '../../domain/interfaces/call-session.repository.interface';
import { ICallStateRepository } from '../../domain/interfaces/call-state.repository.interface';

export interface JoinCallResult {
  role: 'host' | 'guest';
  session: CallSession;
  rtpCapabilities: RouterRtpCapabilitiesResult;
  peerUserId?: string;
  shouldEmitNewPeer: boolean;
}

/**
 * Lets the Socket.IO boundary resolve an expired legacy join immediately
 * without treating it like an authorization failure. The session is already
 * terminalized atomically by Redis before this error is raised.
 */
export class CallExpiredError extends ForbiddenException {
  constructor(readonly session: CallSession) {
    super('Call has expired');
  }
}

@Injectable()
export class JoinCallUseCase {
  constructor(
    @Inject('ICallSessionRepository')
    private readonly sessionRepository: ICallSessionRepository,
    @Inject('ICallStateRepository')
    private readonly stateRepository: ICallStateRepository,
    @Inject('ICallMediaEngine') private readonly mediaEngine: ICallMediaEngine,
  ) {}

  async execute(
    callId: string,
    userId: string,
    socketId: string,
  ): Promise<JoinCallResult> {
    const now = new Date();
    const transition = await this.sessionRepository.joinParticipant(
      callId,
      userId,
      now,
    );
    const session = transition.session;

    if (transition.outcome === 'not_found' || !session) {
      throw new NotFoundException('Call not found');
    }
    if (transition.outcome === 'expired') {
      // The durable join transition commits the terminal tombstone at the
      // deadline. Do not leave the caller's pre-created room alive until the
      // periodic sweep catches up.
      await Promise.allSettled([
        this.mediaEngine.closeRoom(callId),
        this.stateRepository.clearCallState(callId),
      ]);
      throw new CallExpiredError(session);
    }
    if (transition.outcome === 'terminal') {
      throw new ForbiddenException('Call is no longer active');
    }
    if (transition.outcome === 'forbidden') {
      throw new ForbiddenException('You are not part of this call');
    }

    const role = session.initiatorId === userId ? 'host' : 'guest';

    const existingParticipant = await this.stateRepository.getParticipant(
      callId,
      userId,
    );
    const socketIds = [
      ...new Set([...(existingParticipant?.socketIds ?? []), socketId]),
    ];

    await this.stateRepository.upsertParticipant(
      new CallParticipant({
        userId,
        callId,
        role,
        socketId,
        socketIds,
        isConnected: true,
        reconnectDeadlineAt: undefined,
        joinedAt: now,
      }),
    );

    const peerUserId =
      role === 'host' ? session.targetUserId : session.initiatorId;

    return {
      role,
      session,
      rtpCapabilities: await this.mediaEngine.getRouterRtpCapabilities(callId),
      peerUserId,
      shouldEmitNewPeer: transition.joinedNow && role === 'guest',
    };
  }
}
