import {
  ForbiddenException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { CallParticipant } from '../../domain/entities/call-participant.entity';
import { buildCallLifecycleMetadata } from './call-lifecycle-payload';
import type { CallSession } from '../../domain/entities/call-session.entity';
import { ICallEventPublisher } from '../../domain/interfaces/call-event.publisher.interface';
import type { ICallMediaEngine } from '../../domain/interfaces/call-media.engine.interface';
import { ICallSessionRepository } from '../../domain/interfaces/call-session.repository.interface';
import type { ICallStateRepository } from '../../domain/interfaces/call-state.repository.interface';
import { AnswerCallUseCase } from './answer-call.use-case';

export type AcceptIncomingCallOutcome =
  | 'accepted'
  | 'already_accepted_same_attempt'
  | 'answered_elsewhere'
  | 'terminal'
  | 'expired'
  | 'unauthorized'
  | 'busy'
  | 'media_unavailable';

export interface AcceptIncomingCallResult {
  callId: string;
  role?: 'guest';
  session?: CallSession;
  rtpCapabilities?: Awaited<
    ReturnType<ICallMediaEngine['getRouterRtpCapabilities']>
  >;
  activeProducers?: Awaited<
    ReturnType<ICallMediaEngine['listActiveProducers']>
  >;
  outcome: AcceptIncomingCallOutcome;
  shouldEmitTerminal?: boolean;
}

type MediaFailureTerminalization = {
  session?: CallSession;
  didTransition: boolean;
};

@Injectable()
export class AcceptIncomingCallUseCase {
  private readonly logger = new Logger(AcceptIncomingCallUseCase.name);

  constructor(
    private readonly answerCallUseCase: AnswerCallUseCase,
    @Inject('ICallSessionRepository')
    private readonly sessionRepository: ICallSessionRepository,
    @Inject('ICallStateRepository')
    private readonly stateRepository: ICallStateRepository,
    @Inject('ICallMediaEngine') private readonly mediaEngine: ICallMediaEngine,
    @Inject('ICallEventPublisher')
    private readonly eventPublisher: ICallEventPublisher,
  ) {}

  async execute(
    callId: string,
    userId: string,
    socketId: string,
    actionId: string,
  ): Promise<AcceptIncomingCallResult> {
    let answer: Awaited<ReturnType<AnswerCallUseCase['execute']>>;
    try {
      answer = await this.answerCallUseCase.execute(callId, userId, actionId);
    } catch (error) {
      if (
        error instanceof ForbiddenException ||
        error instanceof NotFoundException
      ) {
        return { callId, outcome: 'unauthorized' };
      }
      throw error;
    }
    if (answer.outcome === 'expired') {
      // The deadline CAS has already committed a terminal tombstone. Clean
      // transient media now instead of waiting for the periodic expiry sweep,
      // so the gateway can immediately resolve both live call surfaces.
      await this.cleanupTerminalMedia(callId, answer.session);
      return {
        callId,
        session: answer.session,
        outcome: 'expired',
        shouldEmitTerminal: true,
      };
    }
    if (
      answer.outcome === 'answered_elsewhere' ||
      answer.outcome === 'terminal'
    ) {
      return {
        callId,
        session: answer.session,
        outcome: answer.outcome,
      };
    }
    if (answer.outcome === 'busy') {
      const terminalization = await this.terminalizeBusyCall(
        callId,
        answer.session,
      );
      return {
        callId,
        ...(terminalization.session
          ? { session: terminalization.session }
          : { session: answer.session }),
        outcome: 'busy',
        shouldEmitTerminal: terminalization.didTransition,
      };
    }

    // The fresh claim and a retry of that exact still-accepting action both
    // own the short lease. Either may fail the incomplete setup immediately;
    // a retry after the action is already active must never tear down winner.
    let canTerminalizeForMediaFailure =
      answer.session.status === 'accepting' &&
      answer.session.answerActionId === actionId &&
      (answer.outcome === 'accepted' || answer.outcome === 'already_accepted');
    let activeSameAttemptSession: CallSession | undefined;

    try {
      // Room preparation occurs while the durable action is `accepting`. A
      // terminal CAS can still win before the following activation commit.
      await this.mediaEngine.createRoom(callId);
      const rtpCapabilities =
        await this.mediaEngine.getRouterRtpCapabilities(callId);

      const activation = await this.sessionRepository.activateIncomingAnswer(
        callId,
        userId,
        actionId,
        new Date(),
      );
      if (!activation.session) {
        await this.cleanupTransientMedia(callId);
        return { callId, outcome: 'terminal' };
      }
      if (activation.outcome === 'answered_elsewhere') {
        return {
          callId,
          session: activation.session,
          outcome: 'answered_elsewhere',
        };
      }
      if (activation.outcome === 'expired') {
        await this.cleanupTerminalMedia(callId, activation.session);
        return { callId, session: activation.session, outcome: 'expired' };
      }
      if (activation.outcome === 'terminal') {
        await this.cleanupTerminalMedia(callId, activation.session);
        return { callId, session: activation.session, outcome: 'terminal' };
      }
      if (activation.outcome === 'busy') {
        const terminalization = await this.terminalizeBusyCall(
          callId,
          activation.session,
        );
        return {
          callId,
          ...(terminalization.session
            ? { session: terminalization.session }
            : { session: activation.session }),
          outcome: 'busy',
          shouldEmitTerminal: terminalization.didTransition,
        };
      }
      if (
        activation.outcome === 'forbidden' ||
        activation.outcome === 'not_found'
      ) {
        return { callId, outcome: 'unauthorized' };
      }

      canTerminalizeForMediaFailure = activation.outcome === 'accepted';
      if (
        activation.session?.status === 'active' &&
        activation.session.answerActionId === actionId
      ) {
        activeSameAttemptSession = activation.session;
      }
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
          role: 'guest',
          socketId,
          socketIds,
          isConnected: true,
          reconnectDeadlineAt: undefined,
          joinedAt: existingParticipant?.joinedAt ?? new Date(),
        }),
      );

      const activeProducers = await this.mediaEngine.listActiveProducers(
        callId,
        userId,
      );
      return {
        callId,
        role: 'guest',
        session: activation.session,
        rtpCapabilities,
        activeProducers,
        outcome:
          activation.outcome === 'already_accepted'
            ? 'already_accepted_same_attempt'
            : 'accepted',
      };
    } catch (error) {
      const terminalization = canTerminalizeForMediaFailure
        ? await this.terminalizeMediaFailure(callId, userId, actionId)
        : { didTransition: false };
      const recoveredAttempt = await this.recoverActiveSameAttempt(
        callId,
        userId,
        socketId,
        actionId,
        terminalization.session ?? activeSameAttemptSession,
      );
      if (recoveredAttempt) {
        return recoveredAttempt;
      }
      this.logger.warn(
        `Incoming call media preparation failed call=${callId}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      return {
        callId,
        ...(terminalization.session
          ? { session: terminalization.session }
          : {}),
        outcome: 'media_unavailable',
        shouldEmitTerminal: terminalization.didTransition,
      };
    }
  }

  private async terminalizeMediaFailure(
    callId: string,
    userId: string,
    actionId: string,
  ): Promise<MediaFailureTerminalization> {
    return this.terminalizeCall(
      callId,
      userId,
      actionId,
      'media_unavailable',
      'accept_failure',
    );
  }

  private async terminalizeBusyCall(
    callId: string,
    session: CallSession,
  ): Promise<MediaFailureTerminalization> {
    return this.terminalizeCall(callId, session.initiatorId, undefined, 'busy');
  }

  private async terminalizeCall(
    callId: string,
    userId: string,
    actionId: string | undefined,
    reason: 'busy' | 'media_unavailable',
    mode: 'leave' | 'accept_failure' = 'leave',
  ): Promise<MediaFailureTerminalization> {
    let session: CallSession | undefined;
    let didTransition = false;
    try {
      const transition =
        mode === 'accept_failure' && actionId
          ? await this.sessionRepository.transitionToTerminal(
              callId,
              userId,
              reason,
              new Date(),
              mode,
              actionId,
            )
          : await this.sessionRepository.transitionToTerminal(
              callId,
              userId,
              reason,
              new Date(),
              mode,
            );
      session = transition.session ?? undefined;
      didTransition = transition.outcome === 'transitioned';
    } catch (cleanupError) {
      this.logger.warn(
        `Failed to terminalize ${reason} call=${callId}: ${
          cleanupError instanceof Error
            ? cleanupError.message
            : String(cleanupError)
        }`,
      );
    }

    // Local media/state cleanup must not depend on the event publisher. The
    // caller may have cancelled concurrently; a terminal session is still safe
    // to clean, while an active winner is deliberately left alone.
    if (session && this.isTerminal(session)) {
      await this.cleanupTransientMedia(callId);
    }

    if (session && didTransition) {
      const at = session.endedAt ?? new Date();
      try {
        await this.eventPublisher.publish('call.ended', {
          callId,
          conversationId: session.conversationId,
          initiatorId: session.initiatorId,
          targetUserId: session.targetUserId,
          userId,
          callType: session.callType,
          ...(actionId ? { answerActionId: actionId } : {}),
          ...buildCallLifecycleMetadata(session, at),
          reason,
          at: at.toISOString(),
        });
      } catch (publishError) {
        this.logger.warn(
          `Failed to publish ${reason} terminal call=${callId}: ${
            publishError instanceof Error
              ? publishError.message
              : String(publishError)
          }`,
        );
      }
    }

    return { ...(session ? { session } : {}), didTransition };
  }

  private async recoverActiveSameAttempt(
    callId: string,
    userId: string,
    socketId: string,
    actionId: string,
    session: CallSession | undefined,
  ): Promise<AcceptIncomingCallResult | undefined> {
    if (session?.status !== 'active' || session.answerActionId !== actionId) {
      return undefined;
    }

    try {
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
          role: 'guest',
          socketId,
          socketIds,
          isConnected: true,
          reconnectDeadlineAt: undefined,
          joinedAt: existingParticipant?.joinedAt ?? new Date(),
        }),
      );

      return {
        callId,
        role: 'guest',
        session,
        rtpCapabilities:
          await this.mediaEngine.getRouterRtpCapabilities(callId),
        activeProducers: await this.mediaEngine.listActiveProducers(
          callId,
          userId,
        ),
        outcome: 'already_accepted_same_attempt',
      };
    } catch (recoveryError) {
      this.logger.warn(
        `Failed to recover active incoming answer call=${callId}: ${
          recoveryError instanceof Error
            ? recoveryError.message
            : String(recoveryError)
        }`,
      );
      return undefined;
    }
  }

  private async cleanupTerminalMedia(
    callId: string,
    session: CallSession,
  ): Promise<void> {
    if (this.isTerminal(session)) {
      await this.cleanupTransientMedia(callId);
    }
  }

  private async cleanupTransientMedia(callId: string): Promise<void> {
    await Promise.allSettled([
      this.mediaEngine.closeRoom(callId),
      this.stateRepository.clearCallState(callId),
    ]);
  }

  private isTerminal(session: CallSession): boolean {
    return ['ended', 'cancelled', 'rejected'].includes(session.status);
  }
}
