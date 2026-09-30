// Red on published d07f662c; now part of the required call-service unit gate.
import { LeaveCallUseCase } from '../../../src/application/use-cases/leave-call.use-case';
import { PublishCallTerminalOutboxUseCase } from '../../../src/application/use-cases/publish-call-terminal-outbox.use-case';
import { CallSession } from '../../../src/domain/entities/call-session.entity';
import { MediasoupCallMediaEngine } from '../../../src/infrastructure/engines/mediasoup-call.engine';
import { ChangeCallTypeUseCase } from '../../../src/application/use-cases/change-call-type.use-case';
import { CallGateway } from '../../../src/infrastructure/gateways/call.gateway';
import { CallParticipant } from '../../../src/domain/entities/call-participant.entity';
import type { Socket } from 'socket.io';

describe('A05 source audit: cleanup must survive durable-state faults', () => {
  it('does not save an active snapshot after a concurrent video-call hangup', async () => {
    let persisted = new CallSession({
      callId: 'direct-audit',
      conversationId: 'conversation-audit',
      initiatorId: 'host',
      targetUserId: 'guest',
      callType: 'VIDEO',
      status: 'active',
      participantIds: ['host', 'guest'],
      lifecycleRevision: 5,
    });
    const repository = {
      findByCallId: jest.fn(() =>
        Promise.resolve(new CallSession({ ...persisted })),
      ),
      changeCallType: jest.fn(
        (
          _callId: string,
          _userId: string,
          revision: number,
          callType: 'VOICE' | 'VIDEO',
        ) => {
          if (
            persisted.status !== 'active' ||
            persisted.lifecycleRevision !== revision
          )
            return Promise.resolve(false);
          persisted.callType = callType;
          return Promise.resolve(true);
        },
      ),
    };
    let releaseClose!: () => void;
    const engine = {
      listActiveProducers: jest
        .fn()
        .mockResolvedValue([
          { producerId: 'video-host', userId: 'host', kind: 'video' },
        ]),
      closeProducer: jest.fn(
        () =>
          new Promise<void>((resolve) => {
            releaseClose = resolve;
          }),
      ),
    };
    const changing = new ChangeCallTypeUseCase(
      repository as never,
      engine as never,
    ).execute('direct-audit', 'host', 'VOICE');
    for (let attempt = 0; attempt < 10 && !releaseClose; attempt++)
      await Promise.resolve();
    expect(releaseClose).toEqual(expect.any(Function));
    // Concurrent host terminal CAS wins while producer cleanup is pending.
    persisted = new CallSession({
      ...persisted,
      status: 'ended',
      lifecycleRevision: 6,
      endedAt: new Date(),
    });
    releaseClose();
    await expect(changing).rejects.toThrow('Call changed');
    expect(persisted.status).toBe('ended');
    expect(persisted.lifecycleRevision).toBe(6);
  });

  it('keeps no connected ghost when both same-account sockets disconnect concurrently', async () => {
    const session = new CallSession({
      callId: 'group-audit',
      conversationId: 'conversation-audit',
      initiatorId: 'host',
      targetUserId: 'guest',
      isGroupCall: true,
      callType: 'VOICE',
      status: 'active',
      participantIds: ['host', 'guest'],
    });
    let participant = new CallParticipant({
      callId: session.callId,
      userId: 'guest',
      role: 'guest',
      socketIds: ['socket-a', 'socket-b'],
      isConnected: true,
    });
    const state = {
      getParticipant: jest.fn(() =>
        Promise.resolve(
          new CallParticipant({
            ...participant,
            socketIds: [...participant.socketIds],
          }),
        ),
      ),
      upsertParticipant: jest.fn((next: CallParticipant) => {
        participant = next;
        return Promise.resolve();
      }),
    };
    // Only session/state/lease are reached by the current disconnect path.
    const args: unknown[] = Array.from({ length: 22 }, () => ({}));
    args[15] = { findByCallId: jest.fn().mockResolvedValue(session) };
    args[16] = state;
    args[19] = { assertHeld: jest.fn() };
    const gateway = Reflect.construct(CallGateway, args) as CallGateway;
    gateway.server = {
      to: jest.fn().mockReturnValue({ emit: jest.fn() }),
    } as never;
    try {
      await Promise.all(
        ['socket-a', 'socket-b'].map((id) =>
          gateway.handleDisconnect({
            id,
            data: { userId: 'guest', callIds: [session.callId] },
          } as unknown as Socket),
        ),
      );
      expect(participant.socketIds).toEqual([]);
      expect(participant.isConnected).toBe(false);
    } finally {
      gateway.onModuleDestroy();
    }
  });

  it('closes a terminal host room before a pending notification publish settles', async () => {
    const session = new CallSession({
      callId: 'group-audit',
      conversationId: 'conversation-audit',
      initiatorId: 'host',
      targetUserId: 'guest',
      isGroupCall: true,
      callType: 'VOICE',
      status: 'ended',
      participantIds: ['host', 'guest'],
      endedAt: new Date(),
    });
    let liveRoom = true;
    let releasePublish!: () => void;
    const useCase = new LeaveCallUseCase(
      {
        transitionToTerminal: jest.fn().mockResolvedValue({
          outcome: 'transitioned',
          session,
          wasActive: true,
        }),
      } as never,
      { clearCallState: jest.fn().mockResolvedValue(undefined) } as never,
      {
        publish: jest.fn(
          () =>
            new Promise<void>((resolve) => {
              releasePublish = resolve;
            }),
        ),
      },
      {
        closeRoom: jest.fn(() => {
          liveRoom = false;
          return Promise.resolve();
        }),
      } as never,
    );
    const leaving = useCase.revokeGroupMembership(session.callId, 'host');
    for (let attempt = 0; attempt < 10 && !releasePublish; attempt++)
      await Promise.resolve();
    expect(releasePublish).toEqual(expect.any(Function));
    const mediaWasClosedBeforeBrokerRecovery = !liveRoom;
    releasePublish();
    await leaving;
    expect(mediaWasClosedBeforeBrokerRecovery).toBe(true);
  });

  it('closes live host media on retry after Redis committed terminal but its response was lost', async () => {
    const session = new CallSession({
      callId: 'group-audit',
      conversationId: 'conversation-audit',
      initiatorId: 'host',
      targetUserId: 'guest',
      isGroupCall: true,
      callType: 'VOICE',
      status: 'ended',
      participantIds: ['host', 'guest'],
      terminalReason: 'ended',
      endedAt: new Date(),
    });
    let liveRoom = true;
    const mediaEngine = {
      closeRoom: jest.fn(() => {
        liveRoom = false;
        return Promise.resolve();
      }),
    };
    const sessionRepository = {
      transitionToTerminal: jest
        .fn()
        .mockRejectedValueOnce(new Error('Redis response lost after commit'))
        .mockResolvedValue({
          outcome: 'already_terminal',
          session,
          reason: 'ended',
        }),
      claimPendingTerminalEvents: jest
        .fn()
        .mockResolvedValue([
          { session, event: 'call.ended', reason: 'ended', userId: 'host' },
        ]),
      markTerminalEventPublished: jest.fn().mockResolvedValue(undefined),
    };
    const stateRepository = {
      clearCallState: jest.fn().mockResolvedValue(undefined),
    };
    const eventPublisher = { publish: jest.fn().mockResolvedValue(undefined) };
    const leave = new LeaveCallUseCase(
      sessionRepository as never,
      stateRepository as never,
      eventPublisher,
      mediaEngine as never,
    );
    await expect(leave.execute(session.callId, 'host')).rejects.toThrow(
      'response lost',
    );
    await leave.execute(session.callId, 'host');
    await new PublishCallTerminalOutboxUseCase(
      sessionRepository as never,
      eventPublisher,
      stateRepository as never,
      mediaEngine as never,
    ).execute();
    // Neither retry nor the durable outbox may leave terminal SFU media live.
    expect(sessionRepository.markTerminalEventPublished).toHaveBeenCalledTimes(
      1,
    );
    expect(liveRoom).toBe(false);
  });

  it('cleans guest media after a committed leave loses its response and the retry reports departed', async () => {
    const session = new CallSession({
      callId: 'group-audit',
      conversationId: 'conversation-audit',
      initiatorId: 'host',
      targetUserId: 'guest',
      isGroupCall: true,
      callType: 'VOICE',
      status: 'active',
      participantIds: ['host', 'other-guest'],
      declinedUserIds: ['guest'],
    });
    let guestMediaLive = true;
    const mediaEngine = {
      closeParticipant: jest.fn(() => {
        guestMediaLive = false;
        return Promise.resolve({ producers: [] });
      }),
    };
    const sessionRepository = {
      transitionToTerminal: jest
        .fn()
        .mockRejectedValueOnce(new Error('Redis response lost after commit'))
        .mockResolvedValue({ outcome: 'already_terminal', session }),
    };
    const useCase = new LeaveCallUseCase(
      sessionRepository as never,
      {} as never,
      { publish: jest.fn() },
      mediaEngine as never,
    );
    await expect(useCase.execute(session.callId, 'guest')).rejects.toThrow(
      'response lost',
    );
    await expect(
      useCase.execute(session.callId, 'guest'),
    ).resolves.toMatchObject({ shouldEmitPeerLeft: true });
    expect(guestMediaLive).toBe(false);
  });

  it('tears down guest receive transport before a pending Redis producer deletion settles', async () => {
    const producer = {
      id: 'audio-guest',
      closed: false,
      on: jest.fn(),
      close: jest.fn(),
    };
    producer.close.mockImplementation(() => {
      producer.closed = true;
    });
    const send = {
      id: 'send-guest',
      closed: false,
      on: jest.fn(),
      observer: { on: jest.fn() },
      close: jest.fn(),
      connect: jest.fn().mockResolvedValue(undefined),
      produce: jest.fn().mockResolvedValue(producer),
    };
    const receive = {
      id: 'recv-guest',
      closed: false,
      on: jest.fn(),
      observer: { on: jest.fn() },
      close: jest.fn(),
    };
    send.close.mockImplementation(() => {
      send.closed = true;
    });
    receive.close.mockImplementation(() => {
      receive.closed = true;
    });
    const router = {
      id: 'router-audit',
      close: jest.fn(),
      createWebRtcTransport: jest
        .fn()
        .mockResolvedValueOnce(send)
        .mockResolvedValueOnce(receive),
    };
    const stateRepository = {
      saveRoom: jest.fn().mockResolvedValue(undefined),
      saveTransportState: jest.fn().mockResolvedValue(undefined),
      saveProducerState: jest.fn().mockResolvedValue(undefined),
      removeProducerState: jest.fn().mockResolvedValue(undefined),
      removeTransportState: jest.fn().mockResolvedValue(undefined),
    };
    const engine = new MediasoupCallMediaEngine(stateRepository as never);
    (engine as unknown as { workers: unknown[] }).workers.push({
      pid: 1,
      createRouter: jest.fn().mockResolvedValue(router),
    });
    await engine.createRoom('group-audit');
    await engine.createSendTransport('group-audit', 'guest');
    await engine.createRecvTransport('group-audit', 'guest');
    await engine.connectTransport('group-audit', 'guest', send.id, {});
    await engine.produce('group-audit', 'guest', send.id, 'audio', {});
    let releaseRedis!: () => void;
    stateRepository.removeProducerState.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          releaseRedis = resolve;
        }),
    );
    const cleanup = engine.closeParticipant('group-audit', 'guest');
    await Promise.resolve();
    expect(releaseRedis).toEqual(expect.any(Function));
    const receiveWasClosedBeforeRedisRecovery = receive.closed;
    releaseRedis();
    await cleanup;
    expect(receiveWasClosedBeforeRedisRecovery).toBe(true);
  });
});
