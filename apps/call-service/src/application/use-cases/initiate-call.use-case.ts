import { randomUUID } from 'crypto';
import {
  BadRequestException,
  ForbiddenException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { ClientProxy } from '@nestjs/microservices';
import { lastValueFrom, timeout } from 'rxjs';
import { CallParticipant } from '../../domain/entities/call-participant.entity';
import {
  CallSession,
  type CallType,
} from '../../domain/entities/call-session.entity';
import { ICallEventPublisher } from '../../domain/interfaces/call-event.publisher.interface';
import {
  ICallMediaEngine,
  type RouterRtpCapabilitiesResult,
} from '../../domain/interfaces/call-media.engine.interface';
import { ICallSessionRepository } from '../../domain/interfaces/call-session.repository.interface';
import { ICallStateRepository } from '../../domain/interfaces/call-state.repository.interface';
import { buildCallLifecycleMetadata } from './call-lifecycle-payload';
import { getCallNoAnswerTimeoutMs } from '../../domain/call-lifecycle-config';

interface ConversationDetailResponse {
  id?: string;
  participantIds?: string[];
  participants?: Array<{
    id?: string;
    userId?: string;
    name?: string;
    fullName?: string;
    avatar?: string;
  }>;
  isGroup?: boolean;
}

export interface InitiateCallResult {
  role: 'host';
  session: CallSession;
  rtpCapabilities: RouterRtpCapabilitiesResult;
}

@Injectable()
export class InitiateCallUseCase {
  private readonly logger = new Logger(InitiateCallUseCase.name);
  private readonly ringTimeoutMs = getCallNoAnswerTimeoutMs();

  constructor(
    @Inject('ICallSessionRepository')
    private readonly sessionRepository: ICallSessionRepository,
    @Inject('ICallStateRepository')
    private readonly stateRepository: ICallStateRepository,
    @Inject('ICallEventPublisher')
    private readonly eventPublisher: ICallEventPublisher,
    @Inject('ICallMediaEngine') private readonly mediaEngine: ICallMediaEngine,
    @Inject('CONVERSATION_SERVICE_RMQ')
    private readonly conversationClient: ClientProxy,
  ) {}

  async execute(
    conversationId: string,
    initiatorId: string,
    targetUserId: string,
    callType: CallType,
    socketId: string,
  ): Promise<InitiateCallResult> {
    const now = new Date();
    const callId = randomUUID();
    const conversation = await this.getConversationOrThrow(
      conversationId,
      initiatorId,
    );
    const participantIds = this.extractParticipantIds(conversation);

    if (!participantIds.includes(initiatorId)) {
      throw new ForbiddenException(
        'You are not a participant of this conversation',
      );
    }

    if (conversation.isGroup || participantIds.length !== 2) {
      throw new BadRequestException(
        'Call initiation is only supported for direct conversations',
      );
    }

    const resolvedTargetUserId = participantIds.find(
      (participantId) => participantId !== initiatorId,
    );

    if (!resolvedTargetUserId) {
      throw new BadRequestException(
        'Direct conversation peer could not be resolved',
      );
    }

    if (targetUserId !== resolvedTargetUserId) {
      throw new BadRequestException(
        'Target user does not match the direct conversation participant',
      );
    }

    const initiatorDisplay = conversation.participants?.find(
      (participant) =>
        participant.id === initiatorId || participant.userId === initiatorId,
    );
    const initiatorDisplayName =
      initiatorDisplay?.name?.trim() ||
      initiatorDisplay?.fullName?.trim() ||
      'Incoming call';
    const expiresAt = new Date(now.getTime() + this.ringTimeoutMs);
    let session: CallSession | undefined;
    // Set before publishing: a transport error can still mean RabbitMQ
    // accepted the message, so the rollback must make any late ringing push
    // terminal rather than leaving a ghost incoming call.
    let initiationPublishAttempted = false;
    try {
      await this.mediaEngine.createRoom(callId);

      session = new CallSession({
        callId,
        conversationId,
        initiatorId,
        targetUserId: resolvedTargetUserId,
        initiatorDisplayName,
        initiatorAvatarUrl: initiatorDisplay?.avatar?.trim() || undefined,
        ringTimeoutMs: this.ringTimeoutMs,
        expiresAt,
        callType,
        status: 'initiated',
        participantIds: [initiatorId],
        createdAt: now,
        updatedAt: now,
      });

      await this.sessionRepository.save(session);
      await this.stateRepository.upsertParticipant(
        new CallParticipant({
          userId: initiatorId,
          callId,
          role: 'host',
          socketId,
          isConnected: true,
          reconnectDeadlineAt: undefined,
          joinedAt: now,
        }),
      );

      initiationPublishAttempted = true;
      await this.eventPublisher.publish('call.initiated', {
        callId,
        conversationId,
        initiatorId,
        targetUserId: resolvedTargetUserId,
        recipientUserId: resolvedTargetUserId,
        userId: initiatorId,
        callType,
        initiatorDisplayName,
        initiatorAvatarUrl: session.initiatorAvatarUrl,
        ringTimeoutMs: this.ringTimeoutMs,
        expiresAt: expiresAt.toISOString(),
        at: now.toISOString(),
      });

      return {
        role: 'host',
        session,
        rtpCapabilities:
          await this.mediaEngine.getRouterRtpCapabilities(callId),
      };
    } catch (error) {
      await this.rollbackFailedInitiation({
        callId,
        initiatorId,
        session,
        initiationPublishAttempted,
      });
      throw error;
    }
  }

  private async rollbackFailedInitiation({
    callId,
    initiatorId,
    session,
    initiationPublishAttempted,
  }: {
    callId: string;
    initiatorId: string;
    session: CallSession | undefined;
    initiationPublishAttempted: boolean;
  }): Promise<void> {
    let terminalSession: CallSession | undefined;
    let didTransition = false;

    if (session) {
      try {
        const transition = await this.sessionRepository.transitionToTerminal(
          callId,
          initiatorId,
          'failed',
          new Date(),
          'leave',
        );
        terminalSession = transition.session ?? undefined;
        didTransition = transition.outcome === 'transitioned';
      } catch (rollbackError) {
        this.logger.warn(
          `Failed to terminalize failed initiation call=${callId}: ${
            rollbackError instanceof Error
              ? rollbackError.message
              : String(rollbackError)
          }`,
        );
      }
    }

    // If the initial publish may have reached consumers, publish the winning
    // terminal revision too. Consumers dedupe by lifecycle revision, so this
    // is safe both for an acknowledged publish and an ambiguous timeout.
    if (initiationPublishAttempted && didTransition && terminalSession) {
      const endedAt = terminalSession.endedAt ?? new Date();
      try {
        await this.eventPublisher.publish('call.ended', {
          callId,
          conversationId: terminalSession.conversationId,
          initiatorId: terminalSession.initiatorId,
          targetUserId: terminalSession.targetUserId,
          userId: initiatorId,
          callType: terminalSession.callType,
          ...buildCallLifecycleMetadata(terminalSession, endedAt),
          reason: 'failed',
          at: endedAt.toISOString(),
        });
      } catch (publishError) {
        this.logger.warn(
          `Failed to publish failed-initiation terminal state call=${callId}: ${
            publishError instanceof Error
              ? publishError.message
              : String(publishError)
          }`,
        );
      }
    }

    // A createRoom failure can still have allocated process-local resources.
    // Cleanup is therefore unconditional and intentionally cannot mask the
    // original initiation error.
    const cleanupResults = await Promise.allSettled([
      this.mediaEngine.closeRoom(callId),
      this.stateRepository.clearCallState(callId),
    ]);
    for (const result of cleanupResults) {
      if (result.status === 'rejected') {
        this.logger.warn(
          `Failed to clean up failed initiation call=${callId}: ${
            result.reason instanceof Error
              ? result.reason.message
              : String(result.reason)
          }`,
        );
      }
    }
  }

  private async getConversationOrThrow(
    conversationId: string,
    initiatorId: string,
  ): Promise<ConversationDetailResponse> {
    try {
      const conversation = await lastValueFrom(
        this.conversationClient
          .send<ConversationDetailResponse>('get_conversation_detail', {
            id: conversationId,
            userId: initiatorId,
          })
          .pipe(timeout(5000)),
      );

      if (!conversation?.id) {
        throw new NotFoundException('Conversation not found');
      }

      return conversation;
    } catch (error: unknown) {
      if (error instanceof NotFoundException) {
        throw error;
      }

      const message = error instanceof Error ? error.message : String(error);
      if (message.includes('Conversation not found')) {
        throw new NotFoundException('Conversation not found');
      }

      if (message.includes('not a participant')) {
        throw new ForbiddenException(
          'You are not a participant of this conversation',
        );
      }

      throw error;
    }
  }

  private extractParticipantIds(
    conversation: ConversationDetailResponse,
  ): string[] {
    if (Array.isArray(conversation.participantIds)) {
      return conversation.participantIds.filter(
        (participantId): participantId is string =>
          typeof participantId === 'string' && participantId.length > 0,
      );
    }

    if (Array.isArray(conversation.participants)) {
      return conversation.participants
        .map((participant) => participant.id ?? participant.userId)
        .filter(
          (participantId): participantId is string =>
            typeof participantId === 'string' && participantId.length > 0,
        );
    }

    return [];
  }
}
