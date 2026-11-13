import { Logger } from '@nestjs/common';
import { Server, Socket } from 'socket.io';
import { ChatGateway } from './chat.gateway';

const USER = '11111111-1111-4111-8111-111111111111';

const makeGateway = (presence: Record<string, unknown> | undefined) => {
  const chatRepository = {
    findPresenceAudienceUserIds: jest.fn().mockResolvedValue([]),
  };
  const redis = {
    del: jest.fn().mockResolvedValue(1),
    set: jest.fn().mockResolvedValue('OK'),
  };
  const gateway = new ChatGateway(
    null as never,
    null as never,
    null as never,
    chatRepository as never,
    null as never,
    redis as never,
    presence as never,
  );
  const fetchSockets = jest.fn().mockResolvedValue([{}]);
  gateway.server = {
    to: jest.fn().mockReturnValue({ emit: jest.fn() }),
    in: jest.fn().mockReturnValue({ fetchSockets }),
    sockets: { sockets: new Map() },
  } as unknown as Server;
  return { gateway, fetchSockets, chatRepository, redis };
};

const client = (id = 'socket-1') =>
  ({
    id,
    data: { userId: USER },
    join: jest.fn().mockResolvedValue(undefined),
    disconnect: jest.fn(),
  }) as unknown as Socket;

describe('ChatGateway presence registry', () => {
  beforeEach(() => {
    jest.spyOn(Logger.prototype, 'warn').mockImplementation();
    jest.spyOn(console, 'log').mockImplementation();
  });
  afterEach(() => jest.restoreAllMocks());

  it('answers connect from the registry without asking any replica', async () => {
    const presence = {
      enabled: true,
      connect: jest.fn().mockResolvedValue(false),
    };
    const { gateway, fetchSockets, chatRepository } = makeGateway(presence);
    const socket = client();

    await gateway.handleConnection(socket);

    expect(presence.connect).toHaveBeenCalledWith(USER, 'socket-1');
    expect(fetchSockets).not.toHaveBeenCalled();
    expect(socket.join).toHaveBeenCalled();
    // The user was offline before, so their audience hears about it.
    expect(chatRepository.findPresenceAudienceUserIds).toHaveBeenCalledWith(
      USER,
    );
  });

  it('does not announce a user who already had another live socket', async () => {
    const presence = {
      enabled: true,
      connect: jest.fn().mockResolvedValue(true),
    };
    const { gateway, chatRepository } = makeGateway(presence);

    await gateway.handleConnection(client());

    expect(chatRepository.findPresenceAudienceUserIds).not.toHaveBeenCalled();
  });

  it('marks the user offline only when the registry says no socket is left', async () => {
    const presence = {
      enabled: true,
      disconnect: jest
        .fn()
        .mockResolvedValueOnce(true)
        .mockResolvedValueOnce(false),
    };
    const { gateway, fetchSockets, redis, chatRepository } =
      makeGateway(presence);

    await gateway.handleDisconnect(client());
    expect(redis.set).not.toHaveBeenCalled();

    await gateway.handleDisconnect(client('socket-2'));
    expect(redis.set).toHaveBeenCalledTimes(1);
    expect(chatRepository.findPresenceAudienceUserIds).toHaveBeenCalledTimes(1);
    expect(fetchSockets).not.toHaveBeenCalled();
  });

  it('falls back to asking the sockets when Redis fails', async () => {
    const presence = {
      enabled: true,
      connect: jest.fn().mockRejectedValue(new Error('redis down')),
      isOnline: jest.fn().mockRejectedValue(new Error('redis down')),
    };
    const { gateway, fetchSockets } = makeGateway(presence);
    fetchSockets.mockResolvedValue([]);
    const socket = client();

    await gateway.handleConnection(socket);

    expect(fetchSockets).toHaveBeenCalled();
    expect(socket.disconnect).not.toHaveBeenCalled();
    expect(socket.join).toHaveBeenCalled();
  });

  it('keeps using the sockets when the registry is switched off or absent', async () => {
    for (const presence of [
      { enabled: false, connect: jest.fn() },
      undefined,
    ]) {
      const { gateway, fetchSockets } = makeGateway(presence);
      fetchSockets.mockResolvedValue([]);
      await gateway.handleConnection(client());
      expect(fetchSockets).toHaveBeenCalled();
      if (presence) expect(presence.connect).not.toHaveBeenCalled();
    }
  });

  it('refreshes only the sockets held by this replica', () => {
    let provider: (() => Iterable<unknown>) | undefined;
    const presence = {
      enabled: true,
      startHeartbeat: jest.fn((fn: () => Iterable<unknown>) => {
        provider = fn;
      }),
      stopHeartbeat: jest.fn(),
    };
    const { gateway } = makeGateway(presence);
    (gateway.server as unknown as { sockets: unknown }).sockets = {
      sockets: new Map([
        ['a', { id: 'a', data: { userId: USER } }],
        ['b', { id: 'b', data: {} }],
      ]),
    };

    gateway.afterInit();
    expect([...provider!()]).toEqual([{ userId: USER, socketId: 'a' }]);

    gateway.onModuleDestroy();
    expect(presence.stopHeartbeat).toHaveBeenCalled();
  });
});
