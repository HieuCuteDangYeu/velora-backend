import { ForbiddenException, Logger, NotFoundException } from '@nestjs/common';
import { Server, Socket } from 'socket.io';
import { Conversation } from '../../domain/entities/conversation.entity';
import { Message } from '../../domain/entities/message.entity';
import type { IChatRepository } from '../../domain/interfaces/chat.repository.interface';
import { ChatGateway } from './chat.gateway';

const OWNER_ID = '11111111-1111-4111-8111-111111111111';
const MEMBER_ID = '22222222-2222-4222-8222-222222222222';
const CONVERSATION_ID = '507f1f77bcf86cd799439011';
const ownerRooms = [OWNER_ID, `user:${OWNER_ID}`];
const memberRooms = [MEMBER_ID, `user:${MEMBER_ID}`];
const conversationRooms = [CONVERSATION_ID, `conversation:${CONVERSATION_ID}`];

const conversation = () =>
  new Conversation({
    id: CONVERSATION_ID,
    creatorId: OWNER_ID,
    participantIds: [OWNER_ID, MEMBER_ID],
    isGroup: true,
    name: 'Realtime Group',
    createdAt: new Date('2026-08-19T00:00:00.000Z'),
    updatedAt: new Date('2026-08-19T00:00:00.000Z'),
  });

describe('ChatGateway realtime membership helpers', () => {
  let chatRepository: {
    assertConversationParticipant: jest.Mock;
    findPresenceAudienceUserIds: jest.Mock;
    markMessagesAsSeen: jest.Mock;
  };
  let redis: { del: jest.Mock; set: jest.Mock };
  let gateway: ChatGateway;
  let emit: jest.Mock;
  let socketsLeave: jest.Mock;
  let fetchSockets: jest.Mock;
  let to: jest.Mock;
  let inRoom: jest.Mock;

  beforeEach(() => {
    jest.spyOn(Logger.prototype, 'warn').mockImplementation();
    chatRepository = {
      assertConversationParticipant: jest.fn().mockResolvedValue(undefined),
      findPresenceAudienceUserIds: jest.fn().mockResolvedValue([]),
      markMessagesAsSeen: jest.fn().mockResolvedValue({}),
    };
    redis = {
      del: jest.fn().mockResolvedValue(1),
      set: jest.fn().mockResolvedValue('OK'),
    };

    gateway = new ChatGateway(
      null as never,
      null as never,
      null as never,
      chatRepository as unknown as IChatRepository,
      null as never,
      redis as never,
    );

    emit = jest.fn();
    socketsLeave = jest.fn();
    fetchSockets = jest.fn().mockResolvedValue([{}]);
    to = jest.fn().mockReturnValue({ emit });
    inRoom = jest.fn().mockReturnValue({ socketsLeave, fetchSockets });

    gateway.server = {
      to,
      in: inRoom,
    } as unknown as Server;
  });

  afterEach(() => jest.restoreAllMocks());

  it('dual-joins legacy and namespaced user rooms on connection', async () => {
    const client = {
      id: 'socket-1',
      data: { userId: OWNER_ID },
      join: jest.fn().mockResolvedValue(undefined),
    } as unknown as Socket;

    await gateway.handleConnection(client);

    expect(inRoom).toHaveBeenCalledWith(ownerRooms);
    expect(client.join).toHaveBeenCalledWith(ownerRooms);
    expect(redis.del).toHaveBeenCalled();
  });

  it('authorizes then dual-joins legacy and namespaced conversation rooms', async () => {
    const client = {
      id: 'socket-2',
      data: { userId: MEMBER_ID },
      join: jest.fn().mockResolvedValue(undefined),
    } as unknown as Socket;

    await gateway.handleJoinConversation(CONVERSATION_ID, client);

    expect(chatRepository.assertConversationParticipant).toHaveBeenCalledWith(
      CONVERSATION_ID,
      MEMBER_ID,
    );
    expect(client.join).toHaveBeenCalledWith(conversationRooms);
  });

  it.each(['audience', 'last-seen'])(
    'contains an online presence %s outage after joining user rooms',
    async (failure) => {
      fetchSockets.mockResolvedValueOnce([]);
      if (failure === 'audience') {
        chatRepository.findPresenceAudienceUserIds.mockRejectedValueOnce(
          new Error('Mongo I/O timeout'),
        );
      } else {
        redis.del.mockRejectedValueOnce(new Error('Redis unavailable'));
      }
      const client = {
        id: 'presence-failure',
        data: { userId: OWNER_ID },
        join: jest.fn().mockResolvedValue(undefined),
        disconnect: jest.fn(),
      };
      await expect(
        gateway.handleConnection(client as unknown as Socket),
      ).resolves.toBeUndefined();
      expect(client.join).toHaveBeenCalledWith(ownerRooms);
      expect(client.disconnect).not.toHaveBeenCalled();
      expect(Logger.prototype.warn).toHaveBeenCalledWith(
        'Online presence update failed; socket retained',
      );
    },
  );

  it.each(['room', 'socket-query'])(
    'closes only the affected socket when required %s setup fails',
    async (failure) => {
      const client = {
        id: 'setup-failure',
        data: { userId: OWNER_ID },
        join: jest.fn().mockResolvedValue(undefined),
        disconnect: jest.fn(),
      };
      if (failure === 'room')
        client.join.mockRejectedValueOnce(new Error('Join failed'));
      else fetchSockets.mockRejectedValueOnce(new Error('Redis unavailable'));
      await expect(
        gateway.handleConnection(client as unknown as Socket),
      ).resolves.toBeUndefined();
      expect(client.disconnect).toHaveBeenCalledWith(true);
      expect(chatRepository.findPresenceAudienceUserIds).not.toHaveBeenCalled();
    },
  );

  it('does not join or publish presence for an unauthenticated socket', async () => {
    const client = {
      id: 'unauthenticated',
      data: {},
      handshake: { auth: {}, headers: {} },
      join: jest.fn(),
      disconnect: jest.fn(),
    };
    await expect(
      gateway.handleConnection(client as unknown as Socket),
    ).resolves.toBeUndefined();
    expect(client.disconnect).toHaveBeenCalledWith(true);
    expect(client.join).not.toHaveBeenCalled();
    expect(chatRepository.findPresenceAudienceUserIds).not.toHaveBeenCalled();
  });

  it('publishes online presence after successful authenticated setup', async () => {
    fetchSockets.mockResolvedValueOnce([]);
    chatRepository.findPresenceAudienceUserIds.mockResolvedValueOnce([
      MEMBER_ID,
    ]);
    const client = {
      id: 'online',
      data: { userId: OWNER_ID },
      join: jest.fn().mockResolvedValue(undefined),
      disconnect: jest.fn(),
    };
    await gateway.handleConnection(client as unknown as Socket);
    expect(emit).toHaveBeenCalledWith('user:online', {
      userId: OWNER_ID,
      lastSeenAt: null,
    });
    expect(client.disconnect).not.toHaveBeenCalled();
  });

  it.each(['socket-query', 'last-seen', 'audience'])(
    'contains an offline presence %s outage',
    async (failure) => {
      fetchSockets.mockResolvedValueOnce([]);
      if (failure === 'socket-query')
        fetchSockets
          .mockReset()
          .mockRejectedValueOnce(new Error('Redis unavailable'));
      if (failure === 'last-seen')
        redis.set.mockRejectedValueOnce(new Error('Redis unavailable'));
      if (failure === 'audience')
        chatRepository.findPresenceAudienceUserIds.mockRejectedValueOnce(
          new Error('Mongo I/O timeout'),
        );
      await expect(
        gateway.handleDisconnect({
          id: 'offline',
          data: { userId: OWNER_ID },
        } as unknown as Socket),
      ).resolves.toBeUndefined();
      expect(Logger.prototype.warn).toHaveBeenCalledWith(
        'Offline presence update failed',
      );
    },
  );

  it('publishes last-seen only after the final socket disconnects', async () => {
    fetchSockets.mockResolvedValueOnce([{}]).mockResolvedValueOnce([]);
    chatRepository.findPresenceAudienceUserIds.mockResolvedValueOnce([
      MEMBER_ID,
    ]);
    const client = {
      id: 'offline',
      data: { userId: OWNER_ID },
    } as unknown as Socket;
    await gateway.handleDisconnect(client);
    expect(redis.set).not.toHaveBeenCalled();
    await gateway.handleDisconnect(client);
    expect(redis.set).toHaveBeenCalledWith(
      expect.any(String),
      expect.any(String),
    );
    expect(emit).toHaveBeenCalledWith('user:offline', {
      userId: OWNER_ID,
      lastSeenAt: expect.any(String),
    });
  });

  it.each([
    ['forbidden membership', new ForbiddenException('not a participant')],
    ['missing conversation', new NotFoundException('conversation not found')],
  ])(
    'turns a rejected cached-room rejoin into conversation_removed for %s',
    async (_label, rejection) => {
      chatRepository.assertConversationParticipant.mockRejectedValueOnce(
        rejection,
      );
      const clientEmit = jest.fn();
      const clientJoin = jest.fn().mockResolvedValue(undefined);
      const client = {
        id: 'socket-revoked',
        data: { userId: MEMBER_ID },
        emit: clientEmit,
        join: clientJoin,
      } as unknown as Socket;

      await gateway.handleJoinConversation(CONVERSATION_ID, client);

      expect(clientEmit).toHaveBeenCalledWith('conversation_removed', {
        conversationId: CONVERSATION_ID,
        reason: 'removed',
      });
      expect(clientJoin).not.toHaveBeenCalled();
    },
  );

  it('does not convert an unexpected join failure into a revocation event', async () => {
    chatRepository.assertConversationParticipant.mockRejectedValueOnce(
      new Error('database unavailable'),
    );
    const clientEmit = jest.fn();
    const clientJoin = jest.fn().mockResolvedValue(undefined);
    const client = {
      id: 'socket-transient',
      data: { userId: MEMBER_ID },
      emit: clientEmit,
      join: clientJoin,
    } as unknown as Socket;

    await gateway.handleJoinConversation(CONVERSATION_ID, client);

    expect(clientEmit).not.toHaveBeenCalledWith(
      'conversation_removed',
      expect.anything(),
    );
    expect(clientJoin).not.toHaveBeenCalled();
  });

  it('dual-targets legacy and namespaced conversation rooms', () => {
    gateway.emitToConversation(CONVERSATION_ID, 'new_message', {
      conversationId: CONVERSATION_ID,
    });

    expect(to).toHaveBeenCalledWith(conversationRooms);
    expect(emit).toHaveBeenCalledWith('new_message', {
      conversationId: CONVERSATION_ID,
    });
  });

  it('emits a bounded terminal bot failure without forwarding provider detail', () => {
    const message = new Message({
      id: 'user-message-id',
      conversationId: CONVERSATION_ID,
      clientMessageId: 'client-message-id',
      senderId: OWNER_ID,
      content: 'question',
      signalType: 0,
      type: 'text',
      createdAt: new Date('2026-08-19T00:01:00.000Z'),
    });

    gateway.emitBotReplyFailure(message, {
      code: 'AI_UNAVAILABLE',
      message: 'provider token=secret-detail',
    });

    expect(emit).toHaveBeenCalledWith('bot_reply_failed', {
      conversationId: CONVERSATION_ID,
      userMessageId: 'user-message-id',
      clientMessageId: 'client-message-id',
      error: {
        code: 'AI_UNAVAILABLE',
        message: 'AI service is temporarily unavailable',
      },
    });
  });

  it('emits conversation updates to legacy and namespaced account rooms in one fanout', () => {
    const group = conversation();

    gateway.emitConversationUpdated(group);

    expect(to).toHaveBeenCalledWith([...ownerRooms, ...memberRooms]);
    expect(emit).toHaveBeenCalledWith(
      'conversation_updated',
      expect.objectContaining({
        id: CONVERSATION_ID,
        participantIds: [OWNER_ID, MEMBER_ID],
      }),
    );
  });

  it('fans message activity out through the recipient legacy and namespaced account rooms only', () => {
    const group = conversation();
    const message = new Message({
      id: 'message-id',
      conversationId: CONVERSATION_ID,
      senderId: OWNER_ID,
      content: 'hello group',
      signalType: 0,
      type: 'text',
      createdAt: new Date('2026-08-19T00:01:00.000Z'),
    });

    gateway.emitConversationMessageActivity(group, message, OWNER_ID);

    expect(to).toHaveBeenCalledWith(memberRooms);
    expect(emit).toHaveBeenCalledWith(
      'conversation_message_activity',
      expect.objectContaining({
        conversation: expect.objectContaining({
          id: CONVERSATION_ID,
          participantIds: [OWNER_ID, MEMBER_ID],
        }),
        message: expect.objectContaining({
          id: 'message-id',
          conversationId: CONVERSATION_ID,
          senderId: OWNER_ID,
        }),
      }),
    );
  });

  it('can target conversation_created to only the newly-added member across both room forms', () => {
    const group = conversation();

    gateway.emitConversationCreated(group, [MEMBER_ID]);

    expect(to).toHaveBeenCalledWith(memberRooms);
    expect(emit).toHaveBeenCalledWith(
      'conversation_created',
      expect.objectContaining({ id: CONVERSATION_ID }),
    );
  });

  it('notifies every device then removes the account from both conversation room forms', () => {
    gateway.evictConversationMember({
      conversationId: CONVERSATION_ID,
      userId: MEMBER_ID,
      reason: 'removed',
    });

    expect(to).toHaveBeenCalledWith(memberRooms);
    expect(emit).toHaveBeenCalledWith('conversation_removed', {
      conversationId: CONVERSATION_ID,
      reason: 'removed',
    });
    expect(inRoom).toHaveBeenCalledWith(memberRooms);
    expect(socketsLeave).toHaveBeenCalledWith(conversationRooms);
  });

  it('does not disconnect the account when evicting it from one conversation', () => {
    const disconnectSockets = jest.fn();
    gateway.server = {
      to,
      in: inRoom,
      disconnectSockets,
    } as unknown as Server;

    gateway.evictConversationMember({
      conversationId: CONVERSATION_ID,
      userId: MEMBER_ID,
      reason: 'left',
    });

    expect(socketsLeave).toHaveBeenCalledWith(conversationRooms);
    expect(disconnectSockets).not.toHaveBeenCalled();
  });

  it('broadcasts read receipts to both conversation room forms', async () => {
    const seenAt = new Date('2026-08-19T00:03:00.000Z');
    chatRepository.markMessagesAsSeen.mockResolvedValueOnce({
      seenUpTo: {
        messageId: 'message-id',
        createdAt: new Date('2026-08-19T00:02:00.000Z'),
      },
      seenAt,
    });
    const clientEmit = jest.fn();
    const clientTo = jest.fn().mockReturnValue({ emit: clientEmit });
    const client = {
      id: 'socket-seen',
      data: { userId: MEMBER_ID },
      to: clientTo,
    } as unknown as Socket;

    await gateway.handleMarkSeen(
      { conversationId: CONVERSATION_ID, upToMessageId: 'message-id' },
      client,
    );

    expect(clientTo).toHaveBeenCalledWith(conversationRooms);
    expect(clientEmit).toHaveBeenCalledWith(
      'messages_seen',
      expect.objectContaining({
        conversationId: CONVERSATION_ID,
        readByUserId: MEMBER_ID,
        messageId: 'message-id',
        at: seenAt.toISOString(),
      }),
    );
  });

  it('broadcasts typing state to both conversation room forms', async () => {
    const clientEmit = jest.fn();
    const clientTo = jest.fn().mockReturnValue({ emit: clientEmit });
    const client = {
      id: 'socket-typing',
      data: { userId: MEMBER_ID },
      to: clientTo,
    } as unknown as Socket;

    await gateway.handleTypingStart(CONVERSATION_ID, client);

    expect(clientTo).toHaveBeenCalledWith(conversationRooms);
    expect(clientEmit).toHaveBeenCalledWith('user_typing', {
      conversationId: CONVERSATION_ID,
      userId: MEMBER_ID,
      isTyping: true,
    });
  });
});
