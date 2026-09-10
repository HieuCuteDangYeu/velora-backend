import { BadRequestException, ForbiddenException } from '@nestjs/common';
import { of, throwError } from 'rxjs';
import { AnswerCallUseCase } from '../../../src/application/use-cases/answer-call.use-case';
import { AcceptIncomingCallUseCase } from '../../../src/application/use-cases/accept-incoming-call.use-case';
import { CreateTransportUseCase } from '../../../src/application/use-cases/create-transport.use-case';
import { ExpireDueCallsUseCase } from '../../../src/application/use-cases/expire-due-calls.use-case';
import { InitiateCallUseCase } from '../../../src/application/use-cases/initiate-call.use-case';
import { JoinCallUseCase } from '../../../src/application/use-cases/join-call.use-case';
import { LeaveCallUseCase } from '../../../src/application/use-cases/leave-call.use-case';
import { CallParticipant } from '../../../src/domain/entities/call-participant.entity';
import { CallSession } from '../../../src/domain/entities/call-session.entity';

describe('Call lifecycle use cases', () => {
  const baseSession = new CallSession({
    callId: 'call-1',
    conversationId: 'conv-1',
    initiatorId: 'user-a',
    targetUserId: 'user-b',
    callType: 'VIDEO',
    status: 'initiated',
    participantIds: ['user-a'],
    initiatorDisplayName: 'Ada',
    initiatorAvatarUrl: 'https://cdn.example/ada.png',
    ringTimeoutMs: 30000,
    expiresAt: new Date('2026-01-01T00:00:30.000Z'),
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
    updatedAt: new Date('2026-01-01T00:00:00.000Z'),
  });

  it('creates a new initiated session and publishes call.initiated', async () => {
    const sessionRepository = {
      save: jest.fn((session: CallSession) => Promise.resolve(session)),
    };
    const stateRepository = {
      getParticipant: jest.fn().mockResolvedValue(null),
      upsertParticipant: jest.fn(),
    };
    const eventPublisher = {
      publish: jest.fn(),
    };
    const mediaEngine = {
      createRoom: jest.fn(),
      getRouterRtpCapabilities: jest.fn().mockResolvedValue({
        codecs: [],
        headerExtensions: [],
      }),
    };
    const conversationClient = {
      send: jest.fn().mockReturnValue(
        of({
          id: 'conv-1',
          participantIds: ['user-a', 'user-b'],
          participants: [
            {
              id: 'user-a',
              name: 'Ada',
              avatar: 'https://cdn.example/ada.png',
            },
            {
              id: 'user-b',
              name: 'Grace',
            },
          ],
          isGroup: false,
        }),
      ),
    };

    const useCase = new InitiateCallUseCase(
      sessionRepository as never,
      stateRepository as never,
      eventPublisher,
      mediaEngine as never,
      conversationClient as never,
    );

    const result = await useCase.execute(
      'conv-1',
      'user-a',
      'user-b',
      'VIDEO',
      'socket-1',
    );

    expect(mediaEngine.createRoom).toHaveBeenCalledWith(result.session.callId);
    expect(sessionRepository.save).toHaveBeenCalledWith(
      expect.objectContaining({
        conversationId: 'conv-1',
        initiatorId: 'user-a',
        targetUserId: 'user-b',
        initiatorDisplayName: 'Ada',
        initiatorAvatarUrl: 'https://cdn.example/ada.png',
        ringTimeoutMs: 30000,
        status: 'initiated',
      }),
    );
    expect(eventPublisher.publish).toHaveBeenCalledWith(
      'call.initiated',
      expect.objectContaining({
        callId: result.session.callId,
        conversationId: 'conv-1',
        initiatorId: 'user-a',
        targetUserId: 'user-b',
        recipientUserId: 'user-b',
        initiatorDisplayName: 'Ada',
        initiatorAvatarUrl: 'https://cdn.example/ada.png',
        ringTimeoutMs: 30000,
        expiresAt: expect.any(String),
        userId: 'user-a',
        callType: 'VIDEO',
      }),
    );
    expect(result.role).toBe('host');
  });

  it('terminalizes an unpublished call without deleting its late-action tombstone', async () => {
    const sessionRepository = {
      save: jest.fn((session: CallSession) => Promise.resolve(session)),
      transitionToTerminal: jest.fn().mockResolvedValue({
        outcome: 'transitioned',
      }),
    };
    const stateRepository = {
      upsertParticipant: jest.fn(),
      clearCallState: jest.fn(),
    };
    const eventPublisher = {
      publish: jest.fn().mockRejectedValue(new Error('RabbitMQ unavailable')),
    };
    const mediaEngine = {
      createRoom: jest.fn(),
      closeRoom: jest.fn(),
      getRouterRtpCapabilities: jest.fn(),
    };
    const conversationClient = {
      send: jest.fn().mockReturnValue(
        of({
          id: 'conv-1',
          participantIds: ['user-a', 'user-b'],
          isGroup: false,
        }),
      ),
    };
    const useCase = new InitiateCallUseCase(
      sessionRepository as never,
      stateRepository as never,
      eventPublisher,
      mediaEngine as never,
      conversationClient as never,
    );

    await expect(
      useCase.execute('conv-1', 'user-a', 'user-b', 'VOICE', 'socket-1'),
    ).rejects.toThrow('RabbitMQ unavailable');

    const callId = sessionRepository.save.mock.calls[0][0].callId;
    expect(sessionRepository.transitionToTerminal).toHaveBeenCalledWith(
      callId,
      'user-a',
      'failed',
      expect.any(Date),
      'leave',
    );
    expect(mediaEngine.closeRoom).toHaveBeenCalledWith(callId);
    expect(stateRepository.clearCallState).toHaveBeenCalledWith(callId);
  });

  it('publishes the winning terminal revision when RTP setup fails after ringing was published', async () => {
    const endedAt = new Date('2026-01-01T00:00:01.000Z');
    const terminalSession = new CallSession({
      ...baseSession,
      status: 'ended',
      terminalReason: 'failed',
      lifecycleRevision: 1,
      endedAt,
      updatedAt: endedAt,
    });
    const sessionRepository = {
      save: jest.fn((session: CallSession) => Promise.resolve(session)),
      transitionToTerminal: jest.fn().mockResolvedValue({
        outcome: 'transitioned',
        session: terminalSession,
      }),
    };
    const stateRepository = {
      upsertParticipant: jest.fn(),
      clearCallState: jest.fn(),
    };
    const eventPublisher = {
      publish: jest.fn().mockResolvedValue(undefined),
    };
    const mediaEngine = {
      createRoom: jest.fn(),
      closeRoom: jest.fn(),
      getRouterRtpCapabilities: jest
        .fn()
        .mockRejectedValue(new Error('router unavailable')),
    };
    const conversationClient = {
      send: jest.fn().mockReturnValue(
        of({
          id: 'conv-1',
          participantIds: ['user-a', 'user-b'],
          isGroup: false,
        }),
      ),
    };
    const useCase = new InitiateCallUseCase(
      sessionRepository as never,
      stateRepository as never,
      eventPublisher,
      mediaEngine as never,
      conversationClient as never,
    );

    await expect(
      useCase.execute('conv-1', 'user-a', 'user-b', 'VOICE', 'socket-1'),
    ).rejects.toThrow('router unavailable');

    const callId = sessionRepository.save.mock.calls[0][0].callId;
    expect(sessionRepository.transitionToTerminal).toHaveBeenCalledWith(
      callId,
      'user-a',
      'failed',
      expect.any(Date),
      'leave',
    );
    expect(eventPublisher.publish).toHaveBeenNthCalledWith(
      2,
      'call.ended',
      expect.objectContaining({
        callId,
        reason: 'failed',
        lifecycleRevision: 1,
        at: endedAt.toISOString(),
      }),
    );
    expect(mediaEngine.closeRoom).toHaveBeenCalledWith(callId);
    expect(stateRepository.clearCallState).toHaveBeenCalledWith(callId);
  });

  it('terminalizes and cleans a persisted call when host participant setup fails before notification', async () => {
    const endedAt = new Date('2026-01-01T00:00:01.000Z');
    const terminalSession = new CallSession({
      ...baseSession,
      status: 'ended',
      terminalReason: 'failed',
      lifecycleRevision: 1,
      endedAt,
      updatedAt: endedAt,
    });
    const sessionRepository = {
      save: jest.fn((session: CallSession) => Promise.resolve(session)),
      transitionToTerminal: jest.fn().mockResolvedValue({
        outcome: 'transitioned',
        session: terminalSession,
      }),
    };
    const stateRepository = {
      upsertParticipant: jest
        .fn()
        .mockRejectedValue(new Error('participant store unavailable')),
      clearCallState: jest.fn(),
    };
    const eventPublisher = { publish: jest.fn() };
    const mediaEngine = {
      createRoom: jest.fn(),
      closeRoom: jest.fn(),
      getRouterRtpCapabilities: jest.fn(),
    };
    const conversationClient = {
      send: jest.fn().mockReturnValue(
        of({
          id: 'conv-1',
          participantIds: ['user-a', 'user-b'],
          isGroup: false,
        }),
      ),
    };
    const useCase = new InitiateCallUseCase(
      sessionRepository as never,
      stateRepository as never,
      eventPublisher,
      mediaEngine as never,
      conversationClient as never,
    );

    await expect(
      useCase.execute('conv-1', 'user-a', 'user-b', 'VOICE', 'socket-1'),
    ).rejects.toThrow('participant store unavailable');

    const callId = sessionRepository.save.mock.calls[0][0].callId;
    expect(sessionRepository.transitionToTerminal).toHaveBeenCalledWith(
      callId,
      'user-a',
      'failed',
      expect.any(Date),
      'leave',
    );
    expect(eventPublisher.publish).not.toHaveBeenCalled();
    expect(mediaEngine.closeRoom).toHaveBeenCalledWith(callId);
    expect(stateRepository.clearCallState).toHaveBeenCalledWith(callId);
  });

  it('rejects forged target users before any call state is created', async () => {
    const sessionRepository = {
      save: jest.fn(),
    };
    const stateRepository = {
      upsertParticipant: jest.fn(),
    };
    const eventPublisher = {
      publish: jest.fn(),
    };
    const mediaEngine = {
      createRoom: jest.fn(),
      getRouterRtpCapabilities: jest.fn(),
    };
    const conversationClient = {
      send: jest.fn().mockReturnValue(
        of({
          id: 'conv-1',
          participantIds: ['user-a', 'user-b'],
          isGroup: false,
        }),
      ),
    };

    const useCase = new InitiateCallUseCase(
      sessionRepository as never,
      stateRepository as never,
      eventPublisher,
      mediaEngine as never,
      conversationClient as never,
    );

    await expect(
      useCase.execute('conv-1', 'user-a', 'user-c', 'VIDEO', 'socket-1'),
    ).rejects.toBeInstanceOf(BadRequestException);

    expect(mediaEngine.createRoom).not.toHaveBeenCalled();
    expect(sessionRepository.save).not.toHaveBeenCalled();
    expect(stateRepository.upsertParticipant).not.toHaveBeenCalled();
    expect(eventPublisher.publish).not.toHaveBeenCalled();
  });

  it('maps conversation membership failures before creating any call state', async () => {
    const sessionRepository = {
      save: jest.fn(),
    };
    const stateRepository = {
      upsertParticipant: jest.fn(),
    };
    const eventPublisher = {
      publish: jest.fn(),
    };
    const mediaEngine = {
      createRoom: jest.fn(),
      getRouterRtpCapabilities: jest.fn(),
    };
    const conversationClient = {
      send: jest
        .fn()
        .mockReturnValue(
          throwError(
            () => new Error('You are not a participant of this conversation'),
          ),
        ),
    };

    const useCase = new InitiateCallUseCase(
      sessionRepository as never,
      stateRepository as never,
      eventPublisher,
      mediaEngine as never,
      conversationClient as never,
    );

    await expect(
      useCase.execute('conv-1', 'user-a', 'user-b', 'VIDEO', 'socket-1'),
    ).rejects.toBeInstanceOf(ForbiddenException);

    expect(mediaEngine.createRoom).not.toHaveBeenCalled();
    expect(sessionRepository.save).not.toHaveBeenCalled();
    expect(stateRepository.upsertParticipant).not.toHaveBeenCalled();
    expect(eventPublisher.publish).not.toHaveBeenCalled();
  });

  it('marks the call as ringing when the callee joins for the first time', async () => {
    const joinedSession = new CallSession({
      ...baseSession,
      status: 'ringing',
      participantIds: ['user-a', 'user-b'],
    });
    const sessionRepository = {
      joinParticipant: jest.fn().mockResolvedValue({
        outcome: 'joined',
        session: joinedSession,
        joinedNow: true,
      }),
    };
    const stateRepository = {
      getParticipant: jest.fn().mockResolvedValue(null),
      upsertParticipant: jest.fn(),
    };
    const mediaEngine = {
      getRouterRtpCapabilities: jest.fn().mockResolvedValue({
        codecs: [],
        headerExtensions: [],
      }),
    };

    const useCase = new JoinCallUseCase(
      sessionRepository as never,
      stateRepository as never,
      mediaEngine as never,
    );

    const result = await useCase.execute('call-1', 'user-b', 'socket-2');

    expect(result.role).toBe('guest');
    expect(result.shouldEmitNewPeer).toBe(true);
    expect(result.session.status).toBe('ringing');
    expect(result.session.participantIds).toEqual(['user-a', 'user-b']);
    expect(sessionRepository.joinParticipant).toHaveBeenCalledWith(
      'call-1',
      'user-b',
      expect.any(Date),
    );
  });

  it('merges socket ids and clears reconnect state when an existing participant rejoins', async () => {
    const activeSession = new CallSession({
      ...baseSession,
      status: 'active',
      participantIds: ['user-a', 'user-b'],
    });
    const sessionRepository = {
      joinParticipant: jest.fn().mockResolvedValue({
        outcome: 'joined',
        session: activeSession,
        joinedNow: false,
      }),
    };
    const stateRepository = {
      getParticipant: jest.fn().mockResolvedValue(
        new CallParticipant({
          userId: 'user-a',
          callId: 'call-1',
          role: 'host',
          socketId: 'socket-1',
          socketIds: ['socket-1'],
          isConnected: false,
          reconnectDeadlineAt: new Date('2026-01-01T00:00:10.000Z'),
          joinedAt: new Date('2026-01-01T00:00:00.000Z'),
        }),
      ),
      upsertParticipant: jest.fn(),
    };
    const mediaEngine = {
      getRouterRtpCapabilities: jest.fn().mockResolvedValue({
        codecs: [],
        headerExtensions: [],
      }),
    };

    const useCase = new JoinCallUseCase(
      sessionRepository as never,
      stateRepository as never,
      mediaEngine as never,
    );

    const result = await useCase.execute('call-1', 'user-a', 'socket-2');

    expect(result.role).toBe('host');
    expect(result.shouldEmitNewPeer).toBe(false);
    expect(stateRepository.upsertParticipant).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: 'user-a',
        callId: 'call-1',
        socketId: 'socket-2',
        socketIds: ['socket-1', 'socket-2'],
        isConnected: true,
        reconnectDeadlineAt: undefined,
      }),
    );
  });

  it('rejects transport creation for users outside the call', async () => {
    const sessionRepository = {
      findByCallId: jest.fn().mockResolvedValue(new CallSession(baseSession)),
    };
    const mediaEngine = {
      createSendTransport: jest.fn(),
      createRecvTransport: jest.fn(),
    };

    const useCase = new CreateTransportUseCase(
      mediaEngine as never,
      sessionRepository as never,
    );

    await expect(
      useCase.execute('call-1', 'user-c', 'send'),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('claims an answer without publishing lifecycle state before activation', async () => {
    const acceptingSession = new CallSession({
      ...baseSession,
      status: 'accepting',
      participantIds: ['user-a', 'user-b'],
      answeredAt: new Date('2026-01-01T00:00:01.000Z'),
      answerActionId: 'answer-1',
    });
    const sessionRepository = {
      claimIncomingAnswer: jest.fn().mockResolvedValue({
        outcome: 'accepted',
        session: acceptingSession,
        shouldPublishEvent: false,
      }),
    };

    const useCase = new AnswerCallUseCase(sessionRepository as never);

    await expect(
      useCase.execute('call-1', 'user-b', 'answer-1'),
    ).resolves.toEqual({ outcome: 'accepted', session: acceptingSession });

    expect(sessionRepository.claimIncomingAnswer).toHaveBeenCalledWith(
      'call-1',
      'user-b',
      'answer-1',
      expect.any(Date),
    );
  });

  it('returns answered_elsewhere without attempting a duplicate activation', async () => {
    const activeSession = new CallSession({
      ...baseSession,
      status: 'active',
      participantIds: ['user-a', 'user-b'],
      answerActionId: 'winner-action',
    });
    const sessionRepository = {
      claimIncomingAnswer: jest.fn().mockResolvedValue({
        outcome: 'answered_elsewhere',
        session: activeSession,
        shouldPublishEvent: false,
      }),
    };
    const useCase = new AnswerCallUseCase(sessionRepository as never);

    await expect(
      useCase.execute('call-1', 'user-b', 'loser-action'),
    ).resolves.toEqual(
      expect.objectContaining({ outcome: 'answered_elsewhere' }),
    );
  });

  it('returns a deterministic result when the same native action retries', async () => {
    const acceptingSession = new CallSession({
      ...baseSession,
      status: 'accepting',
      participantIds: ['user-a', 'user-b'],
      answerActionId: 'answer-1',
    });
    const sessionRepository = {
      claimIncomingAnswer: jest.fn().mockResolvedValue({
        outcome: 'already_accepted',
        session: acceptingSession,
        shouldPublishEvent: false,
      }),
    };
    const useCase = new AnswerCallUseCase(sessionRepository as never);

    await expect(
      useCase.execute('call-1', 'user-b', 'answer-1'),
    ).resolves.toEqual(
      expect.objectContaining({
        outcome: 'already_accepted',
        session: acceptingSession,
      }),
    );
  });

  it('accepts an incoming action once and returns the media bootstrap contract', async () => {
    const acceptingSession = new CallSession({
      ...baseSession,
      status: 'accepting',
      participantIds: ['user-a', 'user-b'],
      answerActionId: 'native-answer-1',
      answerLeaseExpiresAt: new Date('2026-01-01T00:00:10.000Z'),
    });
    const activeSession = new CallSession({
      ...baseSession,
      status: 'active',
      participantIds: ['user-a', 'user-b'],
      answerActionId: 'native-answer-1',
    });
    const answerCallUseCase = {
      execute: jest.fn().mockResolvedValue({
        outcome: 'accepted',
        session: acceptingSession,
      }),
    };
    const sessionRepository = {
      activateIncomingAnswer: jest.fn().mockResolvedValue({
        outcome: 'accepted',
        session: activeSession,
      }),
    };
    const stateRepository = {
      getParticipant: jest.fn().mockResolvedValue(null),
      upsertParticipant: jest.fn(),
    };
    const mediaEngine = {
      createRoom: jest.fn(),
      getRouterRtpCapabilities: jest.fn().mockResolvedValue({
        codecs: [],
        headerExtensions: [],
      }),
      listActiveProducers: jest.fn().mockResolvedValue([]),
      closeRoom: jest.fn(),
    };
    const eventPublisher = { publish: jest.fn() };
    const useCase = new AcceptIncomingCallUseCase(
      answerCallUseCase as never,
      sessionRepository as never,
      stateRepository as never,
      mediaEngine as never,
      eventPublisher,
    );

    await expect(
      useCase.execute('call-1', 'user-b', 'socket-2', 'native-answer-1'),
    ).resolves.toEqual(
      expect.objectContaining({
        callId: 'call-1',
        outcome: 'accepted',
        role: 'guest',
        session: activeSession,
      }),
    );
    expect(answerCallUseCase.execute).toHaveBeenCalledWith(
      'call-1',
      'user-b',
      'native-answer-1',
    );
    expect(sessionRepository.activateIncomingAnswer).toHaveBeenCalledWith(
      'call-1',
      'user-b',
      'native-answer-1',
      expect.any(Date),
    );
    expect(stateRepository.upsertParticipant).toHaveBeenCalledWith(
      expect.objectContaining({
        callId: 'call-1',
        userId: 'user-b',
        role: 'guest',
        socketIds: ['socket-2'],
        isConnected: true,
      }),
    );
    expect(mediaEngine.getRouterRtpCapabilities).toHaveBeenCalledWith('call-1');
    expect(mediaEngine.listActiveProducers).toHaveBeenCalledWith(
      'call-1',
      'user-b',
    );
  });

  it('does not allocate media state when another device already answered', async () => {
    const activeSession = new CallSession({
      ...baseSession,
      status: 'active',
      participantIds: ['user-a', 'user-b'],
      answerActionId: 'other-device-action',
    });
    const answerCallUseCase = {
      execute: jest.fn().mockResolvedValue({
        outcome: 'answered_elsewhere',
        session: activeSession,
      }),
    };
    const stateRepository = {
      getParticipant: jest.fn(),
      upsertParticipant: jest.fn(),
      clearCallState: jest.fn(),
    };
    const mediaEngine = {
      createRoom: jest.fn(),
      getRouterRtpCapabilities: jest.fn(),
      listActiveProducers: jest.fn(),
      closeRoom: jest.fn(),
    };
    const sessionRepository = { activateIncomingAnswer: jest.fn() };
    const useCase = new AcceptIncomingCallUseCase(
      answerCallUseCase as never,
      sessionRepository as never,
      stateRepository as never,
      mediaEngine as never,
      { publish: jest.fn() },
    );

    await expect(
      useCase.execute('call-1', 'user-b', 'socket-2', 'native-answer-1'),
    ).resolves.toEqual({
      callId: 'call-1',
      outcome: 'answered_elsewhere',
      session: activeSession,
    });
    expect(stateRepository.getParticipant).not.toHaveBeenCalled();
    expect(stateRepository.upsertParticipant).not.toHaveBeenCalled();
    expect(mediaEngine.createRoom).not.toHaveBeenCalled();
    expect(mediaEngine.getRouterRtpCapabilities).not.toHaveBeenCalled();
  });

  it('does not add a participant after a caller terminalizes during media preparation', async () => {
    const acceptingSession = new CallSession({
      ...baseSession,
      status: 'accepting',
      participantIds: ['user-a', 'user-b'],
      answerActionId: 'native-answer-1',
    });
    const cancelledSession = new CallSession({
      ...acceptingSession,
      status: 'cancelled',
      terminalReason: 'cancelled',
      endedAt: new Date('2026-01-01T00:00:01.000Z'),
    });
    const answerCallUseCase = {
      execute: jest.fn().mockResolvedValue({
        outcome: 'accepted',
        session: acceptingSession,
      }),
    };
    const sessionRepository = {
      activateIncomingAnswer: jest.fn().mockResolvedValue({
        outcome: 'terminal',
        session: cancelledSession,
      }),
    };
    const stateRepository = {
      getParticipant: jest.fn(),
      upsertParticipant: jest.fn(),
      clearCallState: jest.fn(),
    };
    const mediaEngine = {
      createRoom: jest.fn(),
      getRouterRtpCapabilities: jest.fn().mockResolvedValue({
        codecs: [],
        headerExtensions: [],
      }),
      listActiveProducers: jest.fn(),
      closeRoom: jest.fn(),
    };
    const useCase = new AcceptIncomingCallUseCase(
      answerCallUseCase as never,
      sessionRepository as never,
      stateRepository as never,
      mediaEngine as never,
      { publish: jest.fn() },
    );

    await expect(
      useCase.execute('call-1', 'user-b', 'socket-2', 'native-answer-1'),
    ).resolves.toEqual({
      callId: 'call-1',
      outcome: 'terminal',
      session: cancelledSession,
    });
    expect(stateRepository.upsertParticipant).not.toHaveBeenCalled();
    expect(mediaEngine.closeRoom).toHaveBeenCalledWith('call-1');
    expect(stateRepository.clearCallState).toHaveBeenCalledWith('call-1');
  });

  it.each(['accepted', 'already_accepted'] as const)(
    'terminalizes an owned accepting attempt when media setup fails (%s)',
    async (answerOutcome) => {
      const acceptingSession = new CallSession({
        ...baseSession,
        status: 'accepting',
        participantIds: ['user-a', 'user-b'],
        answerActionId: 'native-answer-1',
      });
      const endedSession = new CallSession({
        ...acceptingSession,
        status: 'ended',
        terminalReason: 'media_unavailable',
        endedAt: new Date('2026-01-01T00:00:01.000Z'),
      });
      const answerCallUseCase = {
        execute: jest.fn().mockResolvedValue({
          outcome: answerOutcome,
          session: acceptingSession,
        }),
      };
      const sessionRepository = {
        activateIncomingAnswer: jest.fn(),
        transitionToTerminal: jest.fn().mockResolvedValue({
          outcome: 'transitioned',
          session: endedSession,
        }),
      };
      const stateRepository = {
        getParticipant: jest.fn(),
        upsertParticipant: jest.fn(),
        clearCallState: jest.fn(),
      };
      const mediaEngine = {
        createRoom: jest
          .fn()
          .mockRejectedValue(new Error('Mediasoup unavailable')),
        getRouterRtpCapabilities: jest.fn(),
        listActiveProducers: jest.fn(),
        closeRoom: jest.fn(),
      };
      const eventPublisher = {
        publish: jest.fn().mockRejectedValue(new Error('RabbitMQ unavailable')),
      };
      const useCase = new AcceptIncomingCallUseCase(
        answerCallUseCase as never,
        sessionRepository as never,
        stateRepository as never,
        mediaEngine as never,
        eventPublisher,
      );

      await expect(
        useCase.execute('call-1', 'user-b', 'socket-2', 'native-answer-1'),
      ).resolves.toEqual({
        callId: 'call-1',
        outcome: 'media_unavailable',
        session: endedSession,
        shouldEmitTerminal: true,
      });
      expect(sessionRepository.transitionToTerminal).toHaveBeenCalledWith(
        'call-1',
        'user-b',
        'media_unavailable',
        expect.any(Date),
        'accept_failure',
        'native-answer-1',
      );
      expect(mediaEngine.closeRoom).toHaveBeenCalledWith('call-1');
      expect(stateRepository.clearCallState).toHaveBeenCalledWith('call-1');
      expect(eventPublisher.publish).toHaveBeenCalledWith(
        'call.ended',
        expect.objectContaining({
          callId: 'call-1',
          reason: 'media_unavailable',
        }),
      );
    },
  );

  it('returns the active bootstrap when a concurrent same-action retry already activated before participant attachment fails', async () => {
    const acceptingSession = new CallSession({
      ...baseSession,
      status: 'accepting',
      participantIds: ['user-a', 'user-b'],
      answerActionId: 'native-answer-1',
    });
    const activeSession = new CallSession({
      ...acceptingSession,
      status: 'active',
    });
    const rtpCapabilities = { codecs: [] };
    const activeProducers = [];
    const answerCallUseCase = {
      execute: jest.fn().mockResolvedValue({
        outcome: 'already_accepted',
        session: acceptingSession,
      }),
    };
    const sessionRepository = {
      activateIncomingAnswer: jest.fn().mockResolvedValue({
        outcome: 'already_accepted',
        session: activeSession,
      }),
      transitionToTerminal: jest.fn(),
    };
    const stateRepository = {
      getParticipant: jest.fn().mockResolvedValue(undefined),
      upsertParticipant: jest
        .fn()
        .mockRejectedValueOnce(new Error('temporary participant store failure'))
        .mockResolvedValue(undefined),
      clearCallState: jest.fn(),
    };
    const mediaEngine = {
      createRoom: jest.fn(),
      getRouterRtpCapabilities: jest.fn().mockResolvedValue(rtpCapabilities),
      listActiveProducers: jest.fn().mockResolvedValue(activeProducers),
      closeRoom: jest.fn(),
    };
    const useCase = new AcceptIncomingCallUseCase(
      answerCallUseCase as never,
      sessionRepository as never,
      stateRepository as never,
      mediaEngine as never,
      { publish: jest.fn() },
    );

    await expect(
      useCase.execute('call-1', 'user-b', 'socket-retry', 'native-answer-1'),
    ).resolves.toEqual({
      callId: 'call-1',
      role: 'guest',
      session: activeSession,
      rtpCapabilities,
      activeProducers,
      outcome: 'already_accepted_same_attempt',
    });
    expect(sessionRepository.transitionToTerminal).not.toHaveBeenCalled();
    expect(mediaEngine.closeRoom).not.toHaveBeenCalled();
  });

  it('never terminates an already-active same action when its retry fails locally', async () => {
    const activeSession = new CallSession({
      ...baseSession,
      status: 'active',
      participantIds: ['user-a', 'user-b'],
      answerActionId: 'native-answer-1',
    });
    const answerCallUseCase = {
      execute: jest.fn().mockResolvedValue({
        outcome: 'already_accepted',
        session: activeSession,
      }),
    };
    const sessionRepository = {
      activateIncomingAnswer: jest.fn(),
      transitionToTerminal: jest.fn(),
    };
    const stateRepository = {
      getParticipant: jest.fn(),
      upsertParticipant: jest.fn(),
      clearCallState: jest.fn(),
    };
    const mediaEngine = {
      createRoom: jest.fn().mockRejectedValue(new Error('room unavailable')),
      getRouterRtpCapabilities: jest.fn(),
      listActiveProducers: jest.fn(),
      closeRoom: jest.fn(),
    };
    const useCase = new AcceptIncomingCallUseCase(
      answerCallUseCase as never,
      sessionRepository as never,
      stateRepository as never,
      mediaEngine as never,
      { publish: jest.fn() },
    );

    await expect(
      useCase.execute('call-1', 'user-b', 'socket-2', 'native-answer-1'),
    ).resolves.toEqual({
      callId: 'call-1',
      outcome: 'media_unavailable',
      shouldEmitTerminal: false,
    });
    expect(sessionRepository.transitionToTerminal).not.toHaveBeenCalled();
    expect(mediaEngine.closeRoom).not.toHaveBeenCalled();
  });

  it('recovers the same action when a concurrent retry activated it before this setup failed', async () => {
    const acceptingSession = new CallSession({
      ...baseSession,
      status: 'accepting',
      participantIds: ['user-a', 'user-b'],
      answerActionId: 'native-answer-1',
    });
    const activeSession = new CallSession({
      ...acceptingSession,
      status: 'active',
    });
    const rtpCapabilities = { codecs: [] };
    const activeProducers = [];
    const answerCallUseCase = {
      execute: jest.fn().mockResolvedValue({
        outcome: 'accepted',
        session: acceptingSession,
      }),
    };
    const sessionRepository = {
      activateIncomingAnswer: jest.fn(),
      transitionToTerminal: jest.fn().mockResolvedValue({
        outcome: 'active',
        session: activeSession,
        wasActive: true,
      }),
    };
    const stateRepository = {
      getParticipant: jest.fn().mockResolvedValue(undefined),
      upsertParticipant: jest.fn(),
      clearCallState: jest.fn(),
    };
    const mediaEngine = {
      createRoom: jest
        .fn()
        .mockRejectedValue(new Error('stale room setup failed')),
      getRouterRtpCapabilities: jest.fn().mockResolvedValue(rtpCapabilities),
      listActiveProducers: jest.fn().mockResolvedValue(activeProducers),
      closeRoom: jest.fn(),
    };
    const eventPublisher = { publish: jest.fn() };
    const useCase = new AcceptIncomingCallUseCase(
      answerCallUseCase as never,
      sessionRepository as never,
      stateRepository as never,
      mediaEngine as never,
      eventPublisher,
    );

    await expect(
      useCase.execute('call-1', 'user-b', 'socket-retry', 'native-answer-1'),
    ).resolves.toEqual({
      callId: 'call-1',
      role: 'guest',
      session: activeSession,
      rtpCapabilities,
      activeProducers,
      outcome: 'already_accepted_same_attempt',
    });
    expect(sessionRepository.transitionToTerminal).toHaveBeenCalledWith(
      'call-1',
      'user-b',
      'media_unavailable',
      expect.any(Date),
      'accept_failure',
      'native-answer-1',
    );
    expect(stateRepository.upsertParticipant).toHaveBeenCalledWith(
      expect.objectContaining({ socketId: 'socket-retry' }),
    );
    expect(mediaEngine.closeRoom).not.toHaveBeenCalled();
    expect(stateRepository.clearCallState).not.toHaveBeenCalled();
    expect(eventPublisher.publish).not.toHaveBeenCalled();
  });

  it('cancels a pre-answer call and clears room state', async () => {
    const cancelledSession = new CallSession({
      ...baseSession,
      status: 'cancelled',
      endedAt: new Date('2026-01-01T00:00:01.000Z'),
      terminalReason: 'cancelled',
    });
    const sessionRepository = {
      transitionToTerminal: jest.fn().mockResolvedValue({
        outcome: 'transitioned',
        session: cancelledSession,
        reason: 'cancelled',
        wasActive: false,
      }),
    };
    const stateRepository = {
      clearCallState: jest.fn(),
    };
    const eventPublisher = {
      publish: jest.fn(),
    };
    const mediaEngine = {
      closeRoom: jest.fn(),
    };

    const useCase = new LeaveCallUseCase(
      sessionRepository as never,
      stateRepository as never,
      eventPublisher,
      mediaEngine as never,
    );

    const result = await useCase.execute('call-1', 'user-a');

    expect(result.endedReason).toBe('cancelled');
    expect(result.session.status).toBe('cancelled');
    expect(mediaEngine.closeRoom).toHaveBeenCalledWith('call-1');
    expect(stateRepository.clearCallState).toHaveBeenCalledWith('call-1');
    expect(sessionRepository.transitionToTerminal).toHaveBeenCalledWith(
      'call-1',
      'user-a',
      undefined,
      expect.any(Date),
      'leave',
    );
    expect(eventPublisher.publish).toHaveBeenCalledWith(
      'call.ended',
      expect.objectContaining({
        callId: 'call-1',
        reason: 'cancelled',
        recipientUserId: 'user-b',
        initiatorDisplayName: 'Ada',
        initiatorAvatarUrl: 'https://cdn.example/ada.png',
        ringTimeoutMs: 30000,
        expiresAt: '2026-01-01T00:00:30.000Z',
      }),
    );
  });

  it('returns expired sessions even if cleanup or lifecycle fan-out temporarily fails', async () => {
    const expiredSession = new CallSession({
      ...baseSession,
      status: 'ended',
      terminalReason: 'no_answer',
      endedAt: new Date('2026-01-01T00:00:30.000Z'),
    });
    const sessionRepository = {
      expireDueCalls: jest
        .fn()
        .mockResolvedValue([{ session: expiredSession, reason: 'no_answer' }]),
    };
    const stateRepository = {
      clearCallState: jest
        .fn()
        .mockRejectedValue(new Error('Redis unavailable')),
    };
    const eventPublisher = {
      publish: jest.fn().mockRejectedValue(new Error('RabbitMQ unavailable')),
    };
    const mediaEngine = {
      closeRoom: jest
        .fn()
        .mockRejectedValue(new Error('Mediasoup unavailable')),
    };
    const useCase = new ExpireDueCallsUseCase(
      sessionRepository as never,
      stateRepository as never,
      eventPublisher,
      mediaEngine as never,
    );

    await expect(useCase.execute()).resolves.toEqual([
      { session: expiredSession, reason: 'no_answer' },
    ]);
    expect(eventPublisher.publish).toHaveBeenCalledWith(
      'call.ended',
      expect.objectContaining({
        callId: expiredSession.callId,
        reason: 'no_answer',
      }),
    );
  });
});
