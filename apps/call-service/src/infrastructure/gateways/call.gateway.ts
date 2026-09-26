import type { AuthUser } from '@common/auth/interfaces/auth-user.interface';
import { CallTelemetryTokenService } from '@common/calls/call-telemetry-token.service';
import {
  BadRequestException,
  ForbiddenException,
  Inject,
  Logger,
  NotFoundException,
  ServiceUnavailableException,
  OnApplicationBootstrap,
  OnModuleDestroy,
  OnModuleInit,
  UseFilters,
} from '@nestjs/common';
import { ClientProxy } from '@nestjs/microservices';
import {
  ConnectedSocket,
  MessageBody,
  OnGatewayConnection,
  OnGatewayDisconnect,
  SubscribeMessage,
  WebSocketGateway,
  WebSocketServer,
} from '@nestjs/websockets';
import { catchError, lastValueFrom, of, timeout } from 'rxjs';
import { Server, Socket } from 'socket.io';
import { AcceptIncomingCallUseCase } from '../../application/use-cases/accept-incoming-call.use-case';
import { ChangeCallTypeUseCase } from '../../application/use-cases/change-call-type.use-case';
import { ConnectTransportUseCase } from '../../application/use-cases/connect-transport.use-case';
import { ConsumeUseCase } from '../../application/use-cases/consume.use-case';
import { CreateTransportUseCase } from '../../application/use-cases/create-transport.use-case';
import { ExpireDueCallsUseCase } from '../../application/use-cases/expire-due-calls.use-case';
import { RecoverActiveCallsAfterMediaRestartUseCase } from '../../application/use-cases/recover-active-calls-after-media-restart.use-case';
import { InitiateCallUseCase } from '../../application/use-cases/initiate-call.use-case';
import {
  CallExpiredError,
  GroupJoinMediaUnavailableError,
  JoinCallUseCase,
} from '../../application/use-cases/join-call.use-case';
import { LeaveCallUseCase } from '../../application/use-cases/leave-call.use-case';
import { ProduceUseCase } from '../../application/use-cases/produce.use-case';
import { RejectCallUseCase } from '../../application/use-cases/reject-call.use-case';
import { RestartIceUseCase } from '../../application/use-cases/restart-ice.use-case';
import { ResumeConsumerUseCase } from '../../application/use-cases/resume-consumer.use-case';
import { CallParticipant } from '../../domain/entities/call-participant.entity';
import type { CallSession } from '../../domain/entities/call-session.entity';
import type {
  ActiveProducerResult,
  ICallMediaEngine,
  RouterRtpCapabilitiesResult,
} from '../../domain/interfaces/call-media.engine.interface';
import type { ICallSessionRepository } from '../../domain/interfaces/call-session.repository.interface';
import type { ICallStateRepository } from '../../domain/interfaces/call-state.repository.interface';
import { CallServiceRuntimeLease } from '../runtime/call-service-runtime-lease.service';
import { CallWsExceptionFilter } from './call-ws-exception.filter';
import { getCallSocketHeartbeatConfig } from './call-socket-config';
import { safeCallErrorCode, shortCallIdentifier } from './call-debug';
import { CallPrometheusMetricsService } from '../metrics/call-prometheus-metrics.service';
import {
  getCallNoAnswerTimeoutMs,
  getSessionExpiryDate,
  getSessionRingTimeoutMs,
} from '../../domain/call-lifecycle-config';

type InitiateCallPayload = {
  conversationId: string;
  targetUserId?: string;
  selectedInviteeIds?: string[];
  callType: 'VOICE' | 'VIDEO';
};

type JoinCallPayload = {
  callId: string;
};

type LegacyAnswerCallPayload = JoinCallPayload & {
  /**
   * Optional so existing clients keep their original answer_call contract.
   * A rollback-capable new client sends its native action id, which lets the
   * active state update distinguish its own winner from another device.
   */
  actionId?: string;
};

type AcceptIncomingCallPayload = JoinCallPayload & {
  actionId: string;
};

type RejoinCallPayload = {
  callId: string;
  actionId?: string;
};

type LeaveCallPayload = {
  callId: string;
  reason?: string;
  /** A supplied winner action must match; it never grants socket permission. */
  actionId?: string;
};

type CreateTransportPayload = {
  callId: string;
  direction: 'send' | 'recv';
};

type ConnectTransportPayload = {
  callId: string;
  transportId: string;
  dtlsParameters: Record<string, unknown>;
};

type ProducePayload = {
  callId: string;
  transportId: string;
  kind: 'audio' | 'video';
  rtpParameters: Record<string, unknown>;
  requestId?: string;
  audioEnabled?: boolean;
};

type CloseProducerPayload = {
  callId: string;
  producerId: string;
  kind: 'audio' | 'video';
  requestId?: string;
};

type ConsumePayload = {
  callId: string;
  transportId: string;
  producerId: string;
  rtpCapabilities: Record<string, unknown>;
  requestId?: string;
};

type ResumeConsumerPayload = {
  callId: string;
  consumerId: string;
};

type CloseConsumerPayload = {
  callId: string;
  consumerId: string;
  requestId?: string;
};

type ConsumerClosedAckPayload = {
  callId: string;
  consumerId: string;
  status: 'closed' | 'already_closed';
  requestId?: string;
};

type RestartIcePayload = {
  callId: string;
  transportId: string;
};

type SetCallTypePayload = {
  callId: string;
  callType: 'VOICE' | 'VIDEO';
};

type SetVideoEnabledPayload = {
  callId: string;
  producerId: string;
  enabled: boolean;
  revision?: number;
  actionId?: string;
  requestId?: string;
};

type SetGroupMicStatePayload = {
  callId: string;
  producerId: string;
  enabled: boolean;
  revision: number;
  actionId?: string;
  requestId?: string;
};

type VideoStateRecord = {
  enabled: boolean;
  revision: number;
  actionId?: string;
};

type VideoStateUpdateStatus = 'applied' | 'stale' | 'already_applied';

type VideoStateUpdatedPayload = {
  callId: string;
  producerId: string;
  userId: string;
  enabled: boolean;
  revision: number;
  status: VideoStateUpdateStatus;
  actionId?: string;
  requestId?: string;
};

type ProducerClosedAckPayload = {
  callId: string;
  producerId: string;
  kind: 'audio' | 'video';
  status: 'closed' | 'already_closed';
  requestId?: string;
};

type AudioBitrateProfile = 'normal' | 'constrained';

type SetAudioBitratePayload = {
  callId: string;
  transportId: string;
  profile: AudioBitrateProfile;
};

const AUDIO_BITRATE_BY_PROFILE: Record<AudioBitrateProfile, number> = {
  normal: 48_000,
  constrained: 32_000,
};

type ClientCallSession = Pick<
  CallSession,
  | 'callId'
  | 'conversationId'
  | 'initiatorId'
  | 'targetUserId'
  | 'isGroupCall'
  | 'invitedUserIds'
  | 'groupName'
  | 'groupAvatarUrl'
  | 'initiatorDisplayName'
  | 'initiatorAvatarUrl'
  | 'ringTimeoutMs'
  | 'expiresAt'
  | 'callType'
  | 'status'
  | 'participantIds'
  | 'answeredAt'
  | 'endedAt'
  | 'terminalReason'
  | 'createdAt'
  | 'updatedAt'
>;

function clientCallSession(session: CallSession): ClientCallSession {
  const {
    callId,
    conversationId,
    initiatorId,
    targetUserId,
    isGroupCall,
    invitedUserIds,
    groupName,
    groupAvatarUrl,
    initiatorDisplayName,
    initiatorAvatarUrl,
    ringTimeoutMs,
    expiresAt,
    callType,
    status,
    participantIds,
    answeredAt,
    endedAt,
    terminalReason,
    createdAt,
    updatedAt,
  } = session;
  return {
    callId,
    conversationId,
    initiatorId,
    targetUserId,
    isGroupCall,
    invitedUserIds,
    groupName,
    groupAvatarUrl,
    initiatorDisplayName,
    initiatorAvatarUrl,
    ringTimeoutMs,
    expiresAt,
    callType,
    status,
    participantIds,
    answeredAt,
    endedAt,
    terminalReason,
    createdAt,
    updatedAt,
  };
}

type CallJoinedSocketPayload = {
  callId: string;
  role: 'host' | 'guest';
  session: ClientCallSession;
  rtpCapabilities: RouterRtpCapabilitiesResult;
  activeProducers: ActiveProducerResult[];
  noAnswerTimeoutMs?: number;
  telemetryToken: string;
};

type IncomingCallAcceptanceSocketPayload = {
  callId: string;
  outcome:
    | 'accepted'
    | 'already_accepted_same_attempt'
    | 'answered_elsewhere'
    | 'terminal'
    | 'expired'
    | 'unauthorized'
    | 'busy'
    | 'media_unavailable';
  role?: 'guest';
  session?: ClientCallSession;
  rtpCapabilities?: RouterRtpCapabilitiesResult;
  activeProducers?: ActiveProducerResult[];
  telemetryToken?: string;
  noAnswerTimeoutMs?: number;
  reservationReleased?: boolean;
  retryable?: boolean;
};

type RecentTerminalCall = {
  callId: string;
  reason: string;
};

type StoredRecentTerminalCall = RecentTerminalCall & {
  isGroupCall: boolean;
  expiresAtMs: number;
};

@WebSocketGateway({
  namespace: '/call',
  cors: { origin: '*' },
  ...getCallSocketHeartbeatConfig(),
})
@UseFilters(new CallWsExceptionFilter())
export class CallGateway
  implements
    OnGatewayConnection,
    OnGatewayDisconnect,
    OnModuleInit,
    OnApplicationBootstrap,
    OnModuleDestroy
{
  @WebSocketServer() server!: Server;

  private readonly logger = new Logger(CallGateway.name);
  private readonly reconnectGraceMs = Number(
    process.env.CALL_RECONNECT_GRACE_MS || 15000,
  );
  private readonly noAnswerTimeoutMs = getCallNoAnswerTimeoutMs();
  private readonly expirySweepIntervalMs = Math.max(
    1000,
    Number(process.env.CALL_EXPIRY_SWEEP_INTERVAL_MS || 5000) || 5000,
  );
  private readonly terminalReplayTtlMs = Number(
    process.env.CALL_TERMINAL_REPLAY_TTL_MS || 60000,
  );
  private readonly recentTerminalCallsByUser = new Map<
    string,
    Map<string, StoredRecentTerminalCall>
  >();
  private readonly pendingDisconnects = new Map<
    string,
    ReturnType<typeof setTimeout>
  >();
  private readonly pendingUnansweredCalls = new Map<
    string,
    ReturnType<typeof setTimeout>
  >();
  private readonly reconnectStartedAtByParticipant = new Map<string, number>();
  private readonly videoStatesByProducer = new Map<string, VideoStateRecord>();
  private readonly videoStateQueues = new Map<string, Promise<void>>();
  private readonly groupMicStates = new Map<
    string,
    VideoStateRecord & { producerId: string }
  >();
  private readonly groupMicQueues = new Map<string, Promise<void>>();
  private readonly groupAcceptQueues = new Map<string, Promise<void>>();
  private expirySweepTimer?: ReturnType<typeof setInterval>;
  private expirySweepInFlight = false;

  constructor(
    private readonly initiateCallUseCase: InitiateCallUseCase,
    private readonly joinCallUseCase: JoinCallUseCase,
    private readonly createTransportUseCase: CreateTransportUseCase,
    private readonly connectTransportUseCase: ConnectTransportUseCase,
    private readonly produceUseCase: ProduceUseCase,
    private readonly consumeUseCase: ConsumeUseCase,
    private readonly leaveCallUseCase: LeaveCallUseCase,
    private readonly rejectCallUseCase: RejectCallUseCase,
    private readonly acceptIncomingCallUseCase: AcceptIncomingCallUseCase,
    private readonly expireDueCallsUseCase: ExpireDueCallsUseCase,
    private readonly recoverActiveCallsAfterMediaRestartUseCase: RecoverActiveCallsAfterMediaRestartUseCase,
    private readonly resumeConsumerUseCase: ResumeConsumerUseCase,
    private readonly restartIceUseCase: RestartIceUseCase,
    private readonly changeCallTypeUseCase: ChangeCallTypeUseCase,
    @Inject('ICallMediaEngine')
    private readonly mediaEngine: ICallMediaEngine,
    @Inject('ICallSessionRepository')
    private readonly sessionRepository: ICallSessionRepository,
    @Inject('ICallStateRepository')
    private readonly stateRepository: ICallStateRepository,
    @Inject('AUTH_SERVICE_RMQ') private readonly authClient: ClientProxy,
    private readonly telemetryTokenService: CallTelemetryTokenService,
    private readonly runtimeLease: CallServiceRuntimeLease,
    private readonly metrics: CallPrometheusMetricsService,
  ) {}

  async onModuleInit(): Promise<void> {
    await this.runtimeLease.acquire();
    this.runtimeLease.assertHeld();
    // A process-local timeout gives prompt feedback, while the Redis-backed
    // sweep makes expiration survive deploys and gateway restarts.
    this.expirySweepTimer = setInterval(() => {
      void this.sweepExpiredCalls();
    }, this.expirySweepIntervalMs);
    this.expirySweepTimer.unref?.();
    void this.sweepExpiredCalls();
  }

  onModuleDestroy(): void {
    if (this.expirySweepTimer) {
      clearInterval(this.expirySweepTimer);
      this.expirySweepTimer = undefined;
    }

    for (const timeoutId of this.pendingDisconnects.values()) {
      clearTimeout(timeoutId);
    }
    this.pendingDisconnects.clear();

    for (const timeoutId of this.pendingUnansweredCalls.values()) {
      clearTimeout(timeoutId);
    }
    this.pendingUnansweredCalls.clear();
    this.reconnectStartedAtByParticipant.clear();
    this.videoStatesByProducer.clear();
    this.videoStateQueues.clear();
    this.groupMicStates.clear();
    this.groupMicQueues.clear();
  }

  async onApplicationBootstrap(): Promise<void> {
    try {
      this.runtimeLease.assertHeld();
      const lostActiveCalls =
        await this.recoverActiveCallsAfterMediaRestartUseCase.execute();
      for (const session of lostActiveCalls) {
        this.emitCallEnded(session, 'media_unavailable');
      }
    } catch (error) {
      // Startup must fail closed at the call level, not by leaving existing
      // active sessions pretending that their in-memory media still exists.
      this.logger.error(
        `Failed to reconcile active calls after media startup errorCode=${safeCallErrorCode(error)}`,
      );
      throw error;
    }
  }

  private videoStateKey(callId: string, producerId: string): string {
    return `${callId}:${producerId}`;
  }

  private groupMicStateKey(callId: string, userId: string): string {
    return `${callId}:${userId}`;
  }

  private clearGroupMicState(callId: string, userId?: string): void {
    const prefix = userId
      ? this.groupMicStateKey(callId, userId)
      : `${callId}:`;
    for (const key of this.groupMicStates.keys()) {
      if (userId ? key === prefix : key.startsWith(prefix)) {
        this.groupMicStates.delete(key);
        this.groupMicQueues.delete(key);
      }
    }
  }

  private async withGroupMicQueue<T>(
    callId: string,
    userId: string,
    operation: () => Promise<T>,
  ): Promise<T> {
    const key = this.groupMicStateKey(callId, userId);
    const previous = this.groupMicQueues.get(key) ?? Promise.resolve();
    const result = previous.catch(() => undefined).then(operation);
    const tail = result.then(
      () => undefined,
      () => undefined,
    );
    this.groupMicQueues.set(key, tail);
    try {
      return await result;
    } finally {
      if (this.groupMicQueues.get(key) === tail)
        this.groupMicQueues.delete(key);
    }
  }

  private getVideoState(callId: string, producerId: string): VideoStateRecord {
    return (
      this.videoStatesByProducer.get(
        this.videoStateKey(callId, producerId),
      ) ?? {
        enabled: true,
        revision: 0,
      }
    );
  }

  private getVideoStateForProducer(
    callId: string,
    producer: ActiveProducerResult,
  ): VideoStateRecord {
    const stored = this.videoStatesByProducer.get(
      this.videoStateKey(callId, producer.producerId),
    );
    if (stored) return stored;

    // mediasoup owns the producer's pause bit. Use it as the bootstrap value
    // after a gateway restart, then start the durable client-visible revision
    // at zero until the first explicit camera action is applied.
    return {
      enabled: producer.paused !== true,
      revision: producer.revision ?? 0,
    };
  }

  private decorateActiveProducers(
    callId: string,
    producers: ActiveProducerResult[],
  ): ActiveProducerResult[] {
    return producers.map((producer) => {
      if (producer.kind === 'audio') {
        const mic = this.groupMicStates.get(
          this.groupMicStateKey(callId, producer.userId),
        );
        return mic?.producerId === producer.producerId
          ? { ...producer, paused: !mic.enabled, revision: mic.revision }
          : producer;
      }
      if (producer.kind !== 'video') return producer;
      const state = this.getVideoStateForProducer(callId, producer);
      return {
        ...producer,
        paused: !state.enabled,
        revision: state.revision,
      };
    });
  }

  private clearVideoState(callId: string, producerId?: string): void {
    const prefix = `${callId}:`;
    for (const key of this.videoStatesByProducer.keys()) {
      if (
        key === `${prefix}${producerId}` ||
        (!producerId && key.startsWith(prefix))
      ) {
        this.videoStatesByProducer.delete(key);
      }
    }

    if (producerId) {
      this.videoStateQueues.delete(`${prefix}${producerId}`);
      return;
    }
    for (const key of this.videoStateQueues.keys()) {
      if (key.startsWith(prefix)) this.videoStateQueues.delete(key);
    }
  }

  async handleConnection(client: Socket) {
    // Nest's OnGatewayDisconnect hook does not pass Socket.IO's reason, so
    // capture it at the socket boundary while keeping the metric label
    // normalized inside CallPrometheusMetricsService.
    client.once('disconnect', (reason: string) => {
      this.metrics.recordSocketDisconnect(reason);
    });

    const userId = await this.resolveUserId(client);
    if (!userId) {
      client.disconnect(true);
      return;
    }

    await client.join(userId);
    if (this.isGroupLifecycleCapable(client)) {
      await client.join(this.groupUserRoom(userId));
    }
    client.emit('call_socket_ready', {
      recentTerminalCalls: this.getRecentTerminalCalls(
        userId,
        this.isGroupLifecycleCapable(client),
      ),
    });
    this.logger.log(`Socket connected ${shortCallIdentifier(client.id)}`);
  }

  async handleDisconnect(client: Socket) {
    const userId = this.getResolvedUserId(client);
    if (!userId) {
      return;
    }

    const callIds = this.getTrackedCallIds(client);
    for (const callId of callIds) {
      try {
        await this.reconcileDisconnectedCall(callId, userId, client.id);
      } catch (error) {
        this.logger.warn(
          `Disconnect cleanup failed for call ${shortCallIdentifier(callId)} errorCode=${safeCallErrorCode(error)}`,
        );
      }
    }
  }

  @SubscribeMessage('initiate_call')
  async handleInitiateCall(
    @MessageBody() payload: InitiateCallPayload,
    @ConnectedSocket() client: Socket,
  ) {
    const userId = await this.resolveUserId(client);
    if (!userId) return;

    const result = await this.initiateCallUseCase.execute(
      payload.conversationId,
      userId,
      payload.targetUserId,
      payload.callType,
      client.id,
      this.groupLifecycleVersion(client),
      payload.selectedInviteeIds,
    );

    if (
      !(await this.attachLiveSocketToCall(
        client,
        result.session.callId,
        userId,
      ))
    ) {
      return;
    }

    client.emit('call_joined', {
      callId: result.session.callId,
      role: result.role,
      session: clientCallSession(result.session),
      rtpCapabilities: result.rtpCapabilities,
      activeProducers: [],
      telemetryToken: this.telemetryTokenService.issue(
        result.session.callId,
        result.role,
      ),
      noAnswerTimeoutMs: this.noAnswerTimeoutMs,
    } satisfies CallJoinedSocketPayload);

    const ringTimeoutMs = getSessionRingTimeoutMs(result.session.ringTimeoutMs);
    const expiresAt = getSessionExpiryDate(
      result.session.expiresAt,
      ringTimeoutMs,
    );
    const recipients = result.session.isGroupCall
      ? result.session.invitedUserIds.filter(
          (recipientUserId) => recipientUserId !== result.session.initiatorId,
        )
      : [result.session.targetUserId];
    for (const recipientUserId of recipients) {
      this.server
        .to(
          result.session.isGroupCall
            ? this.groupUserRoom(recipientUserId)
            : recipientUserId,
        )
        .emit('incoming_call', {
          callId: result.session.callId,
          conversationId: result.session.conversationId,
          initiatorId: result.session.initiatorId,
          targetUserId: recipientUserId,
          recipientUserId,
          initiatorDisplayName:
            result.session.initiatorDisplayName ?? 'Incoming call',
          initiatorAvatarUrl: result.session.initiatorAvatarUrl,
          ringTimeoutMs,
          expiresAt: expiresAt.toISOString(),
          callType: result.session.callType,
          isGroupCall: result.session.isGroupCall,
          groupName: result.session.groupName,
          groupAvatarUrl: result.session.groupAvatarUrl,
        });
    }

    if (!result.session.isGroupCall)
      this.scheduleUnansweredCallTimeout(result.session);
  }

  @SubscribeMessage('join_call')
  async handleJoinCall(
    @MessageBody() payload: JoinCallPayload,
    @ConnectedSocket() client: Socket,
  ) {
    const userId = await this.resolveUserId(client);
    if (!userId) return;

    if (!this.isGroupLifecycleCapable(client)) {
      const session = await this.sessionRepository.findByCallId(payload.callId);
      this.assertGroupLifecycleCapable(client, session);
    }

    let result: Awaited<ReturnType<JoinCallUseCase['execute']>>;
    try {
      result = await this.joinCallUseCase.execute(
        payload.callId,
        userId,
        client.id,
      );
    } catch (error) {
      if (error instanceof CallExpiredError) {
        this.clearPendingUnansweredCall(payload.callId);
        this.emitCallEnded(
          error.session,
          error.session.terminalReason ?? 'no_answer',
        );
      }
      throw error;
    }

    if (!(await this.attachLiveSocketToCall(client, payload.callId, userId))) {
      return;
    }
    this.clearPendingDisconnect(payload.callId, userId);
    this.recordSocketReconnect(payload.callId, userId);

    const activeProducers = this.decorateActiveProducers(
      payload.callId,
      await this.mediaEngine.listActiveProducers(payload.callId, userId),
    );

    client.emit('call_joined', {
      callId: payload.callId,
      role: result.role,
      session: clientCallSession(result.session),
      rtpCapabilities: result.rtpCapabilities,
      activeProducers,
      telemetryToken: this.telemetryTokenService.issue(
        payload.callId,
        result.role,
      ),
      noAnswerTimeoutMs: this.noAnswerTimeoutMs,
    } satisfies CallJoinedSocketPayload);

    if (result.shouldEmitNewPeer) {
      client.to(payload.callId).emit('new_peer', {
        callId: payload.callId,
        userId,
      });
    }
  }

  @SubscribeMessage('join_group_call')
  async handleJoinGroupCall(
    @MessageBody() payload: AcceptIncomingCallPayload,
    @ConnectedSocket() client: Socket,
  ) {
    const userId = await this.resolveUserId(client);
    if (!userId) return;
    const actionId = payload.actionId?.trim();
    if (!actionId || actionId.length > 128) {
      throw new BadRequestException('A call action id is required');
    }
    const session = await this.sessionRepository.findByCallId(payload.callId);
    this.assertGroupLifecycleCapable(client, session);
    if (!session?.isGroupCall || session.status !== 'active') {
      throw new ForbiddenException('Group call is no longer active');
    }
    if (session.initiatorId === userId) {
      throw new ForbiddenException('Host must rejoin the existing call');
    }
    const key = this.disconnectKey(payload.callId, userId);
    const previous = this.groupAcceptQueues.get(key) ?? Promise.resolve();
    const operation = previous
      .catch(() => undefined)
      .then(() =>
        this.acceptGroupInvitation(
          client,
          payload.callId,
          userId,
          actionId,
          true,
        ),
      );
    const tail = operation.then(
      () => undefined,
      () => undefined,
    );
    this.groupAcceptQueues.set(key, tail);
    try {
      await operation;
    } finally {
      if (this.groupAcceptQueues.get(key) === tail) {
        this.groupAcceptQueues.delete(key);
      }
    }
  }

  @SubscribeMessage('rejoin_call')
  async handleRejoinCall(
    @MessageBody() payload: RejoinCallPayload,
    @ConnectedSocket() client: Socket,
  ) {
    const userId = await this.resolveUserId(client);
    if (!userId) return;

    const session = await this.sessionRepository.findByCallId(payload.callId);
    if (!session) {
      throw new NotFoundException('Call not found');
    }
    this.assertGroupLifecycleCapable(client, session);

    if (session.status !== 'active') {
      throw new ForbiddenException('Call is not recoverable');
    }

    const groupActionId = payload.actionId?.trim();
    if (
      session.isGroupCall &&
      userId !== session.initiatorId &&
      (!groupActionId ||
        session.groupConfirmedAnswerActionIds[userId] !== groupActionId)
    ) {
      throw new ForbiddenException('This device did not answer the group call');
    }

    const participant = await this.stateRepository.getParticipant(
      payload.callId,
      userId,
    );
    if (!participant) {
      throw new ForbiddenException('You are not part of this call');
    }

    if (
      !participant.isConnected &&
      (!participant.reconnectDeadlineAt ||
        participant.reconnectDeadlineAt.getTime() <= Date.now())
    ) {
      throw new ForbiddenException('Reconnect window expired');
    }

    const result = groupActionId
      ? await this.joinCallUseCase.execute(
          payload.callId,
          userId,
          client.id,
          groupActionId,
        )
      : await this.joinCallUseCase.execute(payload.callId, userId, client.id);

    if (!(await this.attachLiveSocketToCall(client, payload.callId, userId))) {
      return;
    }
    this.clearPendingDisconnect(payload.callId, userId);
    this.recordSocketReconnect(payload.callId, userId);

    const activePeerProducers = this.decorateActiveProducers(
      payload.callId,
      await this.mediaEngine.listActiveProducers(payload.callId, userId),
    );

    client.emit('call_rejoined', {
      callId: payload.callId,
      role: result.role,
      session: clientCallSession(result.session),
      rtpCapabilities: result.rtpCapabilities,
      activeProducers: activePeerProducers,
      telemetryToken: this.telemetryTokenService.issue(
        payload.callId,
        result.role,
      ),
    });

    client.to(payload.callId).emit('peer_reconnected', {
      callId: payload.callId,
      userId,
    });

    activePeerProducers.forEach((producer) => {
      client.emit('new_producer', {
        callId: payload.callId,
        userId: producer.userId,
        producerId: producer.producerId,
        kind: producer.kind,
        paused: producer.paused ?? false,
        ...(producer.revision !== undefined
          ? { revision: producer.revision }
          : {}),
      });
    });

    const rejoinedUserProducers = this.decorateActiveProducers(
      payload.callId,
      (await this.mediaEngine.listActiveProducers(payload.callId)).filter(
        (producer) => producer.userId === userId,
      ),
    );

    rejoinedUserProducers.forEach((producer) => {
      client.to(payload.callId).emit('new_producer', {
        callId: payload.callId,
        userId: producer.userId,
        producerId: producer.producerId,
        kind: producer.kind,
        paused: producer.paused ?? false,
        ...(producer.revision !== undefined
          ? { revision: producer.revision }
          : {}),
      });
    });
  }

  @SubscribeMessage('create_transport')
  async handleCreateTransport(
    @MessageBody() payload: CreateTransportPayload,
    @ConnectedSocket() client: Socket,
  ) {
    const userId = await this.resolveUserId(client);
    if (!userId) return;
    this.assertSocketJoinedToCall(client, payload.callId);

    let transport: Awaited<ReturnType<CreateTransportUseCase['execute']>>;
    try {
      transport = await this.createTransportUseCase.execute(
        payload.callId,
        userId,
        payload.direction,
      );
    } catch (error) {
      this.metrics.recordCallEvent('media_failed');
      throw error;
    }
    this.metrics.recordCallEvent('media_ready');

    client.emit('transport_created', {
      callId: payload.callId,
      ...transport,
    });
  }

  @SubscribeMessage('connect_transport')
  async handleConnectTransport(
    @MessageBody() payload: ConnectTransportPayload,
    @ConnectedSocket() client: Socket,
  ) {
    const userId = await this.resolveUserId(client);
    if (!userId) return;
    this.assertSocketJoinedToCall(client, payload.callId);

    await this.connectTransportUseCase.execute(
      payload.callId,
      userId,
      payload.transportId,
      payload.dtlsParameters,
    );

    client.emit('transport_connected', {
      callId: payload.callId,
      transportId: payload.transportId,
    });
  }

  @SubscribeMessage('produce')
  async handleProduce(
    @MessageBody() payload: ProducePayload,
    @ConnectedSocket() client: Socket,
  ) {
    const userId = await this.resolveUserId(client);
    if (!userId) return;
    this.assertSocketJoinedToCall(client, payload.callId);
    if (
      payload.audioEnabled !== undefined &&
      typeof payload.audioEnabled !== 'boolean'
    ) {
      throw new BadRequestException('Invalid initial audio state');
    }

    const session =
      payload.kind === 'audio'
        ? await this.sessionRepository.findByCallId(payload.callId)
        : null;
    if (session?.isGroupCall && payload.kind === 'audio') {
      return this.withGroupMicQueue(payload.callId, userId, () =>
        this.produceForSocket(payload, client, userId, true),
      );
    }
    return this.produceForSocket(payload, client, userId, false);
  }

  private async produceForSocket(
    payload: ProducePayload,
    client: Socket,
    userId: string,
    isGroupAudio: boolean,
  ): Promise<void> {
    this.assertSocketJoinedToCall(client, payload.callId);
    const result = await this.produceUseCase.execute(
      payload.callId,
      userId,
      payload.transportId,
      payload.kind,
      payload.rtpParameters,
      payload.requestId,
    );

    const { producerId, replacedProducerId } = result;
    if (isGroupAudio) {
      const key = this.groupMicStateKey(payload.callId, userId);
      const previous = this.groupMicStates.get(key);
      const enabled = previous?.enabled ?? payload.audioEnabled ?? true;
      if (!enabled) {
        try {
          await this.mediaEngine.pauseProducer(
            payload.callId,
            userId,
            producerId,
          );
        } catch (error) {
          await this.mediaEngine
            .closeProducer(payload.callId, userId, producerId)
            .catch(() => undefined);
          throw error;
        }
      }
      const latestSession = await this.sessionRepository.findByCallId(
        payload.callId,
      );
      if (
        !latestSession?.isGroupCall ||
        latestSession.status !== 'active' ||
        !latestSession.participantIds.includes(userId) ||
        !this.isSocketJoinedToCall(client, payload.callId)
      ) {
        await this.mediaEngine
          .closeProducer(payload.callId, userId, producerId)
          .catch(() => undefined);
        throw new ForbiddenException(
          'Group audio producer is no longer authorized',
        );
      }
      if (previous || payload.audioEnabled !== undefined) {
        this.groupMicStates.set(key, {
          producerId,
          enabled,
          revision: previous?.revision ?? 0,
        });
      }
    }
    if (replacedProducerId) {
      client.to(payload.callId).emit('producer_closed', {
        callId: payload.callId,
        producerId: replacedProducerId,
        kind: payload.kind,
      });
    }

    client.emit('producer_created', {
      callId: payload.callId,
      userId,
      transportId: payload.transportId,
      producerId,
      kind: payload.kind,
      ...(payload.requestId ? { requestId: payload.requestId } : {}),
    });

    if (payload.kind === 'video') {
      const key = this.videoStateKey(payload.callId, producerId);
      const replacementState = replacedProducerId
        ? this.videoStatesByProducer.get(
            this.videoStateKey(payload.callId, replacedProducerId),
          )
        : undefined;
      if (replacedProducerId) {
        this.videoStatesByProducer.delete(
          this.videoStateKey(payload.callId, replacedProducerId),
        );
      }
      if (!this.videoStatesByProducer.has(key)) {
        this.videoStatesByProducer.set(
          key,
          replacementState
            ? { ...replacementState }
            : { enabled: true, revision: 0 },
        );
      }
    }

    const videoState =
      payload.kind === 'video'
        ? this.getVideoState(payload.callId, producerId)
        : undefined;
    const micState = isGroupAudio
      ? this.groupMicStates.get(this.groupMicStateKey(payload.callId, userId))
      : undefined;

    client.to(payload.callId).emit('new_producer', {
      callId: payload.callId,
      userId,
      producerId,
      kind: payload.kind,
      ...(videoState
        ? { paused: !videoState.enabled, revision: videoState.revision }
        : {}),
      ...(micState?.producerId === producerId
        ? { paused: !micState.enabled, revision: micState.revision }
        : {}),
    });
  }

  @SubscribeMessage('close_producer')
  async handleCloseProducer(
    @MessageBody() payload: CloseProducerPayload,
    @ConnectedSocket() client: Socket,
  ) {
    const userId = await this.resolveUserId(client);
    if (!userId) return;

    const session = await this.sessionRepository.findByCallId(payload.callId);
    if (!session) {
      throw new NotFoundException('Call not found');
    }

    // Cleanup can race a normal hangup or a call-type downgrade. Once the
    // lifecycle is no longer active there is no media operation to perform,
    // but the idempotent ACK still lets the client release its waiter.
    if (session.status !== 'active') {
      client.emit('producer_closed_ack', {
        callId: payload.callId,
        producerId: payload.producerId,
        kind: payload.kind,
        status: 'already_closed',
        ...(payload.requestId ? { requestId: payload.requestId } : {}),
      } satisfies ProducerClosedAckPayload);
      return;
    }
    this.assertSocketJoinedToCall(client, payload.callId);

    if (
      !(session.isGroupCall
        ? session.invitedUserIds.includes(userId)
        : session.initiatorId === userId || session.targetUserId === userId)
    ) {
      throw new ForbiddenException('You are not part of this call');
    }

    const activeProducer = (
      await this.mediaEngine.listActiveProducers(payload.callId)
    ).find((producer) => producer.producerId === payload.producerId);
    if (
      activeProducer &&
      (activeProducer.userId !== userId || activeProducer.kind !== payload.kind)
    ) {
      throw new ForbiddenException('Producer cannot be closed by this user');
    }

    const result = await this.mediaEngine.closeProducer(
      payload.callId,
      userId,
      payload.producerId,
    );
    const status = result.closed ? 'closed' : 'already_closed';
    if (result.closed) {
      if (result.kind === 'video') {
        this.clearVideoState(payload.callId, payload.producerId);
      }
      this.server.to(payload.callId).emit('producer_closed', {
        callId: payload.callId,
        producerId: payload.producerId,
        kind: result.kind ?? payload.kind,
      });
    }

    client.emit('producer_closed_ack', {
      callId: payload.callId,
      producerId: payload.producerId,
      kind: result.kind ?? payload.kind,
      status,
      ...(payload.requestId ? { requestId: payload.requestId } : {}),
    } satisfies ProducerClosedAckPayload);
  }

  @SubscribeMessage('consume')
  async handleConsume(
    @MessageBody() payload: ConsumePayload,
    @ConnectedSocket() client: Socket,
  ) {
    const userId = await this.resolveUserId(client);
    if (!userId) return;
    this.assertSocketJoinedToCall(client, payload.callId);

    const result = await this.consumeUseCase.execute(
      payload.callId,
      userId,
      payload.transportId,
      payload.producerId,
      payload.rtpCapabilities,
    );

    client.emit('consumer_created', {
      callId: payload.callId,
      ...result,
      ...(payload.requestId ? { requestId: payload.requestId } : {}),
    });
  }

  @SubscribeMessage('resume_consumer')
  async handleResumeConsumer(
    @MessageBody() payload: ResumeConsumerPayload,
    @ConnectedSocket() client: Socket,
  ) {
    const userId = await this.resolveUserId(client);
    if (!userId) return;
    this.assertSocketJoinedToCall(client, payload.callId);

    await this.resumeConsumerUseCase.execute(
      payload.callId,
      userId,
      payload.consumerId,
    );

    client.emit('consumer_resumed', {
      callId: payload.callId,
      consumerId: payload.consumerId,
    });
  }

  @SubscribeMessage('close_consumer')
  async handleCloseConsumer(
    @MessageBody() payload: CloseConsumerPayload,
    @ConnectedSocket() client: Socket,
  ) {
    const userId = await this.resolveUserId(client);
    if (!userId) return;

    const session = await this.sessionRepository.findByCallId(payload.callId);
    if (!session) {
      throw new NotFoundException('Call not found');
    }
    if (
      !(session.isGroupCall
        ? session.invitedUserIds.includes(userId)
        : session.initiatorId === userId || session.targetUserId === userId)
    ) {
      throw new ForbiddenException('You are not part of this call');
    }

    // Cleanup may race terminal call teardown. The idempotent ACK lets a
    // client release local resources without turning a normal race into an
    // exception after the room has already gone away.
    if (session.status === 'active') {
      this.assertSocketJoinedToCall(client, payload.callId);
    }
    const result =
      session.status === 'active'
        ? await this.mediaEngine.closeConsumer(
            payload.callId,
            userId,
            payload.consumerId,
          )
        : { closed: false };

    client.emit('consumer_closed_ack', {
      callId: payload.callId,
      consumerId: payload.consumerId,
      status: result.closed ? 'closed' : 'already_closed',
      ...(payload.requestId ? { requestId: payload.requestId } : {}),
    } satisfies ConsumerClosedAckPayload);
  }

  @SubscribeMessage('restart_ice')
  async handleRestartIce(
    @MessageBody() payload: RestartIcePayload,
    @ConnectedSocket() client: Socket,
  ) {
    const userId = await this.resolveUserId(client);
    if (!userId) return;
    this.assertSocketJoinedToCall(client, payload.callId);

    const result = await this.restartIceUseCase.execute(
      payload.callId,
      userId,
      payload.transportId,
    );

    client.emit('ice_restarted', {
      callId: payload.callId,
      transportId: payload.transportId,
      ...result,
    });
  }

  @SubscribeMessage('set_audio_bitrate')
  async handleSetAudioBitrate(
    @MessageBody() payload: SetAudioBitratePayload,
    @ConnectedSocket() client: Socket,
  ) {
    const userId = await this.resolveUserId(client);
    if (!userId) return;
    this.assertSocketJoinedToCall(client, payload.callId);

    if (!(payload.profile in AUDIO_BITRATE_BY_PROFILE)) {
      throw new BadRequestException('Invalid audio bitrate profile');
    }

    const session = await this.sessionRepository.findByCallId(payload.callId);
    if (!session) {
      throw new NotFoundException('Call not found');
    }

    if (session.status !== 'active') {
      throw new ForbiddenException('Audio bitrate cannot be adjusted');
    }

    await this.mediaEngine.setConsumerMaxBitrate(
      payload.callId,
      userId,
      payload.transportId,
      AUDIO_BITRATE_BY_PROFILE[payload.profile],
    );

    client.emit('audio_bitrate_updated', {
      callId: payload.callId,
      transportId: payload.transportId,
      profile: payload.profile,
    });
  }

  @SubscribeMessage('set_video_enabled')
  async handleSetVideoEnabled(
    @MessageBody() payload: SetVideoEnabledPayload,
    @ConnectedSocket() client: Socket,
  ) {
    const userId = await this.resolveUserId(client);
    if (!userId) return;

    const key = this.videoStateKey(payload.callId, payload.producerId);
    const previous = this.videoStateQueues.get(key) ?? Promise.resolve();
    const operation = previous
      .catch(() => undefined)
      .then(() => this.applyVideoStateUpdate(payload, userId));
    // Keep the queue tail settled even when the caller receives a structured
    // websocket exception. A rejected tail would otherwise become an
    // unhandled promise and could terminate the Node process during a
    // terminal/media race.
    const queued = operation.then(
      () => undefined,
      () => undefined,
    );
    this.videoStateQueues.set(key, queued);

    try {
      const result = await operation;
      client.emit('video_state_updated', result);
    } finally {
      if (this.videoStateQueues.get(key) === queued) {
        this.videoStateQueues.delete(key);
      }
    }
  }

  @SubscribeMessage('set_group_mic_state')
  async handleSetGroupMicState(
    @MessageBody() payload: SetGroupMicStatePayload,
    @ConnectedSocket() client: Socket,
  ) {
    const userId = await this.resolveUserId(client);
    if (!userId) return;
    if (
      !payload ||
      typeof payload.callId !== 'string' ||
      payload.callId.length === 0 ||
      payload.callId.length > 128 ||
      typeof payload.enabled !== 'boolean' ||
      !Number.isSafeInteger(payload.revision) ||
      payload.revision < 1 ||
      payload.revision > 1_000_000_000 ||
      typeof payload.producerId !== 'string' ||
      payload.producerId.length === 0 ||
      payload.producerId.length > 128 ||
      (payload.actionId !== undefined &&
        (typeof payload.actionId !== 'string' ||
          payload.actionId.length > 128)) ||
      typeof payload.requestId !== 'string' ||
      payload.requestId.length === 0 ||
      payload.requestId.length > 128
    ) {
      throw new BadRequestException('Invalid group mic state');
    }

    return this.withGroupMicQueue(payload.callId, userId, async () => {
      const session = await this.sessionRepository.findByCallId(payload.callId);
      this.assertGroupLifecycleCapable(client, session);
      if (
        !session?.isGroupCall ||
        session.status !== 'active' ||
        !session.participantIds.includes(userId)
      ) {
        throw new ForbiddenException('Group call is no longer active');
      }
      this.assertSocketJoinedToCall(client, payload.callId);
      if (
        userId !== session.initiatorId &&
        (!session.groupConfirmedAnswerActionIds[userId] ||
          session.groupConfirmedAnswerActionIds[userId] !==
            payload.actionId?.trim())
      ) {
        throw new ForbiddenException('This action did not join the group call');
      }

      const producer = (
        await this.mediaEngine.listActiveProducers(payload.callId)
      ).find(
        (entry) =>
          entry.producerId === payload.producerId &&
          entry.userId === userId &&
          entry.kind === 'audio',
      );
      if (!producer) throw new NotFoundException('Audio producer not found');

      const key = this.groupMicStateKey(payload.callId, userId);
      const stored = this.groupMicStates.get(key);
      const current =
        stored?.producerId === producer.producerId
          ? stored
          : {
              producerId: producer.producerId,
              enabled: producer.paused !== true,
              revision: 0,
            };
      const status: VideoStateUpdateStatus =
        payload.revision < current.revision ||
        (payload.revision === current.revision &&
          payload.enabled !== current.enabled)
          ? 'stale'
          : payload.revision === current.revision
            ? 'already_applied'
            : 'applied';

      if (status === 'applied') {
        if (payload.enabled) {
          await this.mediaEngine.resumeProducer(
            payload.callId,
            userId,
            producer.producerId,
          );
        } else {
          await this.mediaEngine.pauseProducer(
            payload.callId,
            userId,
            producer.producerId,
          );
        }
        const latestSession = await this.sessionRepository.findByCallId(
          payload.callId,
        );
        const stillActive =
          latestSession?.isGroupCall &&
          latestSession.status === 'active' &&
          latestSession.participantIds.includes(userId) &&
          this.isSocketJoinedToCall(client, payload.callId) &&
          (userId === latestSession.initiatorId ||
            (Boolean(latestSession.groupConfirmedAnswerActionIds[userId]) &&
              latestSession.groupConfirmedAnswerActionIds[userId] ===
                payload.actionId?.trim()));
        const latestProducer = (
          await this.mediaEngine.listActiveProducers(payload.callId)
        ).some(
          (entry) =>
            entry.producerId === producer.producerId &&
            entry.userId === userId &&
            entry.kind === 'audio',
        );
        if (!stillActive || !latestProducer) {
          if (latestProducer) {
            if (current.enabled) {
              await this.mediaEngine.resumeProducer(
                payload.callId,
                userId,
                producer.producerId,
              );
            } else {
              await this.mediaEngine.pauseProducer(
                payload.callId,
                userId,
                producer.producerId,
              );
            }
          }
          throw new ForbiddenException(
            'Group mic state can no longer be changed',
          );
        }
        this.groupMicStates.set(key, {
          producerId: producer.producerId,
          enabled: payload.enabled,
          revision: payload.revision,
        });
        this.server.to(payload.callId).emit('group_mic_state_changed', {
          callId: payload.callId,
          userId,
          producerId: producer.producerId,
          enabled: payload.enabled,
          revision: payload.revision,
        });
      }

      client.emit('group_mic_state_updated', {
        callId: payload.callId,
        userId,
        producerId: producer.producerId,
        enabled: status === 'applied' ? payload.enabled : current.enabled,
        revision: status === 'applied' ? payload.revision : current.revision,
        status,
        ...(payload.requestId ? { requestId: payload.requestId } : {}),
      });
    });
  }

  private async applyVideoStateUpdate(
    payload: SetVideoEnabledPayload,
    userId: string,
  ): Promise<VideoStateUpdatedPayload> {
    const session = await this.sessionRepository.findByCallId(payload.callId);
    if (!session) throw new NotFoundException('Call not found');

    if (session.status !== 'active' || session.callType !== 'VIDEO') {
      throw new ForbiddenException('Video state cannot be changed');
    }

    if (session.initiatorId !== userId && session.targetUserId !== userId) {
      throw new ForbiddenException('You are not part of this call');
    }

    const producer = (
      await this.mediaEngine.listActiveProducers(payload.callId)
    ).find(
      (entry) =>
        entry.producerId === payload.producerId &&
        entry.userId === userId &&
        entry.kind === 'video',
    );
    if (!producer) throw new NotFoundException('Video producer not found');

    const current = this.getVideoStateForProducer(payload.callId, producer);
    const actionId = payload.actionId?.trim() || payload.requestId?.trim();
    const requestedRevision =
      Number.isInteger(payload.revision) && (payload.revision as number) >= 0
        ? (payload.revision as number)
        : current.revision + 1;

    if (requestedRevision < current.revision) {
      return {
        callId: payload.callId,
        producerId: payload.producerId,
        userId,
        enabled: current.enabled,
        revision: current.revision,
        status: 'stale',
        ...(current.actionId ? { actionId: current.actionId } : {}),
        ...(payload.requestId ? { requestId: payload.requestId } : {}),
      };
    }

    if (requestedRevision === current.revision) {
      if (actionId && current.actionId === actionId) {
        return {
          callId: payload.callId,
          producerId: payload.producerId,
          userId,
          enabled: current.enabled,
          revision: current.revision,
          status: 'already_applied',
          ...(current.actionId ? { actionId: current.actionId } : {}),
          ...(payload.requestId ? { requestId: payload.requestId } : {}),
        };
      }

      if (current.enabled === payload.enabled) {
        return {
          callId: payload.callId,
          producerId: payload.producerId,
          userId,
          enabled: current.enabled,
          revision: current.revision,
          status: 'already_applied',
          ...(current.actionId ? { actionId: current.actionId } : {}),
          ...(payload.requestId ? { requestId: payload.requestId } : {}),
        };
      }

      return {
        callId: payload.callId,
        producerId: payload.producerId,
        userId,
        enabled: current.enabled,
        revision: current.revision,
        status: 'stale',
        ...(current.actionId ? { actionId: current.actionId } : {}),
        ...(payload.requestId ? { requestId: payload.requestId } : {}),
      };
    }

    if (payload.enabled) {
      await this.mediaEngine.resumeProducer(
        payload.callId,
        userId,
        payload.producerId,
      );
    } else {
      await this.mediaEngine.pauseProducer(
        payload.callId,
        userId,
        payload.producerId,
      );
    }

    // Terminal lifecycle transitions can race the asynchronous mediasoup
    // pause/resume call. Re-read the authoritative session and producer
    // before publishing state so a late media completion can never resurrect
    // a terminal call or emit a camera update after teardown.
    const latestSession = await this.sessionRepository.findByCallId(
      payload.callId,
    );
    if (
      !latestSession ||
      latestSession.status !== 'active' ||
      latestSession.callType !== 'VIDEO' ||
      (latestSession.initiatorId !== userId &&
        latestSession.targetUserId !== userId)
    ) {
      throw new ForbiddenException('Video state cannot be changed');
    }

    const latestProducer = (
      await this.mediaEngine.listActiveProducers(payload.callId)
    ).find(
      (entry) =>
        entry.producerId === payload.producerId &&
        entry.userId === userId &&
        entry.kind === 'video',
    );
    if (!latestProducer)
      throw new NotFoundException('Video producer not found');

    const next: VideoStateRecord = {
      enabled: payload.enabled,
      revision: requestedRevision,
      ...(actionId ? { actionId } : {}),
    };
    this.videoStatesByProducer.set(
      this.videoStateKey(payload.callId, payload.producerId),
      next,
    );
    this.server.to(payload.callId).emit('video_state_changed', {
      callId: payload.callId,
      userId,
      producerId: payload.producerId,
      enabled: next.enabled,
      revision: next.revision,
      ...(actionId ? { actionId } : {}),
    });

    return {
      callId: payload.callId,
      producerId: payload.producerId,
      userId,
      enabled: next.enabled,
      revision: next.revision,
      status: 'applied',
      ...(actionId ? { actionId } : {}),
      ...(payload.requestId ? { requestId: payload.requestId } : {}),
    };
  }

  @SubscribeMessage('set_call_type')
  async handleSetCallType(
    @MessageBody() payload: SetCallTypePayload,
    @ConnectedSocket() client: Socket,
  ) {
    const userId = await this.resolveUserId(client);
    if (!userId) return;

    if (payload.callType !== 'VOICE' && payload.callType !== 'VIDEO') {
      throw new BadRequestException('Invalid call type');
    }

    const result = await this.changeCallTypeUseCase.execute(
      payload.callId,
      userId,
      payload.callType,
    );

    for (const producerId of result.closedVideoProducerIds) {
      this.clearVideoState(payload.callId, producerId);
      this.server.to(payload.callId).emit('producer_closed', {
        callId: payload.callId,
        producerId,
        kind: 'video',
      });
    }

    this.server.to(payload.callId).emit('call_type_changed', {
      callId: result.callId,
      callType: result.callType,
      changedByUserId: result.changedByUserId,
    });
  }

  @SubscribeMessage('answer_call')
  async handleAnswerCall(
    @MessageBody() payload: LegacyAnswerCallPayload,
    @ConnectedSocket() client: Socket,
  ) {
    const userId = await this.resolveUserId(client);
    if (!userId) return;

    const suppliedActionId = payload.actionId?.trim();
    if (suppliedActionId && suppliedActionId.length > 128) {
      throw new BadRequestException('A call action id is too long');
    }
    const actionId = suppliedActionId || `legacy:${client.id}`;

    // Existing clients must still join a ringing room before `answer_call`.
    // A retry of a modern rollback action is the one exception: it must reach
    // the same CAS lifecycle while `accepting`/`active`, otherwise a lost ACK
    // turns a successful answer into a false client-side failure.
    const session = await this.sessionRepository.findByCallId(payload.callId);
    this.assertGroupLifecycleCapable(client, session);
    const isJoinedRingingParticipant =
      session?.status === 'ringing' && session.participantIds.includes(userId);
    const isRetryOfWinningAction =
      Boolean(suppliedActionId) &&
      (session?.status === 'accepting' || session?.status === 'active') &&
      session.answerActionId === actionId;
    if (!session || (!isJoinedRingingParticipant && !isRetryOfWinningAction)) {
      throw new ForbiddenException(
        'Call cannot be answered in its current state',
      );
    }

    const result = await this.acceptIncomingCallUseCase.execute(
      payload.callId,
      userId,
      client.id,
      actionId,
    );
    if (result.outcome === 'answered_elsewhere') {
      throw new ForbiddenException('Call was answered elsewhere');
    }
    if (result.outcome === 'expired') {
      const terminalSession = result.session;
      if (terminalSession?.status === 'ended') {
        this.clearPendingUnansweredCall(payload.callId);
        this.emitCallEnded(
          terminalSession,
          terminalSession.terminalReason ?? 'no_answer',
        );
      }
      throw new ForbiddenException('Call has expired');
    }
    if (result.outcome === 'terminal') {
      throw new ForbiddenException('Call is no longer active');
    }
    if (result.outcome === 'unauthorized') {
      throw new ForbiddenException('Call cannot be answered by this user');
    }
    if (result.outcome === 'media_unavailable' || result.outcome === 'busy') {
      if (result.shouldEmitTerminal && result.session) {
        this.emitCallEnded(result.session, result.outcome);
      }
      throw new ForbiddenException(
        result.outcome === 'busy'
          ? 'A participant is already in another call'
          : 'Call media is unavailable',
      );
    }
    this.clearPendingUnansweredCall(payload.callId);
    if (!(await this.attachLiveSocketToCall(client, payload.callId, userId))) {
      return;
    }
    this.clearPendingDisconnect(payload.callId, userId);
    this.recordSocketReconnect(payload.callId, userId);
    const answeredPayload = {
      callId: payload.callId,
      userId,
      answerActionId: actionId,
    };
    this.server.to(payload.callId).emit('call_answered', answeredPayload);
    // A second device for the callee is authenticated into its user room but
    // has not joined the call room yet. Notify it immediately so its pending
    // CallKit/Connecting surface can resolve without waiting for APNs.
    this.server.to(session.targetUserId).emit('call_answered', answeredPayload);
  }

  @SubscribeMessage('accept_incoming_call')
  async handleAcceptIncomingCall(
    @MessageBody() payload: AcceptIncomingCallPayload,
    @ConnectedSocket() client: Socket,
  ) {
    const userId = await this.resolveUserId(client);
    if (!userId) return;
    const actionId = payload.actionId?.trim();
    if (!actionId || actionId.length > 128) {
      throw new BadRequestException('A call action id is required');
    }

    const existingSession = await this.sessionRepository.findByCallId(
      payload.callId,
    );
    this.assertGroupLifecycleCapable(client, existingSession);
    if (existingSession?.isGroupCall) {
      const key = this.disconnectKey(payload.callId, userId);
      const previous = this.groupAcceptQueues.get(key) ?? Promise.resolve();
      const operation = previous
        .catch(() => undefined)
        .then(() =>
          this.acceptGroupInvitation(client, payload.callId, userId, actionId),
        );
      const tail = operation.then(
        () => undefined,
        () => undefined,
      );
      this.groupAcceptQueues.set(key, tail);
      try {
        await operation;
      } finally {
        if (this.groupAcceptQueues.get(key) === tail) {
          this.groupAcceptQueues.delete(key);
        }
      }
      return;
    }

    const result = await this.acceptIncomingCallUseCase.execute(
      payload.callId,
      userId,
      client.id,
      actionId,
    );

    if (
      result.outcome === 'answered_elsewhere' ||
      result.outcome === 'terminal' ||
      result.outcome === 'expired' ||
      result.outcome === 'unauthorized' ||
      result.outcome === 'busy' ||
      result.outcome === 'media_unavailable'
    ) {
      client.emit('incoming_call_acceptance', {
        callId: payload.callId,
        outcome: result.outcome,
        ...(result.session
          ? { session: clientCallSession(result.session) }
          : {}),
      } satisfies IncomingCallAcceptanceSocketPayload);
      if (result.shouldEmitTerminal && result.session) {
        this.clearPendingUnansweredCall(payload.callId);
        this.emitCallEnded(
          result.session,
          result.session.terminalReason ?? result.outcome,
        );
      }
      return;
    }

    if (!result.session || !result.role || !result.rtpCapabilities) {
      throw new BadRequestException('Incoming call acceptance was incomplete');
    }

    this.clearPendingUnansweredCall(payload.callId);
    if (!(await this.attachLiveSocketToCall(client, payload.callId, userId))) {
      return;
    }
    this.clearPendingDisconnect(payload.callId, userId);
    this.recordSocketReconnect(payload.callId, userId);

    const activeProducers = result.activeProducers
      ? this.decorateActiveProducers(payload.callId, result.activeProducers)
      : result.activeProducers;

    client.emit('incoming_call_acceptance', {
      callId: payload.callId,
      outcome: result.outcome,
      role: result.role,
      session: clientCallSession(result.session),
      rtpCapabilities: result.rtpCapabilities,
      activeProducers,
      telemetryToken: this.telemetryTokenService.issue(payload.callId, 'guest'),
      noAnswerTimeoutMs: this.noAnswerTimeoutMs,
    } satisfies IncomingCallAcceptanceSocketPayload);
    const answeredPayload = {
      callId: payload.callId,
      userId,
      answerActionId: actionId,
    };
    this.server.to(payload.callId).emit('call_answered', answeredPayload);
    // See the legacy path above: the user room reaches the other signed-in
    // device before it has joined the winning call room.
    this.server
      .to(result.session.targetUserId)
      .emit('call_answered', answeredPayload);
  }

  private async acceptGroupInvitation(
    client: Socket,
    callId: string,
    userId: string,
    actionId: string,
    lateJoin = false,
  ): Promise<void> {
    let joined: Awaited<ReturnType<JoinCallUseCase['execute']>> | undefined;
    const wasInRoom = client.rooms?.has(callId) ?? false;
    try {
      joined = await this.joinCallUseCase.execute(
        callId,
        userId,
        client.id,
        actionId,
        lateJoin,
      );
      if (!(await this.attachLiveSocketToCall(client, callId, userId))) {
        throw new GroupJoinMediaUnavailableError();
      }
      const activeProducers = this.decorateActiveProducers(
        callId,
        await this.mediaEngine.listActiveProducers(callId, userId),
      );
      const telemetryToken = this.telemetryTokenService.issue(callId, 'guest');
      if (
        !(await this.sessionRepository.confirmGroupInvitationJoin(
          callId,
          userId,
          actionId,
          new Date(),
        ))
      ) {
        throw new GroupJoinMediaUnavailableError();
      }

      this.metrics.recordCallEvent(
        lateJoin ? 'late_join_accepted' : 'invite_accepted',
      );

      this.clearPendingDisconnect(callId, userId);
      this.recordSocketReconnect(callId, userId);
      if (lateJoin) {
        client.emit('call_joined', {
          callId,
          role: 'guest',
          session: clientCallSession(joined.session),
          rtpCapabilities: joined.rtpCapabilities,
          activeProducers,
          telemetryToken,
          noAnswerTimeoutMs: this.noAnswerTimeoutMs,
        } satisfies CallJoinedSocketPayload);
      } else {
        client.emit('incoming_call_acceptance', {
          callId,
          outcome: 'accepted',
          role: 'guest',
          session: clientCallSession(joined.session),
          rtpCapabilities: joined.rtpCapabilities,
          activeProducers,
          telemetryToken,
        } satisfies IncomingCallAcceptanceSocketPayload);
      }
      if (joined.shouldEmitNewPeer) {
        client.to(callId).emit('new_peer', { callId, userId });
      }
      client.to(this.groupUserRoom(userId)).emit('call_answered', {
        callId,
        userId,
        answeredElsewhere: true,
      });
    } catch (error) {
      this.metrics.recordCallEvent(
        lateJoin ? 'late_join_denied' : 'invite_denied',
      );
      const reservationReleased = await this.sessionRepository
        .abortGroupInvitationJoin(callId, userId, actionId, new Date())
        .catch(() => false);
      if (reservationReleased) {
        try {
          await this.stateRepository.removeParticipant(callId, userId);
        } catch {
          // Session authorization is already revoked by the Redis CAS.
        }
      }
      if (reservationReleased || (joined && !wasInRoom)) {
        try {
          await client.leave(callId);
        } catch {
          // The socket may already be disconnected; the Redis abort is authoritative.
        }
        this.untrackCallId(client, callId);
      }
      if (reservationReleased) {
        this.emitPeerLeft(callId, userId, 'media_unavailable');
      }
      if (lateJoin) {
        if (error instanceof ForbiddenException) throw error;
        throw new ServiceUnavailableException('Unable to join group call');
      }
      client.emit('incoming_call_acceptance', {
        callId,
        ...(reservationReleased ? { reservationReleased: true } : {}),
        ...(error instanceof ServiceUnavailableException
          ? { retryable: true }
          : {}),
        outcome:
          error instanceof ForbiddenException &&
          /another call/i.test(error.message)
            ? 'busy'
            : error instanceof ForbiddenException &&
                /answered elsewhere/i.test(error.message)
              ? 'answered_elsewhere'
              : error instanceof ForbiddenException &&
                  /invitation expired/i.test(error.message)
                ? 'expired'
                : error instanceof GroupJoinMediaUnavailableError ||
                    error instanceof ServiceUnavailableException ||
                    joined
                  ? 'media_unavailable'
                  : 'unauthorized',
      } satisfies IncomingCallAcceptanceSocketPayload);
    }
  }

  @SubscribeMessage('leave_call')
  async handleLeaveCall(
    @MessageBody() payload: LeaveCallPayload,
    @ConnectedSocket() client: Socket,
  ) {
    const userId = await this.resolveUserId(client);
    if (!userId) return;

    const session = await this.sessionRepository.findByCallId(payload.callId);
    this.assertGroupLifecycleCapable(client, session);
    if (
      session?.isGroupCall &&
      session.status === 'active' &&
      session.declinedUserIds.includes(userId) &&
      !session.participantIds.includes(userId)
    ) {
      client.emit('call_left', {
        callId: payload.callId,
        ...(payload.actionId ? { actionId: payload.actionId } : {}),
      });
      return;
    }
    if (
      session?.isGroupCall &&
      session.status === 'active' &&
      userId !== session.initiatorId &&
      !this.isSocketJoinedToCall(client, payload.callId)
    ) {
      throw new ForbiddenException('This device did not answer the group call');
    }
    if (
      session?.isGroupCall &&
      session.status === 'active' &&
      userId !== session.initiatorId &&
      session.participantIds.includes(userId) &&
      payload.actionId !== undefined &&
      session.groupAnswerActionIds[userId] !== payload.actionId.trim()
    ) {
      throw new ForbiddenException('This action did not join the group call');
    }

    const result = await this.leaveCallUseCase.execute(
      payload.callId,
      userId,
      payload.reason,
    );

    this.clearPendingUnansweredCall(payload.callId);
    this.clearPendingDisconnect(payload.callId, userId);
    this.reconnectStartedAtByParticipant.delete(
      this.disconnectKey(payload.callId, userId),
    );
    this.clearVideoState(payload.callId);
    this.untrackCallId(client, payload.callId);
    if (result.shouldEmitPeerLeft) {
      // A participant is account-scoped; evict every socket for that account,
      // including an older socket left behind by a reconnect.
      this.server.in(userId).socketsLeave(payload.callId);
      this.emitClosedProducers(payload.callId, userId, result.closedProducers);
      this.emitPeerLeft(payload.callId, userId, result.endedReason);
    } else {
      await client.leave(payload.callId);
    }
    if (result.didTransition !== false) {
      this.emitCallEnded(result.session, result.endedReason);
    }
    client.emit('call_left', {
      callId: payload.callId,
      ...(payload.actionId ? { actionId: payload.actionId } : {}),
    });
  }

  @SubscribeMessage('reject_call')
  async handleRejectCall(
    @MessageBody() payload: LeaveCallPayload,
    @ConnectedSocket() client: Socket,
  ) {
    const userId = await this.resolveUserId(client);
    if (!userId) return;

    if (!this.isGroupLifecycleCapable(client)) {
      const session = await this.sessionRepository.findByCallId(payload.callId);
      this.assertGroupLifecycleCapable(client, session);
    }

    const result = await this.rejectCallUseCase.execute(
      payload.callId,
      userId,
      payload.reason,
    );
    if (result.isGroupInvitation) {
      if (result.didTransition) {
        this.metrics.recordCallEvent('invite_rejected');
        this.server.to(this.groupUserRoom(userId)).emit('call_rejected', {
          callId: payload.callId,
          userId,
          reason: result.reason,
        });
      }
      return;
    }
    this.clearPendingUnansweredCall(payload.callId);
    this.clearPendingDisconnect(payload.callId, userId);
    this.reconnectStartedAtByParticipant.delete(
      this.disconnectKey(payload.callId, userId),
    );
    this.clearVideoState(payload.callId);
    this.untrackCallId(client, payload.callId);

    if (result.didTransition !== false) {
      this.server
        .to([
          result.session.callId,
          result.session.initiatorId,
          result.session.targetUserId,
        ])
        .emit('call_rejected', {
          callId: result.session.callId,
          userId,
          reason: result.reason,
        });
    }
  }

  private emitCallEnded(session: CallSession, reason: string): void {
    this.metrics.recordCallEvent('terminal_emitted');
    this.clearVideoState(session.callId);
    this.clearGroupMicState(session.callId);
    this.clearPendingUnansweredCall(session.callId);
    for (const userId of session.invitedUserIds) {
      this.clearPendingDisconnect(session.callId, userId);
      this.reconnectStartedAtByParticipant.delete(
        this.disconnectKey(session.callId, userId),
      );
    }

    const payload = {
      callId: session.callId,
      reason,
    } satisfies RecentTerminalCall;
    this.rememberRecentTerminalCall(session, payload);

    this.server
      .to([
        session.callId,
        ...session.invitedUserIds.map((userId) =>
          session.isGroupCall ? this.groupUserRoom(userId) : userId,
        ),
      ])
      .emit('call_ended', payload);
  }

  private rememberRecentTerminalCall(
    session: CallSession,
    payload: RecentTerminalCall,
  ): void {
    const expiresAtMs = Date.now() + this.terminalReplayTtlMs;

    for (const userId of new Set(session.invitedUserIds)) {
      const calls =
        this.recentTerminalCallsByUser.get(userId) ??
        new Map<string, StoredRecentTerminalCall>();
      calls.set(payload.callId, {
        ...payload,
        isGroupCall: session.isGroupCall === true,
        expiresAtMs,
      });
      this.recentTerminalCallsByUser.set(userId, calls);

      const cleanupTimeout = setTimeout(() => {
        const currentCalls = this.recentTerminalCallsByUser.get(userId);
        const current = currentCalls?.get(payload.callId);
        if (!current || current.expiresAtMs > Date.now()) {
          return;
        }

        currentCalls?.delete(payload.callId);
        if (currentCalls?.size === 0) {
          this.recentTerminalCallsByUser.delete(userId);
        }
      }, this.terminalReplayTtlMs + 1000);
      cleanupTimeout.unref?.();
    }
  }

  private getRecentTerminalCalls(
    userId: string,
    groupLifecycleCapable: boolean,
  ): RecentTerminalCall[] {
    const calls = this.recentTerminalCallsByUser.get(userId);
    if (!calls) {
      return [];
    }

    const now = Date.now();
    const recent: RecentTerminalCall[] = [];
    for (const [callId, call] of calls) {
      if (call.expiresAtMs <= now) {
        calls.delete(callId);
        continue;
      }

      if (call.isGroupCall && !groupLifecycleCapable) continue;

      recent.push({ callId: call.callId, reason: call.reason });
    }

    if (calls.size === 0) {
      this.recentTerminalCallsByUser.delete(userId);
    }

    return recent;
  }

  private emitPeerLeft(callId: string, userId: string, reason: string): void {
    this.clearGroupMicState(callId, userId);
    this.server.to(callId).emit('peer_left', {
      callId,
      userId,
      reason,
    });
  }

  private emitClosedProducers(
    callId: string,
    userId: string,
    producers?: Array<{ producerId: string; kind: 'audio' | 'video' }>,
  ): void {
    for (const producer of producers ?? []) {
      this.server.to(callId).emit('producer_closed', {
        callId,
        producerId: producer.producerId,
        kind: producer.kind,
        userId,
      });
    }
  }

  /**
   * A call use case can persist a participant before the Socket.IO room join
   * completes. Track synchronously before the first await so a disconnect in
   * that window is visible to `handleDisconnect`; when the socket was already
   * gone, reconcile the persisted participant directly instead of leaving a
   * ghost connection behind.
   */
  private async attachLiveSocketToCall(
    client: Socket,
    callId: string,
    userId: string,
  ): Promise<boolean> {
    if (client.disconnected) {
      if (!this.getTrackedCallIds(client).includes(callId)) {
        await this.reconcileDisconnectedCall(callId, userId, client.id);
      }
      return false;
    }

    this.trackCallId(client, callId);
    await client.join(callId);

    // Once the id is tracked, Socket.IO's disconnect hook owns cleanup. Do
    // not emit a success acknowledgement from a socket that is already gone.
    return !client.disconnected;
  }

  private async reconcileDisconnectedCall(
    callId: string,
    userId: string,
    socketId: string,
  ): Promise<void> {
    this.runtimeLease.assertHeld();
    const session = await this.sessionRepository.findByCallId(callId);
    if (!session) {
      return;
    }

    const participant = await this.stateRepository.getParticipant(
      callId,
      userId,
    );
    if (!participant) {
      return;
    }

    const remainingSocketIds = participant.socketIds.filter(
      (participantSocketId) => participantSocketId !== socketId,
    );

    if (remainingSocketIds.length > 0) {
      await this.stateRepository.upsertParticipant(
        new CallParticipant({
          ...participant,
          socketId: remainingSocketIds[0],
          socketIds: remainingSocketIds,
          isConnected: true,
          reconnectDeadlineAt: undefined,
        }),
      );
      return;
    }

    if (session.status === 'active') {
      const reconnectDeadlineAt = new Date(Date.now() + this.reconnectGraceMs);
      const reconnectKey = this.disconnectKey(callId, userId);
      if (!this.reconnectStartedAtByParticipant.has(reconnectKey)) {
        this.reconnectStartedAtByParticipant.set(reconnectKey, Date.now());
      }
      await this.stateRepository.upsertParticipant(
        new CallParticipant({
          ...participant,
          socketIds: [],
          socketId: undefined,
          isConnected: false,
          reconnectDeadlineAt,
        }),
      );
      this.server.to(callId).emit('peer_reconnecting', {
        callId,
        userId,
        reconnectDeadlineAt: reconnectDeadlineAt.toISOString(),
      });
      this.scheduleDisconnectFinalization(callId, userId);
      return;
    }

    this.reconnectStartedAtByParticipant.delete(
      this.disconnectKey(callId, userId),
    );
    const result = await this.leaveCallUseCase.execute(
      callId,
      userId,
      'disconnected',
    );
    if (result.shouldEmitPeerLeft) {
      this.emitClosedProducers(callId, userId, result.closedProducers);
      this.emitPeerLeft(callId, userId, 'disconnected');
    }
    if (result.didTransition !== false) {
      this.emitCallEnded(result.session, result.endedReason);
    }
  }

  private scheduleDisconnectFinalization(
    callId: string,
    userId: string,
    delayMs = this.reconnectGraceMs,
    retryCount = 0,
  ): void {
    this.clearPendingDisconnect(callId, userId);

    let rescheduled = false;
    const timeoutId = setTimeout(
      () => {
        void (async () => {
          try {
            const participant = await this.stateRepository.getParticipant(
              callId,
              userId,
            );

            if (
              !participant ||
              participant.isConnected ||
              !participant.reconnectDeadlineAt
            ) {
              return;
            }

            const remainingMs =
              participant.reconnectDeadlineAt.getTime() - Date.now();
            if (remainingMs > 0) {
              rescheduled = true;
              this.scheduleDisconnectFinalization(callId, userId, remainingMs);
              return;
            }

            this.reconnectStartedAtByParticipant.delete(
              this.disconnectKey(callId, userId),
            );
            const result = await this.leaveCallUseCase.execute(
              callId,
              userId,
              'disconnected',
            );
            if (result.shouldEmitPeerLeft) {
              this.emitClosedProducers(callId, userId, result.closedProducers);
              this.emitPeerLeft(callId, userId, 'disconnected');
            }
            if (result.didTransition !== false) {
              this.emitCallEnded(result.session, result.endedReason);
            }
          } catch (error) {
            this.logger.warn(
              `Deferred disconnect cleanup failed for call ${shortCallIdentifier(callId)} errorCode=${safeCallErrorCode(error)}`,
            );
            // ponytail: bound transient Redis retries; a durable sweep is needed for longer outages or process death.
            if (retryCount < 3) {
              rescheduled = true;
              this.scheduleDisconnectFinalization(
                callId,
                userId,
                1000,
                retryCount + 1,
              );
            }
          } finally {
            if (!rescheduled) {
              this.clearPendingDisconnect(callId, userId);
            }
          }
        })();
      },
      Math.max(1, delayMs),
    );

    this.pendingDisconnects.set(this.disconnectKey(callId, userId), timeoutId);
  }

  private scheduleUnansweredCallTimeout(session: CallSession): void {
    const { callId } = session;
    this.clearPendingUnansweredCall(callId);

    const expiresAtMs = getSessionExpiryDate(
      session.expiresAt,
      session.ringTimeoutMs ?? this.noAnswerTimeoutMs,
    ).getTime();
    const timeoutId = setTimeout(
      () => {
        this.clearPendingUnansweredCall(callId);
        void this.sweepExpiredCalls();
      },
      Math.max(1, expiresAtMs - Date.now()),
    );

    this.pendingUnansweredCalls.set(callId, timeoutId);
  }

  private async sweepExpiredCalls(): Promise<void> {
    if (this.expirySweepInFlight) {
      return;
    }

    this.expirySweepInFlight = true;
    try {
      this.runtimeLease.assertHeld();
      const expiredCalls = await this.expireDueCallsUseCase.execute(new Date());
      for (const { session, reason } of expiredCalls) {
        this.clearPendingUnansweredCall(session.callId);
        if (this.server) {
          this.emitCallEnded(session, reason);
        }
      }
    } catch (error) {
      this.logger.warn(
        `Durable unanswered-call sweep failed errorCode=${safeCallErrorCode(error)}`,
      );
    } finally {
      this.expirySweepInFlight = false;
    }
  }

  private clearPendingDisconnect(callId: string, userId: string): void {
    const key = this.disconnectKey(callId, userId);
    const timeoutId = this.pendingDisconnects.get(key);
    if (!timeoutId) {
      return;
    }

    clearTimeout(timeoutId);
    this.pendingDisconnects.delete(key);
  }

  private recordSocketReconnect(callId: string, userId: string): void {
    const key = this.disconnectKey(callId, userId);
    const startedAt = this.reconnectStartedAtByParticipant.get(key);
    if (startedAt === undefined) return;

    this.reconnectStartedAtByParticipant.delete(key);
    this.metrics.recordSocketReconnect(Math.max(0, Date.now() - startedAt));
  }

  private clearPendingUnansweredCall(callId: string): void {
    const timeoutId = this.pendingUnansweredCalls.get(callId);
    if (!timeoutId) {
      return;
    }

    clearTimeout(timeoutId);
    this.pendingUnansweredCalls.delete(callId);
  }

  private disconnectKey(callId: string, userId: string): string {
    return `${callId}:${userId}`;
  }

  private trackCallId(client: Socket, callId: string): void {
    const socketData = client.data as Record<string, unknown>;
    const tracked = new Set(this.getTrackedCallIds(client));
    tracked.add(callId);
    socketData['callIds'] = [...tracked];
  }

  private untrackCallId(client: Socket, callId: string): void {
    const socketData = client.data as Record<string, unknown>;
    socketData['callIds'] = this.getTrackedCallIds(client).filter(
      (trackedCallId) => trackedCallId !== callId,
    );
  }

  private getTrackedCallIds(client: Socket): string[] {
    const socketData = client.data as Record<string, unknown>;
    const value = socketData['callIds'];
    if (!Array.isArray(value)) {
      return [];
    }

    return value.filter((item): item is string => typeof item === 'string');
  }

  private assertSocketJoinedToCall(client: Socket, callId: string): void {
    if (!this.isSocketJoinedToCall(client, callId)) {
      throw new ForbiddenException('Join the call before using media');
    }
  }

  private isSocketJoinedToCall(client: Socket, callId: string): boolean {
    return (
      this.getTrackedCallIds(client).includes(callId) &&
      client.rooms.has(callId)
    );
  }

  private getResolvedUserId(client: Socket): string | null {
    const socketData = client.data as Record<string, unknown>;
    const cachedUserId = socketData['userId'];
    return typeof cachedUserId === 'string' && cachedUserId
      ? cachedUserId
      : null;
  }

  private groupUserRoom(userId: string): string {
    return `group-lifecycle-v2:${userId}`;
  }

  private groupLifecycleVersion(client: Socket): number {
    const auth = client.handshake?.auth as Record<string, unknown> | undefined;
    const version = auth?.['groupLifecycleVersion'];
    return typeof version === 'number' && Number.isInteger(version)
      ? version
      : 1;
  }

  private isGroupLifecycleCapable(client: Socket): boolean {
    return this.groupLifecycleVersion(client) >= 2;
  }

  private assertGroupLifecycleCapable(
    client: Socket,
    session: CallSession | null | undefined,
  ): void {
    if (session?.isGroupCall && !this.isGroupLifecycleCapable(client)) {
      throw new ForbiddenException('Group call requires a newer client');
    }
  }

  private extractAccessToken(client: Socket): string | null {
    const handshakeAuth = client.handshake.auth as
      | Record<string, unknown>
      | undefined;
    const authToken = handshakeAuth?.['token'];
    if (typeof authToken === 'string' && authToken.trim()) {
      return authToken;
    }

    const authHeader = client.handshake.headers['authorization'];
    if (typeof authHeader === 'string') {
      const [type, token] = authHeader.split(' ');
      if (type === 'Bearer' && token) {
        return token;
      }
    }

    const cookieHeader = client.handshake.headers.cookie;
    if (typeof cookieHeader !== 'string') {
      return null;
    }

    const accessTokenCookie = cookieHeader
      .split(';')
      .map((part) => part.trim())
      .find((part) => part.startsWith('access_token='));

    if (!accessTokenCookie) {
      return null;
    }

    return decodeURIComponent(accessTokenCookie.slice('access_token='.length));
  }

  private async resolveUserId(client: Socket): Promise<string | null> {
    // The lease-loss handler closes the application, but an established
    // Socket.IO connection can deliver one more packet before that shutdown
    // completes. Refuse every control-plane request once ownership is lost.
    this.runtimeLease.assertHeld();
    const cachedUserId = this.getResolvedUserId(client);
    if (cachedUserId) {
      return cachedUserId;
    }

    const token = this.extractAccessToken(client);
    if (!token) {
      return null;
    }

    const user = await lastValueFrom(
      this.authClient
        .send<AuthUser | null>('auth.verify_token', { token })
        .pipe(
          timeout(5000),
          catchError(() => of(null)),
        ),
      { defaultValue: null },
    );

    if (!user?.id) {
      this.logger.warn(
        `Socket ${shortCallIdentifier(client.id)} provided an invalid access token`,
      );
      client.disconnect(true);
      return null;
    }

    const socketData = client.data as Record<string, unknown>;
    socketData['userId'] = user.id;
    return user.id;
  }
}
