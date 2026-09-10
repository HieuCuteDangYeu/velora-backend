import type { AuthUser } from '@common/auth/interfaces/auth-user.interface';
import { CallTelemetryTokenService } from '@common/calls/call-telemetry-token.service';
import {
  BadRequestException,
  ForbiddenException,
  Inject,
  Logger,
  NotFoundException,
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
import {
  getCallNoAnswerTimeoutMs,
  getSessionExpiryDate,
  getSessionRingTimeoutMs,
} from '../../domain/call-lifecycle-config';

type InitiateCallPayload = {
  conversationId: string;
  targetUserId: string;
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
};

type LeaveCallPayload = {
  callId: string;
  reason?: string;
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
};

type ConsumePayload = {
  callId: string;
  transportId: string;
  producerId: string;
  rtpCapabilities: Record<string, unknown>;
};

type ResumeConsumerPayload = {
  callId: string;
  consumerId: string;
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

type CallJoinedSocketPayload = {
  callId: string;
  role: 'host' | 'guest';
  session: CallSession;
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
  session?: CallSession;
  rtpCapabilities?: RouterRtpCapabilitiesResult;
  activeProducers?: ActiveProducerResult[];
  telemetryToken?: string;
  noAnswerTimeoutMs?: number;
};

type RecentTerminalCall = {
  callId: string;
  reason: string;
};

type StoredRecentTerminalCall = RecentTerminalCall & {
  expiresAtMs: number;
};

@WebSocketGateway({
  namespace: '/call',
  cors: { origin: '*' },
  pingInterval: 5000,
  pingTimeout: 5000,
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
        `Failed to reconcile active calls after media startup: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      throw error;
    }
  }

  async handleConnection(client: Socket) {
    const userId = await this.resolveUserId(client);
    if (!userId) {
      client.disconnect(true);
      return;
    }

    await client.join(userId);
    client.emit('call_socket_ready', {
      recentTerminalCalls: this.getRecentTerminalCalls(userId),
    });
    this.logger.log(`Socket connected ${client.id} user=${userId}`);
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
          `Disconnect cleanup failed for call ${callId}: ${
            error instanceof Error ? error.message : String(error)
          }`,
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
      session: result.session,
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
    this.server.to(result.session.targetUserId).emit('incoming_call', {
      callId: result.session.callId,
      conversationId: result.session.conversationId,
      initiatorId: result.session.initiatorId,
      targetUserId: result.session.targetUserId,
      recipientUserId: result.session.targetUserId,
      initiatorDisplayName:
        result.session.initiatorDisplayName ?? 'Incoming call',
      initiatorAvatarUrl: result.session.initiatorAvatarUrl,
      ringTimeoutMs,
      expiresAt: expiresAt.toISOString(),
      callType: result.session.callType,
    });

    this.scheduleUnansweredCallTimeout(result.session);
  }

  @SubscribeMessage('join_call')
  async handleJoinCall(
    @MessageBody() payload: JoinCallPayload,
    @ConnectedSocket() client: Socket,
  ) {
    const userId = await this.resolveUserId(client);
    if (!userId) return;

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

    const activeProducers = await this.mediaEngine.listActiveProducers(
      payload.callId,
      userId,
    );

    client.emit('call_joined', {
      callId: payload.callId,
      role: result.role,
      session: result.session,
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

    if (session.status !== 'active') {
      throw new ForbiddenException('Call is not recoverable');
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

    const result = await this.joinCallUseCase.execute(
      payload.callId,
      userId,
      client.id,
    );

    if (!(await this.attachLiveSocketToCall(client, payload.callId, userId))) {
      return;
    }
    this.clearPendingDisconnect(payload.callId, userId);

    const activePeerProducers = await this.mediaEngine.listActiveProducers(
      payload.callId,
      userId,
    );

    client.emit('call_rejoined', {
      callId: payload.callId,
      role: result.role,
      session: result.session,
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
      });
    });

    const rejoinedUserProducers = (
      await this.mediaEngine.listActiveProducers(payload.callId)
    ).filter((producer) => producer.userId === userId);

    rejoinedUserProducers.forEach((producer) => {
      client.to(payload.callId).emit('new_producer', {
        callId: payload.callId,
        userId: producer.userId,
        producerId: producer.producerId,
        kind: producer.kind,
        paused: producer.paused ?? false,
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

    const transport = await this.createTransportUseCase.execute(
      payload.callId,
      userId,
      payload.direction,
    );

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

    const result = await this.produceUseCase.execute(
      payload.callId,
      userId,
      payload.transportId,
      payload.kind,
      payload.rtpParameters,
    );

    client.emit('new_producer', {
      callId: payload.callId,
      userId,
      ...result,
      kind: payload.kind,
    });

    client.to(payload.callId).emit('new_producer', {
      callId: payload.callId,
      userId,
      producerId: result.producerId,
      kind: payload.kind,
    });
  }

  @SubscribeMessage('consume')
  async handleConsume(
    @MessageBody() payload: ConsumePayload,
    @ConnectedSocket() client: Socket,
  ) {
    const userId = await this.resolveUserId(client);
    if (!userId) return;

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
    });
  }

  @SubscribeMessage('resume_consumer')
  async handleResumeConsumer(
    @MessageBody() payload: ResumeConsumerPayload,
    @ConnectedSocket() client: Socket,
  ) {
    const userId = await this.resolveUserId(client);
    if (!userId) return;

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

  @SubscribeMessage('restart_ice')
  async handleRestartIce(
    @MessageBody() payload: RestartIcePayload,
    @ConnectedSocket() client: Socket,
  ) {
    const userId = await this.resolveUserId(client);
    if (!userId) return;

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

    const session = await this.sessionRepository.findByCallId(payload.callId);
    if (!session) {
      throw new NotFoundException('Call not found');
    }

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
    if (!producer) {
      throw new NotFoundException('Video producer not found');
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

    this.server.to(payload.callId).emit('video_state_changed', {
      callId: payload.callId,
      userId,
      producerId: payload.producerId,
      enabled: payload.enabled,
    });
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
        ...(result.session ? { session: result.session } : {}),
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

    client.emit('incoming_call_acceptance', {
      callId: payload.callId,
      outcome: result.outcome,
      role: result.role,
      session: result.session,
      rtpCapabilities: result.rtpCapabilities,
      activeProducers: result.activeProducers,
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

  @SubscribeMessage('leave_call')
  async handleLeaveCall(
    @MessageBody() payload: LeaveCallPayload,
    @ConnectedSocket() client: Socket,
  ) {
    const userId = await this.resolveUserId(client);
    if (!userId) return;

    const result = await this.leaveCallUseCase.execute(
      payload.callId,
      userId,
      payload.reason,
    );

    this.clearPendingUnansweredCall(payload.callId);
    this.clearPendingDisconnect(payload.callId, userId);
    this.untrackCallId(client, payload.callId);
    if (result.shouldEmitPeerLeft) {
      this.emitPeerLeft(payload.callId, userId, result.endedReason);
    }
    if (result.didTransition !== false) {
      this.emitCallEnded(result.session, result.endedReason);
    }
  }

  @SubscribeMessage('reject_call')
  async handleRejectCall(
    @MessageBody() payload: LeaveCallPayload,
    @ConnectedSocket() client: Socket,
  ) {
    const userId = await this.resolveUserId(client);
    if (!userId) return;

    const result = await this.rejectCallUseCase.execute(
      payload.callId,
      userId,
      payload.reason,
    );
    this.clearPendingUnansweredCall(payload.callId);
    this.clearPendingDisconnect(payload.callId, userId);
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
    this.clearPendingUnansweredCall(session.callId);
    this.clearPendingDisconnect(session.callId, session.initiatorId);
    this.clearPendingDisconnect(session.callId, session.targetUserId);

    const payload = {
      callId: session.callId,
      reason,
    } satisfies RecentTerminalCall;
    this.rememberRecentTerminalCall(session, payload);

    this.server
      .to([session.callId, session.initiatorId, session.targetUserId])
      .emit('call_ended', payload);
  }

  private rememberRecentTerminalCall(
    session: CallSession,
    payload: RecentTerminalCall,
  ): void {
    const expiresAtMs = Date.now() + this.terminalReplayTtlMs;

    for (const userId of new Set([session.initiatorId, session.targetUserId])) {
      const calls =
        this.recentTerminalCallsByUser.get(userId) ??
        new Map<string, StoredRecentTerminalCall>();
      calls.set(payload.callId, { ...payload, expiresAtMs });
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

  private getRecentTerminalCalls(userId: string): RecentTerminalCall[] {
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

      recent.push({ callId: call.callId, reason: call.reason });
    }

    if (calls.size === 0) {
      this.recentTerminalCallsByUser.delete(userId);
    }

    return recent;
  }

  private emitPeerLeft(callId: string, userId: string, reason: string): void {
    this.server.to(callId).emit('peer_left', {
      callId,
      userId,
      reason,
    });
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

    await this.stateRepository.removeParticipant(callId, userId);
    const result = await this.leaveCallUseCase.execute(
      callId,
      userId,
      'disconnected',
    );
    if (result.shouldEmitPeerLeft) {
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

            await this.stateRepository.removeParticipant(callId, userId);
            const result = await this.leaveCallUseCase.execute(
              callId,
              userId,
              'disconnected',
            );
            if (result.shouldEmitPeerLeft) {
              this.emitPeerLeft(callId, userId, 'disconnected');
            }
            if (result.didTransition !== false) {
              this.emitCallEnded(result.session, result.endedReason);
            }
          } catch (error) {
            this.logger.warn(
              `Deferred disconnect cleanup failed for call ${callId}: ${
                error instanceof Error ? error.message : String(error)
              }`,
            );
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
        `Durable unanswered-call sweep failed: ${
          error instanceof Error ? error.message : String(error)
        }`,
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

  private getResolvedUserId(client: Socket): string | null {
    const socketData = client.data as Record<string, unknown>;
    const cachedUserId = socketData['userId'];
    return typeof cachedUserId === 'string' && cachedUserId
      ? cachedUserId
      : null;
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
      this.logger.warn(`Socket ${client.id} provided an invalid access token`);
      client.disconnect(true);
      return null;
    }

    const socketData = client.data as Record<string, unknown>;
    socketData['userId'] = user.id;
    return user.id;
  }
}
