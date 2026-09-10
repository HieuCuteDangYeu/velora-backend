import { GATEWAY_OPTIONS } from '@nestjs/websockets/constants';
import type { Socket } from 'socket.io';
import { CallParticipant } from '../../../src/domain/entities/call-participant.entity';
import { CallSession } from '../../../src/domain/entities/call-session.entity';
import { CallGateway } from '../../../src/infrastructure/gateways/call.gateway';

describe('CallGateway reconnect recovery', () => {
  const initiatedVoiceSession = new CallSession({
    callId: 'call-0',
    conversationId: 'conv-0',
    initiatorId: 'user-a',
    targetUserId: 'user-b',
    callType: 'VOICE',
    status: 'initiated',
    participantIds: ['user-a'],
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
    updatedAt: new Date('2026-01-01T00:00:00.000Z'),
  });
  const activeSession = new CallSession({
    callId: 'call-1',
    conversationId: 'conv-1',
    initiatorId: 'user-a',
    targetUserId: 'user-b',
    callType: 'VOICE',
    status: 'active',
    participantIds: ['user-a', 'user-b'],
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
    updatedAt: new Date('2026-01-01T00:00:00.000Z'),
  });

  beforeEach(() => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2026-01-01T00:00:00.000Z'));
    process.env.CALL_RECONNECT_GRACE_MS = '15000';
    process.env.CALL_NO_ANSWER_TIMEOUT_MS = '30000';
  });

  afterEach(() => {
    jest.useRealTimers();
    delete process.env.CALL_RECONNECT_GRACE_MS;
    delete process.env.CALL_NO_ANSWER_TIMEOUT_MS;
  });

  it('uses strict heartbeat settings for the call namespace', () => {
    expect(Reflect.getMetadata(GATEWAY_OPTIONS, CallGateway)).toMatchObject({
      namespace: '/call',
      pingInterval: 5000,
      pingTimeout: 5000,
    });
  });

  it('does not start the durable expiry worker without the runtime lease', async () => {
    const runtimeLease = {
      acquire: jest.fn().mockResolvedValue(undefined),
      assertHeld: jest.fn(() => {
        throw new Error('Call runtime lease is not held');
      }),
    };
    const gateway = createGateway({ runtimeLease });

    await expect(gateway.onModuleInit()).rejects.toThrow('lease is not held');
    expect(runtimeLease.acquire).toHaveBeenCalledTimes(1);
    expect(runtimeLease.assertHeld).toHaveBeenCalledTimes(1);
  });

  it('rejects an established socket request after the runtime lease is lost', async () => {
    const initiateCallUseCase = { execute: jest.fn() };
    const runtimeLease = {
      acquire: jest.fn().mockResolvedValue(undefined),
      assertHeld: jest.fn(() => {
        throw new Error('Call runtime lease is not held');
      }),
    };
    const gateway = createGateway({ initiateCallUseCase, runtimeLease });

    await expect(
      gateway.handleInitiateCall(
        {
          conversationId: 'conv-1',
          targetUserId: 'user-b',
          callType: 'VOICE',
        },
        createSocket({ id: 'socket-1', userId: 'user-a', callIds: [] }),
      ),
    ).rejects.toThrow('lease is not held');

    expect(initiateCallUseCase.execute).not.toHaveBeenCalled();
  });

  it('uses the durable expiration transition after the no-answer timeout', async () => {
    const initiateCallUseCase = {
      execute: jest.fn().mockResolvedValue({
        role: 'host',
        session: initiatedVoiceSession,
        rtpCapabilities: { codecs: [], headerExtensions: [] },
      }),
    };
    const expireDueCallsUseCase = {
      execute: jest
        .fn()
        .mockResolvedValue([
          { session: initiatedVoiceSession, reason: 'no_answer' },
        ]),
    };
    const callEmitter = { emit: jest.fn() };
    const userEmitter = { emit: jest.fn() };
    const gateway = createGateway({
      initiateCallUseCase,
      expireDueCallsUseCase,
    });
    gateway.server = {
      to: jest.fn().mockImplementation((roomId: string) => {
        return roomId === initiatedVoiceSession.targetUserId
          ? userEmitter
          : callEmitter;
      }),
    } as never;

    const callerSocket = createSocket({
      id: 'socket-0',
      userId: initiatedVoiceSession.initiatorId,
      callIds: [],
      emit: jest.fn(),
    });

    await gateway.handleInitiateCall(
      {
        conversationId: initiatedVoiceSession.conversationId,
        targetUserId: initiatedVoiceSession.targetUserId,
        callType: 'VOICE',
      },
      callerSocket,
    );

    expect(callerSocket.emit).toHaveBeenCalledWith(
      'call_joined',
      expect.objectContaining({
        callId: initiatedVoiceSession.callId,
        noAnswerTimeoutMs: 30000,
      }),
    );

    expect(userEmitter.emit).toHaveBeenCalledWith(
      'incoming_call',
      expect.objectContaining({
        callId: initiatedVoiceSession.callId,
        conversationId: initiatedVoiceSession.conversationId,
        initiatorId: initiatedVoiceSession.initiatorId,
        targetUserId: initiatedVoiceSession.targetUserId,
        callType: 'VOICE',
      }),
    );

    await jest.advanceTimersByTimeAsync(30000);

    expect(expireDueCallsUseCase.execute).toHaveBeenCalledWith(
      expect.any(Date),
    );
    expect(callEmitter.emit).toHaveBeenCalledWith('call_ended', {
      callId: initiatedVoiceSession.callId,
      reason: 'no_answer',
    });
  });

  it('clears the unanswered timeout when the callee answers', async () => {
    const initiateCallUseCase = {
      execute: jest.fn().mockResolvedValue({
        role: 'host',
        session: initiatedVoiceSession,
        rtpCapabilities: { codecs: [], headerExtensions: [] },
      }),
    };
    const acceptIncomingCallUseCase = {
      execute: jest.fn().mockResolvedValue({ outcome: 'accepted' }),
    };
    const leaveCallUseCase = {
      execute: jest.fn(),
    };
    const gateway = createGateway({
      initiateCallUseCase,
      acceptIncomingCallUseCase,
      leaveCallUseCase,
      sessionRepository: {
        findByCallId: jest.fn().mockResolvedValue(
          new CallSession({
            ...initiatedVoiceSession,
            status: 'ringing',
            participantIds: [
              initiatedVoiceSession.initiatorId,
              initiatedVoiceSession.targetUserId,
            ],
          }),
        ),
      },
    });
    gateway.server = {
      to: jest.fn().mockReturnValue({ emit: jest.fn() }),
    } as never;

    await gateway.handleInitiateCall(
      {
        conversationId: initiatedVoiceSession.conversationId,
        targetUserId: initiatedVoiceSession.targetUserId,
        callType: 'VOICE',
      },
      createSocket({
        id: 'socket-0',
        userId: initiatedVoiceSession.initiatorId,
        callIds: [],
      }),
    );

    await gateway.handleAnswerCall(
      { callId: initiatedVoiceSession.callId },
      createSocket({
        id: 'socket-1',
        userId: initiatedVoiceSession.targetUserId,
        callIds: [initiatedVoiceSession.callId],
      }),
    );
    await jest.advanceTimersByTimeAsync(30000);

    expect(acceptIncomingCallUseCase.execute).toHaveBeenCalledWith(
      initiatedVoiceSession.callId,
      initiatedVoiceSession.targetUserId,
      'socket-1',
      'legacy:socket-1',
    );
    expect(leaveCallUseCase.execute).not.toHaveBeenCalled();
  });

  it('preserves a rollback client native action id through legacy answer_call', async () => {
    const acceptIncomingCallUseCase = {
      execute: jest.fn().mockResolvedValue({ outcome: 'accepted' }),
    };
    const gateway = createGateway({
      acceptIncomingCallUseCase,
      sessionRepository: {
        findByCallId: jest.fn().mockResolvedValue(
          new CallSession({
            ...initiatedVoiceSession,
            status: 'ringing',
            participantIds: [
              initiatedVoiceSession.initiatorId,
              initiatedVoiceSession.targetUserId,
            ],
          }),
        ),
      },
    });
    const roomEmitter = { emit: jest.fn() };
    gateway.server = {
      to: jest.fn().mockReturnValue(roomEmitter),
    } as never;

    await gateway.handleAnswerCall(
      {
        callId: initiatedVoiceSession.callId,
        actionId: 'native-answer-action-1',
      },
      createSocket({
        id: 'socket-1',
        userId: initiatedVoiceSession.targetUserId,
        callIds: [initiatedVoiceSession.callId],
      }),
    );

    expect(acceptIncomingCallUseCase.execute).toHaveBeenCalledWith(
      initiatedVoiceSession.callId,
      initiatedVoiceSession.targetUserId,
      'socket-1',
      'native-answer-action-1',
    );
    expect(roomEmitter.emit).toHaveBeenCalledWith('call_answered', {
      callId: initiatedVoiceSession.callId,
      userId: initiatedVoiceSession.targetUserId,
      answerActionId: 'native-answer-action-1',
    });
  });

  it('routes a rollback action retry through the atomic lifecycle after its ACK was lost', async () => {
    const acceptIncomingCallUseCase = {
      execute: jest.fn().mockResolvedValue({
        outcome: 'already_accepted_same_attempt',
        role: 'guest',
        session: new CallSession({
          ...initiatedVoiceSession,
          status: 'active',
          answerActionId: 'native-answer-action-1',
        }),
        rtpCapabilities: { codecs: [], headerExtensions: [] },
      }),
    };
    const gateway = createGateway({
      acceptIncomingCallUseCase,
      sessionRepository: {
        findByCallId: jest.fn().mockResolvedValue(
          new CallSession({
            ...initiatedVoiceSession,
            status: 'active',
            answerActionId: 'native-answer-action-1',
          }),
        ),
      },
    });
    gateway.server = {
      to: jest.fn().mockReturnValue({ emit: jest.fn() }),
    } as never;

    await expect(
      gateway.handleAnswerCall(
        {
          callId: initiatedVoiceSession.callId,
          actionId: 'native-answer-action-1',
        },
        createSocket({
          id: 'socket-2',
          userId: initiatedVoiceSession.targetUserId,
          callIds: [],
        }),
      ),
    ).resolves.toBeUndefined();

    expect(acceptIncomingCallUseCase.execute).toHaveBeenCalledWith(
      initiatedVoiceSession.callId,
      initiatedVoiceSession.targetUserId,
      'socket-2',
      'native-answer-action-1',
    );
  });

  it('defers active-call teardown until the reconnect grace window expires', async () => {
    const leaveCallUseCase = {
      execute: jest.fn().mockResolvedValue({
        session: activeSession,
        endedReason: 'disconnected',
        shouldEmitPeerLeft: true,
      }),
    };
    const stateRepository = {
      getParticipant: jest
        .fn()
        .mockResolvedValueOnce(
          new CallParticipant({
            userId: 'user-a',
            callId: 'call-1',
            role: 'host',
            socketId: 'socket-1',
            socketIds: ['socket-1'],
            isConnected: true,
            joinedAt: new Date('2026-01-01T00:00:00.000Z'),
          }),
        )
        .mockResolvedValueOnce(
          new CallParticipant({
            userId: 'user-a',
            callId: 'call-1',
            role: 'host',
            socketIds: [],
            isConnected: false,
            reconnectDeadlineAt: new Date('2026-01-01T00:00:15.000Z'),
            joinedAt: new Date('2026-01-01T00:00:00.000Z'),
          }),
        ),
      upsertParticipant: jest.fn(),
      removeParticipant: jest.fn(),
    };
    const gateway = createGateway({
      leaveCallUseCase,
      sessionRepository: {
        findByCallId: jest.fn().mockResolvedValue(activeSession),
      },
      stateRepository,
    });
    const peerEmitter = { emit: jest.fn() };
    const roomEmitter = { emit: jest.fn() };
    gateway.server = {
      to: jest.fn().mockReturnValue(roomEmitter),
    } as never;

    await gateway.handleDisconnect(
      createSocket({
        id: 'socket-1',
        userId: 'user-a',
        callIds: ['call-1'],
        to: jest.fn().mockReturnValue(peerEmitter),
      }),
    );

    expect(stateRepository.upsertParticipant).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: 'user-a',
        callId: 'call-1',
        socketIds: [],
        isConnected: false,
      }),
    );
    expect(roomEmitter.emit).toHaveBeenNthCalledWith(1, 'peer_reconnecting', {
      callId: 'call-1',
      userId: 'user-a',
      reconnectDeadlineAt: '2026-01-01T00:00:15.000Z',
    });
    expect(leaveCallUseCase.execute).not.toHaveBeenCalled();

    await jest.advanceTimersByTimeAsync(15000);

    expect(stateRepository.removeParticipant).toHaveBeenCalledWith(
      'call-1',
      'user-a',
    );
    expect(leaveCallUseCase.execute).toHaveBeenCalledWith(
      'call-1',
      'user-a',
      'disconnected',
    );
    expect(roomEmitter.emit).toHaveBeenNthCalledWith(2, 'peer_left', {
      callId: 'call-1',
      userId: 'user-a',
      reason: 'disconnected',
    });
    expect(roomEmitter.emit).toHaveBeenNthCalledWith(3, 'call_ended', {
      callId: 'call-1',
      reason: 'disconnected',
    });
  });

  it('clears the pending disconnect timeout, notifies the peer, and replays active producers after a successful rejoin', async () => {
    const joinCallUseCase = {
      execute: jest.fn().mockResolvedValue({
        role: 'host',
        session: activeSession,
        rtpCapabilities: { codecs: [], headerExtensions: [] },
      }),
    };
    const leaveCallUseCase = {
      execute: jest.fn(),
    };
    const stateRepository = {
      getParticipant: jest
        .fn()
        .mockResolvedValueOnce(
          new CallParticipant({
            userId: 'user-a',
            callId: 'call-1',
            role: 'host',
            socketId: 'socket-1',
            socketIds: ['socket-1'],
            isConnected: true,
            joinedAt: new Date('2026-01-01T00:00:00.000Z'),
          }),
        )
        .mockResolvedValueOnce(
          new CallParticipant({
            userId: 'user-a',
            callId: 'call-1',
            role: 'host',
            socketIds: [],
            isConnected: false,
            reconnectDeadlineAt: new Date('2026-01-01T00:00:15.000Z'),
            joinedAt: new Date('2026-01-01T00:00:00.000Z'),
          }),
        ),
      upsertParticipant: jest.fn(),
      removeParticipant: jest.fn(),
    };
    const sessionRepository = {
      findByCallId: jest.fn().mockResolvedValue(activeSession),
    };
    const mediaEngine = {
      listActiveProducers: jest.fn().mockResolvedValue([
        {
          producerId: 'producer-1',
          userId: 'user-b',
          kind: 'audio',
        },
      ]),
    };
    const peerEmitter = { emit: jest.fn() };
    const gateway = createGateway({
      joinCallUseCase,
      leaveCallUseCase,
      mediaEngine,
      sessionRepository,
      stateRepository,
    });
    gateway.server = {
      to: jest.fn().mockReturnValue(peerEmitter),
    } as never;

    await gateway.handleDisconnect(
      createSocket({
        id: 'socket-1',
        userId: 'user-a',
        callIds: ['call-1'],
        to: jest.fn().mockReturnValue(peerEmitter),
      }),
    );

    const rejoiningSocket = createSocket({
      id: 'socket-2',
      userId: 'user-a',
      emit: jest.fn(),
      join: jest.fn().mockResolvedValue(undefined),
      to: jest.fn().mockReturnValue(peerEmitter),
    });

    await gateway.handleRejoinCall({ callId: 'call-1' }, rejoiningSocket);
    await jest.advanceTimersByTimeAsync(15000);

    expect(joinCallUseCase.execute).toHaveBeenCalledWith(
      'call-1',
      'user-a',
      'socket-2',
    );
    expect(rejoiningSocket.emit).toHaveBeenCalledWith(
      'call_rejoined',
      expect.objectContaining({
        callId: 'call-1',
        session: expect.objectContaining({
          status: 'active',
        }),
      }),
    );
    expect(peerEmitter.emit).toHaveBeenCalledWith('peer_reconnected', {
      callId: 'call-1',
      userId: 'user-a',
    });
    expect(mediaEngine.listActiveProducers).toHaveBeenCalledWith(
      'call-1',
      'user-a',
    );
    expect(rejoiningSocket.emit).toHaveBeenCalledWith('new_producer', {
      callId: 'call-1',
      userId: 'user-b',
      producerId: 'producer-1',
      kind: 'audio',
      paused: false,
    });
    expect(leaveCallUseCase.execute).not.toHaveBeenCalled();
    expect(stateRepository.removeParticipant).not.toHaveBeenCalled();
  });

  it('rejects rejoin when the reconnect deadline has already expired', async () => {
    const joinCallUseCase = {
      execute: jest.fn(),
    };
    const stateRepository = {
      getParticipant: jest.fn().mockResolvedValue(
        new CallParticipant({
          userId: 'user-a',
          callId: 'call-1',
          role: 'host',
          socketIds: [],
          isConnected: false,
          reconnectDeadlineAt: new Date('2025-12-31T23:59:59.000Z'),
          joinedAt: new Date('2026-01-01T00:00:00.000Z'),
        }),
      ),
      upsertParticipant: jest.fn(),
      removeParticipant: jest.fn(),
    };
    const gateway = createGateway({
      joinCallUseCase,
      sessionRepository: {
        findByCallId: jest.fn().mockResolvedValue(activeSession),
      },
      stateRepository,
    });

    await expect(
      gateway.handleRejoinCall(
        { callId: 'call-1' },
        createSocket({
          id: 'socket-2',
          userId: 'user-a',
          emit: jest.fn(),
          join: jest.fn().mockResolvedValue(undefined),
        }),
      ),
    ).rejects.toThrow('Reconnect window expired');
    expect(joinCallUseCase.execute).not.toHaveBeenCalled();
  });
  it('acknowledges an atomic native answer before broadcasting it to the call and callee-user rooms', async () => {
    const acceptIncomingCallUseCase = {
      execute: jest.fn().mockResolvedValue({
        outcome: 'accepted',
        role: 'guest',
        session: activeSession,
        rtpCapabilities: { codecs: [], headerExtensions: [] },
        activeProducers: [],
      }),
    };
    const roomEmitter = { emit: jest.fn() };
    const calleeUserEmitter = { emit: jest.fn() };
    const gateway = createGateway({ acceptIncomingCallUseCase });
    gateway.server = {
      to: jest
        .fn()
        .mockImplementation((roomId: string) =>
          roomId === activeSession.targetUserId
            ? calleeUserEmitter
            : roomEmitter,
        ),
    } as never;
    const callee = createSocket({
      id: 'socket-2',
      userId: activeSession.targetUserId,
      callIds: [],
      emit: jest.fn(),
    });

    await gateway.handleAcceptIncomingCall(
      { callId: activeSession.callId, actionId: 'callkit-answer-1' },
      callee,
    );

    expect(acceptIncomingCallUseCase.execute).toHaveBeenCalledWith(
      activeSession.callId,
      activeSession.targetUserId,
      'socket-2',
      'callkit-answer-1',
    );
    expect(callee.join).toHaveBeenCalledWith(activeSession.callId);
    expect(callee.emit).toHaveBeenCalledWith(
      'incoming_call_acceptance',
      expect.objectContaining({
        callId: activeSession.callId,
        outcome: 'accepted',
        role: 'guest',
      }),
    );
    expect(roomEmitter.emit).toHaveBeenCalledWith('call_answered', {
      callId: activeSession.callId,
      userId: activeSession.targetUserId,
      answerActionId: 'callkit-answer-1',
    });
    expect(calleeUserEmitter.emit).toHaveBeenCalledWith('call_answered', {
      callId: activeSession.callId,
      userId: activeSession.targetUserId,
      answerActionId: 'callkit-answer-1',
    });
  });

  it('reconciles an accepted native answer when the socket drops before room attachment', async () => {
    const acceptIncomingCallUseCase = {
      execute: jest.fn().mockResolvedValue({
        outcome: 'accepted',
        role: 'guest',
        session: activeSession,
        rtpCapabilities: { codecs: [], headerExtensions: [] },
        activeProducers: [],
      }),
    };
    const participant = new CallParticipant({
      userId: activeSession.targetUserId,
      callId: activeSession.callId,
      role: 'guest',
      socketId: 'socket-2',
      socketIds: ['socket-2'],
      isConnected: true,
      joinedAt: new Date('2026-01-01T00:00:00.000Z'),
    });
    const stateRepository = {
      getParticipant: jest.fn().mockResolvedValue(participant),
      upsertParticipant: jest.fn(),
      removeParticipant: jest.fn(),
    };
    const roomEmitter = { emit: jest.fn() };
    const gateway = createGateway({
      acceptIncomingCallUseCase,
      sessionRepository: {
        findByCallId: jest.fn().mockResolvedValue(activeSession),
      },
      stateRepository,
    });
    gateway.server = {
      to: jest.fn().mockReturnValue(roomEmitter),
    } as never;
    const callee = createSocket({
      id: 'socket-2',
      userId: activeSession.targetUserId,
      callIds: [],
      disconnected: true,
      emit: jest.fn(),
    });

    await gateway.handleAcceptIncomingCall(
      { callId: activeSession.callId, actionId: 'callkit-answer-1' },
      callee,
    );

    expect(acceptIncomingCallUseCase.execute).toHaveBeenCalledWith(
      activeSession.callId,
      activeSession.targetUserId,
      'socket-2',
      'callkit-answer-1',
    );
    expect(callee.join).not.toHaveBeenCalled();
    expect(callee.emit).not.toHaveBeenCalled();
    expect(stateRepository.upsertParticipant).toHaveBeenCalledWith(
      expect.objectContaining({
        callId: activeSession.callId,
        userId: activeSession.targetUserId,
        socketIds: [],
        isConnected: false,
        reconnectDeadlineAt: new Date('2026-01-01T00:00:15.000Z'),
      }),
    );
    expect(roomEmitter.emit).toHaveBeenCalledWith(
      'peer_reconnecting',
      expect.objectContaining({
        callId: activeSession.callId,
        userId: activeSession.targetUserId,
        reconnectDeadlineAt: '2026-01-01T00:00:15.000Z',
      }),
    );
    expect(roomEmitter.emit).not.toHaveBeenCalledWith(
      'call_answered',
      expect.anything(),
    );
  });

  it('rejects a missing native action id before it can mutate call state', async () => {
    const acceptIncomingCallUseCase = { execute: jest.fn() };
    const gateway = createGateway({ acceptIncomingCallUseCase });

    await expect(
      gateway.handleAcceptIncomingCall(
        { callId: activeSession.callId, actionId: '   ' },
        createSocket({
          id: 'socket-2',
          userId: activeSession.targetUserId,
          callIds: [],
        }),
      ),
    ).rejects.toThrow('A call action id is required');
    expect(acceptIncomingCallUseCase.execute).not.toHaveBeenCalled();
  });

  it('normalizes an invalid persisted expiry before emitting an incoming call', async () => {
    const corruptExpirySession = new CallSession({
      ...initiatedVoiceSession,
      ringTimeoutMs: 1250,
      expiresAt: new Date('invalid'),
    });
    const initiateCallUseCase = {
      execute: jest.fn().mockResolvedValue({
        role: 'host',
        session: corruptExpirySession,
        rtpCapabilities: { codecs: [], headerExtensions: [] },
      }),
    };
    const recipientEmitter = { emit: jest.fn() };
    const gateway = createGateway({ initiateCallUseCase });
    gateway.server = {
      to: jest.fn().mockReturnValue(recipientEmitter),
    } as never;

    await gateway.handleInitiateCall(
      {
        conversationId: corruptExpirySession.conversationId,
        targetUserId: corruptExpirySession.targetUserId,
        callType: 'VOICE',
      },
      createSocket({
        id: 'socket-1',
        userId: corruptExpirySession.initiatorId,
        callIds: [],
      }),
    );

    const incomingPayload = recipientEmitter.emit.mock.calls.find(
      ([event]) => event === 'incoming_call',
    )?.[1];
    expect(incomingPayload).toEqual(
      expect.objectContaining({ ringTimeoutMs: 1250 }),
    );
    expect(Date.parse(incomingPayload.expiresAt)).not.toBeNaN();
    gateway.onModuleDestroy();
  });
});

function createGateway(overrides?: {
  initiateCallUseCase?: { execute: jest.Mock };
  joinCallUseCase?: { execute: jest.Mock };
  leaveCallUseCase?: { execute: jest.Mock };
  rejectCallUseCase?: { execute: jest.Mock };
  acceptIncomingCallUseCase?: { execute: jest.Mock };
  expireDueCallsUseCase?: { execute: jest.Mock };
  recoverActiveCallsAfterMediaRestartUseCase?: { execute: jest.Mock };
  runtimeLease?: { acquire: jest.Mock; assertHeld: jest.Mock };
  mediaEngine?: { listActiveProducers: jest.Mock };
  sessionRepository?: { findByCallId: jest.Mock };
  stateRepository?: {
    getParticipant: jest.Mock;
    upsertParticipant: jest.Mock;
    removeParticipant: jest.Mock;
  };
}) {
  return new CallGateway(
    (overrides?.initiateCallUseCase ?? { execute: jest.fn() }) as never,
    (overrides?.joinCallUseCase ?? { execute: jest.fn() }) as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    (overrides?.leaveCallUseCase ?? { execute: jest.fn() }) as never,
    (overrides?.rejectCallUseCase ?? { execute: jest.fn() }) as never,
    (overrides?.acceptIncomingCallUseCase ?? { execute: jest.fn() }) as never,
    (overrides?.expireDueCallsUseCase ?? {
      execute: jest.fn().mockResolvedValue([]),
    }) as never,
    (overrides?.recoverActiveCallsAfterMediaRestartUseCase ?? {
      execute: jest.fn().mockResolvedValue([]),
    }) as never,
    {} as never,
    {} as never,
    {} as never,
    (overrides?.mediaEngine ?? {
      listActiveProducers: jest.fn().mockResolvedValue([]),
    }) as never,
    (overrides?.sessionRepository ?? {
      findByCallId: jest.fn(),
    }) as never,
    (overrides?.stateRepository ?? {
      getParticipant: jest.fn(),
      upsertParticipant: jest.fn(),
      removeParticipant: jest.fn(),
    }) as never,
    { send: jest.fn() } as never,
    { issue: jest.fn().mockReturnValue('telemetry-token') } as never,
    (overrides?.runtimeLease ?? {
      acquire: jest.fn().mockResolvedValue(undefined),
      assertHeld: jest.fn(),
    }) as never,
  );
}

function createSocket(input: {
  id: string;
  userId: string;
  callIds: string[];
  emit?: jest.Mock;
  join?: jest.Mock;
  to?: jest.Mock;
  disconnected?: boolean;
}) {
  return {
    id: input.id,
    data: {
      userId: input.userId,
      callIds: input.callIds,
    },
    emit: input.emit ?? jest.fn(),
    join: input.join ?? jest.fn().mockResolvedValue(undefined),
    to: input.to ?? jest.fn().mockReturnValue({ emit: jest.fn() }),
    disconnected: input.disconnected ?? false,
  } as unknown as Socket;
}
