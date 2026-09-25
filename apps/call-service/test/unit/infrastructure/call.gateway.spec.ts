import { GATEWAY_OPTIONS } from '@nestjs/websockets/constants';
import { ServiceUnavailableException } from '@nestjs/common';
import type { Socket } from 'socket.io';
import { CallParticipant } from '../../../src/domain/entities/call-participant.entity';
import { CallSession } from '../../../src/domain/entities/call-session.entity';
import { GroupJoinMediaUnavailableError } from '../../../src/application/use-cases/join-call.use-case';
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
    delete process.env.CALL_SOCKET_PING_INTERVAL_MS;
    delete process.env.CALL_SOCKET_PING_TIMEOUT_MS;
    process.env.CALL_NO_ANSWER_TIMEOUT_MS = '30000';
  });

  afterEach(() => {
    jest.useRealTimers();
    delete process.env.CALL_RECONNECT_GRACE_MS;
    delete process.env.CALL_NO_ANSWER_TIMEOUT_MS;
    delete process.env.CALL_SOCKET_PING_INTERVAL_MS;
    delete process.env.CALL_SOCKET_PING_TIMEOUT_MS;
  });

  it('uses mobile-safe heartbeat settings for the call namespace', () => {
    expect(Reflect.getMetadata(GATEWAY_OPTIONS, CallGateway)).toMatchObject({
      namespace: '/call',
      pingInterval: 25000,
      pingTimeout: 20000,
    });
  });

  it('records the Socket.IO disconnect reason at the connection boundary', async () => {
    const metrics = {
      recordSocketDisconnect: jest.fn(),
      recordSocketReconnect: jest.fn(),
    };
    const socket = createSocket({
      id: 'socket-metrics',
      userId: 'user-a',
      callIds: [],
    });
    const gateway = createGateway({ metrics });

    await gateway.handleConnection(socket);

    const disconnectListener = (socket.once as jest.Mock).mock.calls.find(
      ([event]) => event === 'disconnect',
    )?.[1] as ((reason: string) => void) | undefined;
    expect(disconnectListener).toBeDefined();
    disconnectListener?.('ping timeout');
    expect(metrics.recordSocketDisconnect).toHaveBeenCalledWith('ping timeout');
  });

  it('keeps legacy sockets on the direct-call room but out of group invites', async () => {
    const oldSocket = createSocket({
      id: 'old-socket',
      userId: 'user-b',
      groupLifecycleVersion: 1,
    });
    const modernSocket = createSocket({
      id: 'modern-socket',
      userId: 'user-b',
      groupLifecycleVersion: 2,
    });
    const gateway = createGateway();

    await gateway.handleConnection(oldSocket);
    await gateway.handleConnection(modernSocket);

    expect(oldSocket.join).toHaveBeenCalledWith('user-b');
    expect(oldSocket.join).not.toHaveBeenCalledWith(
      'group-lifecycle-v2:user-b',
    );
    expect(modernSocket.join).toHaveBeenCalledWith('group-lifecycle-v2:user-b');
  });

  it('does not deliver group incoming to a legacy user room', async () => {
    const groupSession = new CallSession({
      ...activeSession,
      isGroupCall: true,
      invitedUserIds: ['user-a', 'user-b'],
    });
    const initiateCallUseCase = {
      execute: jest.fn().mockResolvedValue({
        role: 'host',
        session: groupSession,
        rtpCapabilities: { codecs: [], headerExtensions: [] },
      }),
    };
    const gateway = createGateway({ initiateCallUseCase });
    gateway.server = {
      to: jest.fn().mockReturnValue({ emit: jest.fn() }),
    } as never;
    const caller = createSocket({ id: 'socket-a', userId: 'user-a' });

    await gateway.handleInitiateCall(
      { conversationId: 'conv-1', callType: 'VOICE' },
      caller,
    );

    expect(gateway.server.to).toHaveBeenCalledWith('group-lifecycle-v2:user-b');
    expect(gateway.server.to).not.toHaveBeenCalledWith('user-b');
    expect(initiateCallUseCase.execute).toHaveBeenCalledWith(
      'conv-1',
      'user-a',
      undefined,
      'VOICE',
      'socket-a',
      2,
    );
  });

  it('denies an old client group join before calling the join use case', async () => {
    const groupSession = new CallSession({
      ...activeSession,
      isGroupCall: true,
    });
    const joinCallUseCase = { execute: jest.fn() };
    const gateway = createGateway({
      joinCallUseCase,
      sessionRepository: {
        findByCallId: jest.fn().mockResolvedValue(groupSession),
      },
    });
    const oldSocket = createSocket({
      id: 'old-socket',
      userId: 'user-b',
      groupLifecycleVersion: 1,
    });

    await expect(
      gateway.handleJoinCall({ callId: 'call-1' }, oldSocket),
    ).rejects.toThrow('Group call requires a newer client');
    expect(joinCallUseCase.execute).not.toHaveBeenCalled();
  });

  it('does not let an old same-account socket end a modern group call', async () => {
    const groupSession = new CallSession({
      ...activeSession,
      isGroupCall: true,
    });
    const leaveCallUseCase = { execute: jest.fn() };
    const gateway = createGateway({
      leaveCallUseCase,
      sessionRepository: {
        findByCallId: jest.fn().mockResolvedValue(groupSession),
      },
    });
    const oldHostSocket = createSocket({
      id: 'old-host-socket',
      userId: 'user-a',
      groupLifecycleVersion: 1,
    });

    await expect(
      gateway.handleLeaveCall({ callId: 'call-1' }, oldHostSocket),
    ).rejects.toThrow('Group call requires a newer client');
    expect(leaveCallUseCase.execute).not.toHaveBeenCalled();
  });

  it('replays group terminal state only to capable sockets', async () => {
    const groupSession = new CallSession({
      ...activeSession,
      isGroupCall: true,
      invitedUserIds: ['user-a', 'user-b'],
    });
    const gateway = createGateway({
      leaveCallUseCase: {
        execute: jest.fn().mockResolvedValue({
          session: groupSession,
          endedReason: 'ended',
          shouldEmitPeerLeft: false,
          didTransition: true,
          closedProducers: [],
        }),
      },
      sessionRepository: {
        findByCallId: jest.fn().mockResolvedValue(groupSession),
      },
    });
    const terminalEmitter = { emit: jest.fn() };
    gateway.server = {
      to: jest.fn().mockReturnValue(terminalEmitter),
    } as never;
    await gateway.handleLeaveCall(
      { callId: 'call-1' },
      createSocket({ id: 'modern-host', userId: 'user-a' }),
    );

    const oldGuest = createSocket({
      id: 'old-guest',
      userId: 'user-b',
      groupLifecycleVersion: 1,
    });
    const modernGuest = createSocket({ id: 'modern-guest', userId: 'user-b' });
    await gateway.handleConnection(oldGuest);
    await gateway.handleConnection(modernGuest);

    expect(gateway.server.to).toHaveBeenCalledWith([
      'call-1',
      'group-lifecycle-v2:user-a',
      'group-lifecycle-v2:user-b',
    ]);
    expect(oldGuest.emit).toHaveBeenCalledWith('call_socket_ready', {
      recentTerminalCalls: [],
    });
    expect(modernGuest.emit).toHaveBeenCalledWith('call_socket_ready', {
      recentTerminalCalls: [{ callId: 'call-1', reason: 'ended' }],
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

  it('retries a transient disconnect cleanup failure without separately removing the participant', async () => {
    const leaveCallUseCase = {
      execute: jest
        .fn()
        .mockRejectedValueOnce(new Error('Redis temporarily unavailable'))
        .mockResolvedValue({
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
        )
        .mockResolvedValue(
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
      removeParticipant: jest
        .fn()
        .mockRejectedValue(new Error('Redis participant removal failed')),
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

    expect(stateRepository.removeParticipant).not.toHaveBeenCalled();
    expect(leaveCallUseCase.execute).toHaveBeenCalledTimes(1);
    expect(roomEmitter.emit).toHaveBeenCalledTimes(1);

    await jest.advanceTimersByTimeAsync(1000);

    expect(leaveCallUseCase.execute).toHaveBeenCalledTimes(2);
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

  it('closes a disconnected group guest audio before removing them from the room', async () => {
    const groupSession = new CallSession({
      ...activeSession,
      isGroupCall: true,
      invitedUserIds: ['user-a', 'user-b', 'user-c'],
      participantIds: ['user-a', 'user-b', 'user-c'],
    });
    const participant = new CallParticipant({
      userId: 'user-b',
      callId: 'call-1',
      role: 'guest',
      socketId: 'socket-b',
      socketIds: ['socket-b'],
      isConnected: true,
      joinedAt: new Date('2026-01-01T00:00:00.000Z'),
    });
    const stateRepository = {
      getParticipant: jest
        .fn()
        .mockResolvedValueOnce(participant)
        .mockResolvedValueOnce(
          new CallParticipant({
            ...participant,
            socketIds: [],
            socketId: undefined,
            isConnected: false,
            reconnectDeadlineAt: new Date('2026-01-01T00:00:15.000Z'),
          }),
        ),
      upsertParticipant: jest.fn(),
      removeParticipant: jest.fn(),
    };
    const gateway = createGateway({
      leaveCallUseCase: {
        execute: jest.fn().mockResolvedValue({
          session: groupSession,
          endedReason: 'disconnected',
          shouldEmitPeerLeft: true,
          didTransition: false,
          closedProducers: [{ producerId: 'audio-b', kind: 'audio' }],
        }),
      },
      sessionRepository: {
        findByCallId: jest.fn().mockResolvedValue(groupSession),
      },
      stateRepository,
    });
    const roomEmitter = { emit: jest.fn() };
    gateway.server = { to: jest.fn().mockReturnValue(roomEmitter) } as never;

    await gateway.handleDisconnect(
      createSocket({ id: 'socket-b', userId: 'user-b', callIds: ['call-1'] }),
    );
    await jest.advanceTimersByTimeAsync(15000);

    expect(roomEmitter.emit.mock.calls).toEqual([
      [
        'peer_reconnecting',
        {
          callId: 'call-1',
          userId: 'user-b',
          reconnectDeadlineAt: '2026-01-01T00:00:15.000Z',
        },
      ],
      [
        'producer_closed',
        {
          callId: 'call-1',
          userId: 'user-b',
          producerId: 'audio-b',
          kind: 'audio',
        },
      ],
      [
        'peer_left',
        { callId: 'call-1', userId: 'user-b', reason: 'disconnected' },
      ],
    ]);
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
    const metrics = {
      recordSocketDisconnect: jest.fn(),
      recordSocketReconnect: jest.fn(),
    };
    const gateway = createGateway({
      joinCallUseCase,
      leaveCallUseCase,
      mediaEngine,
      sessionRepository,
      stateRepository,
      metrics,
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

    await jest.advanceTimersByTimeAsync(1200);
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
    expect(metrics.recordSocketReconnect).toHaveBeenCalledWith(1200);
  });

  it('serializes camera revisions, rejects stale updates, and makes retries idempotent', async () => {
    const videoSession = new CallSession({
      ...activeSession,
      callType: 'VIDEO',
    });
    const mediaEngine = {
      listActiveProducers: jest
        .fn()
        .mockResolvedValue([
          { producerId: 'producer-video', userId: 'user-a', kind: 'video' },
        ]),
      pauseProducer: jest.fn().mockResolvedValue(undefined),
      resumeProducer: jest.fn().mockResolvedValue(undefined),
    };
    const sessionRepository = {
      findByCallId: jest.fn().mockResolvedValue(videoSession),
    };
    const roomEmitter = { emit: jest.fn() };
    const client = createSocket({
      id: 'socket-video',
      userId: 'user-a',
      callIds: ['call-1'],
      emit: jest.fn(),
    });
    const gateway = createGateway({ mediaEngine, sessionRepository });
    gateway.server = {
      to: jest.fn().mockReturnValue(roomEmitter),
    } as never;

    await Promise.all([
      gateway.handleSetVideoEnabled(
        {
          callId: 'call-1',
          producerId: 'producer-video',
          enabled: false,
          revision: 2,
          actionId: 'camera-action-2',
          requestId: 'camera-action-2',
        },
        client,
      ),
      gateway.handleSetVideoEnabled(
        {
          callId: 'call-1',
          producerId: 'producer-video',
          enabled: true,
          revision: 1,
          actionId: 'camera-action-1',
          requestId: 'camera-action-1',
        },
        client,
      ),
    ]);

    expect(mediaEngine.pauseProducer).toHaveBeenCalledTimes(1);
    expect(mediaEngine.resumeProducer).not.toHaveBeenCalled();
    expect(roomEmitter.emit).toHaveBeenCalledWith('video_state_changed', {
      callId: 'call-1',
      userId: 'user-a',
      producerId: 'producer-video',
      enabled: false,
      revision: 2,
      actionId: 'camera-action-2',
    });
    expect(client.emit).toHaveBeenCalledWith(
      'video_state_updated',
      expect.objectContaining({
        callId: 'call-1',
        producerId: 'producer-video',
        enabled: false,
        revision: 2,
        status: 'applied',
        requestId: 'camera-action-2',
      }),
    );
    expect(client.emit).toHaveBeenCalledWith(
      'video_state_updated',
      expect.objectContaining({
        callId: 'call-1',
        producerId: 'producer-video',
        enabled: false,
        revision: 2,
        status: 'stale',
        requestId: 'camera-action-1',
      }),
    );

    await gateway.handleSetVideoEnabled(
      {
        callId: 'call-1',
        producerId: 'producer-video',
        enabled: false,
        revision: 2,
        actionId: 'camera-action-2',
        requestId: 'camera-action-2',
      },
      client,
    );

    expect(mediaEngine.pauseProducer).toHaveBeenCalledTimes(1);
    expect(client.emit).toHaveBeenCalledWith(
      'video_state_updated',
      expect.objectContaining({
        revision: 2,
        status: 'already_applied',
        requestId: 'camera-action-2',
      }),
    );
  });

  it('keeps legacy camera payloads functional while assigning a revision', async () => {
    const videoSession = new CallSession({
      ...activeSession,
      callType: 'VIDEO',
    });
    const mediaEngine = {
      listActiveProducers: jest
        .fn()
        .mockResolvedValue([
          { producerId: 'producer-video', userId: 'user-a', kind: 'video' },
        ]),
      pauseProducer: jest.fn().mockResolvedValue(undefined),
      resumeProducer: jest.fn().mockResolvedValue(undefined),
    };
    const sessionRepository = {
      findByCallId: jest.fn().mockResolvedValue(videoSession),
    };
    const roomEmitter = { emit: jest.fn() };
    const client = createSocket({
      id: 'socket-video-legacy',
      userId: 'user-a',
      callIds: ['call-1'],
      emit: jest.fn(),
    });
    const gateway = createGateway({ mediaEngine, sessionRepository });
    gateway.server = {
      to: jest.fn().mockReturnValue(roomEmitter),
    } as never;

    await gateway.handleSetVideoEnabled(
      {
        callId: 'call-1',
        producerId: 'producer-video',
        enabled: false,
      },
      client,
    );

    expect(mediaEngine.pauseProducer).toHaveBeenCalledTimes(1);
    expect(client.emit).toHaveBeenCalledWith(
      'video_state_updated',
      expect.objectContaining({
        enabled: false,
        revision: 1,
        status: 'applied',
      }),
    );
    expect(roomEmitter.emit).toHaveBeenCalledWith('video_state_changed', {
      callId: 'call-1',
      userId: 'user-a',
      producerId: 'producer-video',
      enabled: false,
      revision: 1,
    });
  });

  it('acknowledges explicit producer cleanup and notifies peers without leaking stale video state', async () => {
    const videoSession = new CallSession({
      ...activeSession,
      callType: 'VIDEO',
    });
    const mediaEngine = {
      listActiveProducers: jest
        .fn()
        .mockResolvedValueOnce([
          { producerId: 'producer-video', userId: 'user-a', kind: 'video' },
        ])
        .mockResolvedValueOnce([]),
      closeProducer: jest
        .fn()
        .mockResolvedValueOnce({ closed: true, kind: 'video' })
        .mockResolvedValueOnce({ closed: false }),
    };
    const sessionRepository = {
      findByCallId: jest.fn().mockResolvedValue(videoSession),
    };
    const roomEmitter = { emit: jest.fn() };
    const client = createSocket({
      id: 'socket-video-close',
      userId: 'user-a',
      callIds: ['call-1'],
      emit: jest.fn(),
    });
    const gateway = createGateway({ mediaEngine, sessionRepository });
    gateway.server = {
      to: jest.fn().mockReturnValue(roomEmitter),
    } as never;

    await gateway.handleCloseProducer(
      {
        callId: 'call-1',
        producerId: 'producer-video',
        kind: 'video',
        requestId: 'close-video-1',
      },
      client,
    );
    await gateway.handleCloseProducer(
      {
        callId: 'call-1',
        producerId: 'producer-video',
        kind: 'video',
        requestId: 'close-video-1',
      },
      client,
    );

    expect(mediaEngine.closeProducer).toHaveBeenCalledWith(
      'call-1',
      'user-a',
      'producer-video',
    );
    expect(roomEmitter.emit).toHaveBeenCalledWith('producer_closed', {
      callId: 'call-1',
      producerId: 'producer-video',
      kind: 'video',
    });
    expect(client.emit).toHaveBeenNthCalledWith(1, 'producer_closed_ack', {
      callId: 'call-1',
      producerId: 'producer-video',
      kind: 'video',
      status: 'closed',
      requestId: 'close-video-1',
    });
    expect(client.emit).toHaveBeenNthCalledWith(2, 'producer_closed_ack', {
      callId: 'call-1',
      producerId: 'producer-video',
      kind: 'video',
      status: 'already_closed',
      requestId: 'close-video-1',
    });
  });

  it('echoes the consume request id so retries cannot accept a stale consumer response', async () => {
    const consumeUseCase = {
      execute: jest.fn().mockResolvedValue({
        consumerId: 'consumer-2',
        producerId: 'producer-audio',
        kind: 'audio',
        rtpParameters: { codecs: [] },
      }),
    };
    const client = createSocket({
      id: 'socket-consume-correlation',
      userId: 'user-b',
      callIds: ['call-1'],
      emit: jest.fn(),
    });
    const gateway = createGateway({ consumeUseCase });

    await gateway.handleConsume(
      {
        callId: 'call-1',
        transportId: 'recv-1',
        producerId: 'producer-audio',
        rtpCapabilities: { codecs: [] },
        requestId: 'consume-retry-2',
      },
      client,
    );

    expect(client.emit).toHaveBeenCalledWith('consumer_created', {
      callId: 'call-1',
      consumerId: 'consumer-2',
      producerId: 'producer-audio',
      kind: 'audio',
      rtpParameters: { codecs: [] },
      requestId: 'consume-retry-2',
    });
  });

  it('acknowledges consumer cleanup idempotently without notifying the peer', async () => {
    const mediaEngine = {
      closeConsumer: jest
        .fn()
        .mockResolvedValueOnce({ closed: true })
        .mockResolvedValueOnce({ closed: false }),
    };
    const sessionRepository = {
      findByCallId: jest.fn().mockResolvedValue(activeSession),
    };
    const client = createSocket({
      id: 'socket-consumer-close',
      userId: 'user-b',
      callIds: ['call-1'],
      emit: jest.fn(),
    });
    const gateway = createGateway({ mediaEngine, sessionRepository });

    await gateway.handleCloseConsumer(
      {
        callId: 'call-1',
        consumerId: 'consumer-1',
        requestId: 'close-consumer-1',
      },
      client,
    );
    await gateway.handleCloseConsumer(
      {
        callId: 'call-1',
        consumerId: 'consumer-1',
        requestId: 'close-consumer-1',
      },
      client,
    );

    expect(mediaEngine.closeConsumer).toHaveBeenCalledTimes(2);
    expect(mediaEngine.closeConsumer).toHaveBeenCalledWith(
      'call-1',
      'user-b',
      'consumer-1',
    );
    expect(client.emit).toHaveBeenNthCalledWith(1, 'consumer_closed_ack', {
      callId: 'call-1',
      consumerId: 'consumer-1',
      status: 'closed',
      requestId: 'close-consumer-1',
    });
    expect(client.emit).toHaveBeenNthCalledWith(2, 'consumer_closed_ack', {
      callId: 'call-1',
      consumerId: 'consumer-1',
      status: 'already_closed',
      requestId: 'close-consumer-1',
    });
  });

  it('allows a later group guest to close their own consumer', async () => {
    const session = new CallSession({
      ...activeSession,
      isGroupCall: true,
      invitedUserIds: ['user-a', 'user-b', 'user-c'],
      participantIds: ['user-a', 'user-b', 'user-c'],
    });
    const mediaEngine = {
      closeConsumer: jest.fn().mockResolvedValue({ closed: true }),
    };
    const gateway = createGateway({
      mediaEngine,
      sessionRepository: { findByCallId: jest.fn().mockResolvedValue(session) },
    });
    const client = createSocket({
      id: 'socket-c',
      userId: 'user-c',
      callIds: ['call-1'],
    });

    await gateway.handleCloseConsumer(
      { callId: 'call-1', consumerId: 'consumer-c' },
      client,
    );

    expect(mediaEngine.closeConsumer).toHaveBeenCalledWith(
      'call-1',
      'user-c',
      'consumer-c',
    );
    expect(client.emit).toHaveBeenCalledWith('consumer_closed_ack', {
      callId: 'call-1',
      consumerId: 'consumer-c',
      status: 'closed',
    });
  });

  it('replays the authoritative camera state when a produce retry reuses a producer', async () => {
    const videoSession = new CallSession({
      ...activeSession,
      callType: 'VIDEO',
    });
    const mediaEngine = {
      listActiveProducers: jest
        .fn()
        .mockResolvedValue([
          { producerId: 'producer-video', userId: 'user-a', kind: 'video' },
        ]),
      pauseProducer: jest.fn().mockResolvedValue(undefined),
      resumeProducer: jest.fn().mockResolvedValue(undefined),
    };
    const sessionRepository = {
      findByCallId: jest.fn().mockResolvedValue(videoSession),
    };
    const produceUseCase = {
      execute: jest.fn().mockResolvedValue({ producerId: 'producer-video' }),
    };
    const peerEmitter = { emit: jest.fn() };
    const client = createSocket({
      id: 'socket-video-retry',
      userId: 'user-a',
      callIds: ['call-1'],
      emit: jest.fn(),
      to: jest.fn().mockReturnValue(peerEmitter),
    });
    const gateway = createGateway({
      mediaEngine,
      sessionRepository,
      produceUseCase,
    });
    gateway.server = {
      to: jest.fn().mockReturnValue(peerEmitter),
    } as never;

    await gateway.handleSetVideoEnabled(
      {
        callId: 'call-1',
        producerId: 'producer-video',
        enabled: false,
        revision: 1,
        actionId: 'camera-off',
        requestId: 'camera-off',
      },
      client,
    );

    await gateway.handleProduce(
      {
        callId: 'call-1',
        transportId: 'transport-1',
        kind: 'video',
        rtpParameters: {},
        requestId: 'produce-retry',
      },
      client,
    );

    expect(peerEmitter.emit).toHaveBeenCalledWith('new_producer', {
      callId: 'call-1',
      userId: 'user-a',
      producerId: 'producer-video',
      kind: 'video',
      paused: true,
      revision: 1,
    });
  });

  it('carries the authoritative camera state across a controlled producer replacement', async () => {
    const videoSession = new CallSession({
      ...activeSession,
      callType: 'VIDEO',
    });
    const mediaEngine = {
      listActiveProducers: jest
        .fn()
        .mockResolvedValue([
          { producerId: 'producer-old', userId: 'user-a', kind: 'video' },
        ]),
      pauseProducer: jest.fn().mockResolvedValue(undefined),
      resumeProducer: jest.fn().mockResolvedValue(undefined),
    };
    const sessionRepository = {
      findByCallId: jest.fn().mockResolvedValue(videoSession),
    };
    const produceUseCase = {
      execute: jest.fn().mockResolvedValue({
        producerId: 'producer-new',
        replacedProducerId: 'producer-old',
      }),
    };
    const peerEmitter = { emit: jest.fn() };
    const client = createSocket({
      id: 'socket-video-rebuild',
      userId: 'user-a',
      callIds: ['call-1'],
      emit: jest.fn(),
      to: jest.fn().mockReturnValue(peerEmitter),
    });
    const gateway = createGateway({
      mediaEngine,
      sessionRepository,
      produceUseCase,
    });
    gateway.server = {
      to: jest.fn().mockReturnValue(peerEmitter),
    } as never;

    await gateway.handleSetVideoEnabled(
      {
        callId: 'call-1',
        producerId: 'producer-old',
        enabled: false,
        revision: 4,
        actionId: 'camera-off',
        requestId: 'camera-off',
      },
      client,
    );

    await gateway.handleProduce(
      {
        callId: 'call-1',
        transportId: 'transport-new',
        kind: 'video',
        rtpParameters: {},
        requestId: 'produce-rebuild',
      },
      client,
    );

    expect(peerEmitter.emit).toHaveBeenCalledWith('producer_closed', {
      callId: 'call-1',
      producerId: 'producer-old',
      kind: 'video',
    });
    expect(peerEmitter.emit).toHaveBeenCalledWith('new_producer', {
      callId: 'call-1',
      userId: 'user-a',
      producerId: 'producer-new',
      kind: 'video',
      paused: true,
      revision: 4,
    });
  });

  it('does not publish a camera update when the call terminates during media mutation', async () => {
    const videoSession = new CallSession({
      ...activeSession,
      callType: 'VIDEO',
    });
    const terminalSession = new CallSession({
      ...videoSession,
      status: 'ended',
      terminalReason: 'hangup',
    });
    let releasePause!: () => void;
    const mediaEngine = {
      listActiveProducers: jest
        .fn()
        .mockResolvedValue([
          { producerId: 'producer-video', userId: 'user-a', kind: 'video' },
        ]),
      pauseProducer: jest.fn(
        () =>
          new Promise<void>((resolve) => {
            releasePause = resolve;
          }),
      ),
      resumeProducer: jest.fn().mockResolvedValue(undefined),
    };
    const sessionRepository = {
      findByCallId: jest
        .fn()
        .mockResolvedValueOnce(videoSession)
        .mockResolvedValueOnce(terminalSession),
    };
    const roomEmitter = { emit: jest.fn() };
    const client = createSocket({
      id: 'socket-video-terminal-race',
      userId: 'user-a',
      callIds: ['call-1'],
      emit: jest.fn(),
    });
    const gateway = createGateway({ mediaEngine, sessionRepository });
    gateway.server = {
      to: jest.fn().mockReturnValue(roomEmitter),
    } as never;

    const operation = gateway.handleSetVideoEnabled(
      {
        callId: 'call-1',
        producerId: 'producer-video',
        enabled: false,
        revision: 1,
        actionId: 'camera-terminal-race',
        requestId: 'camera-terminal-race',
      },
      client,
    );
    for (let attempt = 0; attempt < 10 && !releasePause; attempt += 1) {
      await Promise.resolve();
    }
    expect(releasePause).toEqual(expect.any(Function));
    releasePause();

    await expect(operation).rejects.toThrow('Video state cannot be changed');
    expect(roomEmitter.emit).not.toHaveBeenCalledWith(
      'video_state_changed',
      expect.anything(),
    );
    expect(client.emit).not.toHaveBeenCalledWith(
      'video_state_updated',
      expect.anything(),
    );
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
    )?.[1] as { expiresAt?: string } | undefined;
    expect(incomingPayload).toEqual(
      expect.objectContaining({ ringTimeoutMs: 1250 }),
    );
    expect(Date.parse(incomingPayload?.expiresAt ?? '')).not.toBeNaN();
    gateway.onModuleDestroy();
  });

  it('sends a group rejection only to the declining account room', async () => {
    const rejectCallUseCase = {
      execute: jest.fn().mockResolvedValue({
        isGroupInvitation: true,
        didTransition: true,
        reason: 'rejected',
      }),
    };
    const recipientEmitter = { emit: jest.fn() };
    const gateway = createGateway({ rejectCallUseCase });
    gateway.server = {
      to: jest.fn().mockReturnValue(recipientEmitter),
    } as never;

    await gateway.handleRejectCall(
      { callId: 'group-room' },
      createSocket({ id: 'socket-guest', userId: 'guest', callIds: [] }),
    );

    expect(gateway.server.to).toHaveBeenCalledWith('group-lifecycle-v2:guest');
    expect(gateway.server.to).toHaveBeenCalledTimes(1);
    expect(recipientEmitter.emit).toHaveBeenCalledWith('call_rejected', {
      callId: 'group-room',
      userId: 'guest',
      reason: 'rejected',
    });
  });

  it('confirms a group answer before acknowledging it or notifying other devices', async () => {
    const groupSession = new CallSession({
      ...activeSession,
      isGroupCall: true,
      invitedUserIds: ['user-a', 'user-b', 'user-c'],
    });
    const joinCallUseCase = {
      execute: jest.fn().mockResolvedValue({
        role: 'guest',
        session: groupSession,
        rtpCapabilities: { codecs: [], headerExtensions: [] },
        shouldEmitNewPeer: true,
      }),
    };
    const sessionRepository = {
      findByCallId: jest.fn().mockResolvedValue(groupSession),
      confirmGroupInvitationJoin: jest.fn().mockResolvedValue(true),
      abortGroupInvitationJoin: jest.fn(),
    };
    const roomEmitter = { emit: jest.fn() };
    const otherDevicesEmitter = { emit: jest.fn() };
    const gateway = createGateway({ joinCallUseCase, sessionRepository });
    gateway.server = { to: jest.fn().mockReturnValue(roomEmitter) } as never;
    const socket = createSocket({
      id: 'socket-b',
      userId: 'user-b',
      callIds: [],
      to: jest.fn().mockReturnValue(otherDevicesEmitter),
    });

    await gateway.handleAcceptIncomingCall(
      { callId: 'call-1', actionId: 'winning-action' },
      socket,
    );

    expect(sessionRepository.confirmGroupInvitationJoin).toHaveBeenCalledWith(
      'call-1',
      'user-b',
      'winning-action',
      expect.any(Date),
    );
    expect(
      sessionRepository.confirmGroupInvitationJoin.mock.invocationCallOrder[0],
    ).toBeLessThan((socket.emit as jest.Mock).mock.invocationCallOrder[0]);
    expect(socket.emit).toHaveBeenCalledWith(
      'incoming_call_acceptance',
      expect.objectContaining({ outcome: 'accepted' }),
    );
    expect(socket.to).toHaveBeenCalledWith('group-lifecycle-v2:user-b');
    expect(otherDevicesEmitter.emit).toHaveBeenCalledWith('call_answered', {
      callId: 'call-1',
      userId: 'user-b',
      answeredElsewhere: true,
    });
    expect(gateway.server.to).not.toHaveBeenCalledWith('user-b');
    expect(sessionRepository.abortGroupInvitationJoin).not.toHaveBeenCalled();
  });

  it('aborts a provisional group answer when post-join media lookup fails', async () => {
    const groupSession = new CallSession({
      ...activeSession,
      isGroupCall: true,
      invitedUserIds: ['user-a', 'user-b'],
    });
    const joinCallUseCase = {
      execute: jest.fn().mockResolvedValue({
        role: 'guest',
        session: groupSession,
        rtpCapabilities: { codecs: [], headerExtensions: [] },
        shouldEmitNewPeer: true,
      }),
    };
    const sessionRepository = {
      findByCallId: jest.fn().mockResolvedValue(groupSession),
      confirmGroupInvitationJoin: jest.fn(),
      abortGroupInvitationJoin: jest.fn().mockResolvedValue(true),
    };
    const stateRepository = {
      getParticipant: jest.fn(),
      upsertParticipant: jest.fn(),
      removeParticipant: jest.fn(),
    };
    const gateway = createGateway({
      joinCallUseCase,
      sessionRepository,
      stateRepository,
      mediaEngine: {
        listActiveProducers: jest
          .fn()
          .mockRejectedValue(new Error('room unavailable')),
      },
    });
    const roomEmitter = { emit: jest.fn() };
    gateway.server = { to: jest.fn().mockReturnValue(roomEmitter) } as never;
    const socket = createSocket({
      id: 'socket-b',
      userId: 'user-b',
      callIds: [],
    });

    await gateway.handleAcceptIncomingCall(
      { callId: 'call-1', actionId: 'winning-action' },
      socket,
    );

    expect(sessionRepository.confirmGroupInvitationJoin).not.toHaveBeenCalled();
    expect(sessionRepository.abortGroupInvitationJoin).toHaveBeenCalledWith(
      'call-1',
      'user-b',
      'winning-action',
      expect.any(Date),
    );
    expect(stateRepository.removeParticipant).toHaveBeenCalledWith(
      'call-1',
      'user-b',
    );
    expect(socket.leave).toHaveBeenCalledWith('call-1');
    expect(roomEmitter.emit).toHaveBeenCalledWith('peer_left', {
      callId: 'call-1',
      userId: 'user-b',
      reason: 'media_unavailable',
    });
    expect(socket.emit).toHaveBeenCalledWith(
      'incoming_call_acceptance',
      expect.objectContaining({
        outcome: 'media_unavailable',
        reservationReleased: true,
      }),
    );
  });

  it('releases a group answer even when media fails before join returns', async () => {
    const groupSession = new CallSession({
      ...activeSession,
      isGroupCall: true,
      invitedUserIds: ['user-a', 'user-b'],
    });
    const sessionRepository = {
      findByCallId: jest.fn().mockResolvedValue(groupSession),
      confirmGroupInvitationJoin: jest.fn(),
      abortGroupInvitationJoin: jest.fn().mockResolvedValue(true),
    };
    const stateRepository = {
      getParticipant: jest.fn(),
      upsertParticipant: jest.fn(),
      removeParticipant: jest.fn(),
    };
    const gateway = createGateway({
      joinCallUseCase: {
        execute: jest
          .fn()
          .mockRejectedValue(new GroupJoinMediaUnavailableError()),
      },
      sessionRepository,
      stateRepository,
    });
    const roomEmitter = { emit: jest.fn() };
    gateway.server = { to: jest.fn().mockReturnValue(roomEmitter) } as never;
    const socket = createSocket({
      id: 'socket-b',
      userId: 'user-b',
      callIds: [],
    });

    await gateway.handleAcceptIncomingCall(
      { callId: 'call-1', actionId: 'failed-action' },
      socket,
    );

    expect(sessionRepository.abortGroupInvitationJoin).toHaveBeenCalledWith(
      'call-1',
      'user-b',
      'failed-action',
      expect.any(Date),
    );
    expect(stateRepository.removeParticipant).toHaveBeenCalledWith(
      'call-1',
      'user-b',
    );
    expect(socket.leave).toHaveBeenCalledWith('call-1');
    expect(roomEmitter.emit).toHaveBeenCalledWith('peer_left', {
      callId: 'call-1',
      userId: 'user-b',
      reason: 'media_unavailable',
    });
    expect(socket.emit).toHaveBeenCalledWith(
      'incoming_call_acceptance',
      expect.objectContaining({
        outcome: 'media_unavailable',
        reservationReleased: true,
      }),
    );
  });

  it('keeps a group invitation retryable when the membership RPC is unavailable', async () => {
    const groupSession = new CallSession({
      ...activeSession,
      isGroupCall: true,
      invitedUserIds: ['user-a', 'user-b'],
    });
    const sessionRepository = {
      findByCallId: jest.fn().mockResolvedValue(groupSession),
      abortGroupInvitationJoin: jest.fn().mockResolvedValue(false),
    };
    const gateway = createGateway({
      joinCallUseCase: {
        execute: jest
          .fn()
          .mockRejectedValue(
            new ServiceUnavailableException('Group membership unavailable'),
          ),
      },
      sessionRepository,
    });
    const socket = createSocket({ id: 'socket-b', userId: 'user-b' });

    await gateway.handleAcceptIncomingCall(
      { callId: 'call-1', actionId: 'retry-action' },
      socket,
    );

    expect(socket.emit).toHaveBeenCalledWith('incoming_call_acceptance', {
      callId: 'call-1',
      outcome: 'media_unavailable',
      retryable: true,
    });
    expect(sessionRepository.abortGroupInvitationJoin).toHaveBeenCalled();
  });

  it('requires the confirmed winning action for group rejoin', async () => {
    const groupSession = new CallSession({
      ...activeSession,
      isGroupCall: true,
      groupConfirmedAnswerActionIds: { 'user-b': 'winning-action' },
    });
    const joinCallUseCase = {
      execute: jest.fn().mockResolvedValue({
        role: 'guest',
        session: groupSession,
        rtpCapabilities: { codecs: [], headerExtensions: [] },
      }),
    };
    const participant = new CallParticipant({
      userId: 'user-b',
      callId: 'call-1',
      role: 'guest',
      socketId: 'socket-old',
      isConnected: true,
    });
    const gateway = createGateway({
      joinCallUseCase,
      sessionRepository: {
        findByCallId: jest.fn().mockResolvedValue(groupSession),
      },
      stateRepository: {
        getParticipant: jest.fn().mockResolvedValue(participant),
        upsertParticipant: jest.fn(),
        removeParticipant: jest.fn(),
      },
    });
    const socket = createSocket({
      id: 'socket-new',
      userId: 'user-b',
      callIds: [],
    });

    await expect(
      gateway.handleRejoinCall({ callId: 'call-1' }, socket),
    ).rejects.toThrow('did not answer');
    await expect(
      gateway.handleRejoinCall(
        { callId: 'call-1', actionId: 'other-action' },
        socket,
      ),
    ).rejects.toThrow('did not answer');
    await gateway.handleRejoinCall(
      { callId: 'call-1', actionId: 'winning-action' },
      socket,
    );
    expect(joinCallUseCase.execute).toHaveBeenCalledWith(
      'call-1',
      'user-b',
      'socket-new',
      'winning-action',
    );
  });

  it('leaves the Socket.IO room after a participant leaves the group', async () => {
    const leaveCallUseCase = {
      execute: jest.fn().mockResolvedValue({
        session: activeSession,
        endedReason: 'left',
        shouldEmitPeerLeft: true,
        didTransition: false,
        closedProducers: [],
      }),
    };
    const gateway = createGateway({ leaveCallUseCase });
    const evict = { socketsLeave: jest.fn() };
    gateway.server = {
      to: jest.fn().mockReturnValue({ emit: jest.fn() }),
      in: jest.fn().mockReturnValue(evict),
    } as never;
    const socket = createSocket({
      id: 'socket-b',
      userId: 'user-b',
      callIds: ['call-1'],
    });

    await gateway.handleLeaveCall({ callId: 'call-1' }, socket);

    expect(socket.data.callIds).toEqual([]);
    expect(gateway.server.in).toHaveBeenCalledWith('user-b');
    expect(evict.socketsLeave).toHaveBeenCalledWith('call-1');
  });

  it('prevents a losing group device from ending the winning device call', async () => {
    const groupSession = new CallSession({
      ...activeSession,
      isGroupCall: true,
      groupConfirmedAnswerActionIds: { 'user-b': 'winning-action' },
    });
    const leaveCallUseCase = {
      execute: jest.fn().mockResolvedValue({
        session: groupSession,
        endedReason: 'left',
        shouldEmitPeerLeft: true,
        didTransition: false,
        closedProducers: [],
      }),
    };
    const gateway = createGateway({
      leaveCallUseCase,
      sessionRepository: {
        findByCallId: jest.fn().mockResolvedValue(groupSession),
      },
    });
    gateway.server = {
      to: jest.fn().mockReturnValue({ emit: jest.fn() }),
      in: jest.fn().mockReturnValue({ socketsLeave: jest.fn() }),
    } as never;
    const losingDevice = createSocket({
      id: 'socket-loser',
      userId: 'user-b',
      callIds: [],
    });

    await expect(
      gateway.handleLeaveCall(
        {
          callId: 'call-1',
          reason: 'media_unavailable',
          actionId: 'losing-action',
        },
        losingDevice,
      ),
    ).rejects.toThrow('This device did not answer the group call');
    expect(leaveCallUseCase.execute).not.toHaveBeenCalled();

    const winningDevice = createSocket({
      id: 'socket-winner',
      userId: 'user-b',
      callIds: ['call-1'],
    });
    await gateway.handleLeaveCall({ callId: 'call-1' }, winningDevice);
    expect(leaveCallUseCase.execute).toHaveBeenCalledTimes(1);

    const spoofingDevice = createSocket({
      id: 'socket-loser-spoofing-winner',
      userId: 'user-b',
      callIds: [],
    });
    await expect(
      gateway.handleLeaveCall(
        { callId: 'call-1', actionId: 'winning-action' },
        spoofingDevice,
      ),
    ).rejects.toThrow('This device did not answer the group call');
    expect(leaveCallUseCase.execute).toHaveBeenCalledTimes(1);
  });

  it('does not create group media for a second device that never joined the call', async () => {
    const createTransportUseCase = {
      execute: jest.fn().mockResolvedValue({ transportId: 'transport-b' }),
    };
    const gateway = createGateway({ createTransportUseCase });
    const payload = { callId: 'call-1', direction: 'send' as const };
    const otherDevice = createSocket({
      id: 'socket-loser',
      userId: 'user-b',
      callIds: [],
    });

    await expect(
      gateway.handleCreateTransport(payload, otherDevice),
    ).rejects.toThrow('Join the call before using media');
    expect(createTransportUseCase.execute).not.toHaveBeenCalled();

    const winningDevice = createSocket({
      id: 'socket-winner',
      userId: 'user-b',
      callIds: ['call-1'],
    });
    await gateway.handleCreateTransport(payload, winningDevice);
    expect(createTransportUseCase.execute).toHaveBeenCalledWith(
      'call-1',
      'user-b',
      'send',
    );
    expect(winningDevice.emit).toHaveBeenCalledWith('transport_created', {
      callId: 'call-1',
      transportId: 'transport-b',
    });

    // A server-side room eviction may leave an old tracked id on another socket.
    winningDevice.rooms.delete('call-1');
    await expect(
      gateway.handleCreateTransport(payload, winningDevice),
    ).rejects.toThrow('Join the call before using media');
  });

  it('rejects live media commands from a second device that never joined', async () => {
    const connectTransportUseCase = { execute: jest.fn() };
    const produceUseCase = { execute: jest.fn() };
    const consumeUseCase = { execute: jest.fn() };
    const resumeConsumerUseCase = { execute: jest.fn() };
    const restartIceUseCase = { execute: jest.fn() };
    const mediaEngine = {
      listActiveProducers: jest.fn(),
      setConsumerMaxBitrate: jest.fn(),
      closeProducer: jest.fn(),
      closeConsumer: jest.fn(),
    };
    const gateway = createGateway({
      connectTransportUseCase,
      produceUseCase,
      consumeUseCase,
      resumeConsumerUseCase,
      restartIceUseCase,
      mediaEngine,
      sessionRepository: {
        findByCallId: jest.fn().mockResolvedValue(activeSession),
      },
    });
    const otherDevice = createSocket({
      id: 'socket-loser',
      userId: 'user-b',
      callIds: [],
    });
    const callId = 'call-1';
    const transportId = 'winning-device-transport';

    for (const operation of [
      () =>
        gateway.handleConnectTransport(
          { callId, transportId, dtlsParameters: {} },
          otherDevice,
        ),
      () =>
        gateway.handleProduce(
          { callId, transportId, kind: 'audio', rtpParameters: {} },
          otherDevice,
        ),
      () =>
        gateway.handleConsume(
          {
            callId,
            transportId,
            producerId: 'producer-1',
            rtpCapabilities: {},
          },
          otherDevice,
        ),
      () =>
        gateway.handleResumeConsumer(
          { callId, consumerId: 'consumer-1' },
          otherDevice,
        ),
      () => gateway.handleRestartIce({ callId, transportId }, otherDevice),
      () =>
        gateway.handleSetAudioBitrate(
          { callId, transportId, profile: 'normal' },
          otherDevice,
        ),
      () =>
        gateway.handleCloseProducer(
          { callId, producerId: 'producer-1', kind: 'audio' },
          otherDevice,
        ),
      () =>
        gateway.handleCloseConsumer(
          { callId, consumerId: 'consumer-1' },
          otherDevice,
        ),
    ]) {
      await expect(operation()).rejects.toThrow(
        'Join the call before using media',
      );
    }
    expect(connectTransportUseCase.execute).not.toHaveBeenCalled();
    expect(produceUseCase.execute).not.toHaveBeenCalled();
    expect(consumeUseCase.execute).not.toHaveBeenCalled();
    expect(resumeConsumerUseCase.execute).not.toHaveBeenCalled();
    expect(restartIceUseCase.execute).not.toHaveBeenCalled();
    expect(mediaEngine.setConsumerMaxBitrate).not.toHaveBeenCalled();
    expect(mediaEngine.closeProducer).not.toHaveBeenCalled();
    expect(mediaEngine.closeConsumer).not.toHaveBeenCalled();
  });

  it('still acknowledges late cleanup after a call has ended', async () => {
    const session = new CallSession({ ...activeSession, status: 'ended' });
    const mediaEngine = {
      listActiveProducers: jest.fn(),
      closeProducer: jest.fn(),
      closeConsumer: jest.fn(),
    };
    const gateway = createGateway({
      mediaEngine,
      sessionRepository: { findByCallId: jest.fn().mockResolvedValue(session) },
    });
    const socket = createSocket({
      id: 'socket-after-end',
      userId: 'user-b',
      callIds: [],
    });

    await gateway.handleCloseProducer(
      { callId: 'call-1', producerId: 'old-producer', kind: 'audio' },
      socket,
    );
    await gateway.handleCloseConsumer(
      { callId: 'call-1', consumerId: 'old-consumer' },
      socket,
    );

    expect(socket.emit).toHaveBeenCalledWith(
      'producer_closed_ack',
      expect.objectContaining({ status: 'already_closed' }),
    );
    expect(socket.emit).toHaveBeenCalledWith(
      'consumer_closed_ack',
      expect.objectContaining({ status: 'already_closed' }),
    );
    expect(mediaEngine.closeProducer).not.toHaveBeenCalled();
    expect(mediaEngine.closeConsumer).not.toHaveBeenCalled();
  });
});

function createGateway(overrides?: {
  initiateCallUseCase?: { execute: jest.Mock };
  joinCallUseCase?: { execute: jest.Mock };
  createTransportUseCase?: { execute: jest.Mock };
  connectTransportUseCase?: { execute: jest.Mock };
  produceUseCase?: { execute: jest.Mock };
  consumeUseCase?: { execute: jest.Mock };
  resumeConsumerUseCase?: { execute: jest.Mock };
  restartIceUseCase?: { execute: jest.Mock };
  leaveCallUseCase?: { execute: jest.Mock };
  rejectCallUseCase?: { execute: jest.Mock };
  acceptIncomingCallUseCase?: { execute: jest.Mock };
  expireDueCallsUseCase?: { execute: jest.Mock };
  recoverActiveCallsAfterMediaRestartUseCase?: { execute: jest.Mock };
  runtimeLease?: { acquire: jest.Mock; assertHeld: jest.Mock };
  mediaEngine?: {
    listActiveProducers: jest.Mock;
    pauseProducer?: jest.Mock;
    resumeProducer?: jest.Mock;
    setConsumerMaxBitrate?: jest.Mock;
    closeProducer?: jest.Mock;
    closeConsumer?: jest.Mock;
  };
  sessionRepository?: {
    findByCallId: jest.Mock;
    confirmGroupInvitationJoin?: jest.Mock;
    abortGroupInvitationJoin?: jest.Mock;
  };
  stateRepository?: {
    getParticipant: jest.Mock;
    upsertParticipant: jest.Mock;
    removeParticipant: jest.Mock;
  };
  metrics?: {
    recordSocketDisconnect: jest.Mock;
    recordSocketReconnect: jest.Mock;
    recordCallEvent: jest.Mock;
  };
}) {
  return new CallGateway(
    (overrides?.initiateCallUseCase ?? { execute: jest.fn() }) as never,
    (overrides?.joinCallUseCase ?? { execute: jest.fn() }) as never,
    (overrides?.createTransportUseCase ?? { execute: jest.fn() }) as never,
    (overrides?.connectTransportUseCase ?? { execute: jest.fn() }) as never,
    (overrides?.produceUseCase ?? { execute: jest.fn() }) as never,
    (overrides?.consumeUseCase ?? { execute: jest.fn() }) as never,
    (overrides?.leaveCallUseCase ?? { execute: jest.fn() }) as never,
    (overrides?.rejectCallUseCase ?? { execute: jest.fn() }) as never,
    (overrides?.acceptIncomingCallUseCase ?? { execute: jest.fn() }) as never,
    (overrides?.expireDueCallsUseCase ?? {
      execute: jest.fn().mockResolvedValue([]),
    }) as never,
    (overrides?.recoverActiveCallsAfterMediaRestartUseCase ?? {
      execute: jest.fn().mockResolvedValue([]),
    }) as never,
    (overrides?.resumeConsumerUseCase ?? { execute: jest.fn() }) as never,
    (overrides?.restartIceUseCase ?? { execute: jest.fn() }) as never,
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
    (overrides?.metrics ?? {
      recordSocketDisconnect: jest.fn(),
      recordSocketReconnect: jest.fn(),
      recordCallEvent: jest.fn(),
    }) as never,
  );
}

function createSocket(input: {
  id: string;
  userId: string;
  callIds?: string[];
  emit?: jest.Mock;
  join?: jest.Mock;
  leave?: jest.Mock;
  once?: jest.Mock;
  to?: jest.Mock;
  disconnected?: boolean;
  groupLifecycleVersion?: number;
}) {
  const callIds = input.callIds ?? [];
  const rooms = new Set([input.userId, ...callIds]);
  return {
    id: input.id,
    rooms,
    data: {
      userId: input.userId,
      callIds,
    },
    handshake: {
      auth: { groupLifecycleVersion: input.groupLifecycleVersion ?? 2 },
    },
    emit: input.emit ?? jest.fn(),
    join:
      input.join ??
      jest.fn((room: string) => {
        rooms.add(room);
        return Promise.resolve();
      }),
    leave:
      input.leave ??
      jest.fn((room: string) => {
        rooms.delete(room);
        return Promise.resolve();
      }),
    once: input.once ?? jest.fn(),
    to: input.to ?? jest.fn().mockReturnValue({ emit: jest.fn() }),
    disconnected: input.disconnected ?? false,
  } as unknown as Socket;
}
