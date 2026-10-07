import { ConfigService } from '@nestjs/config';
import { Conversation } from '../../domain/entities/conversation.entity';
import { Message } from '../../domain/entities/message.entity';
import { NotificationServiceAdapter } from './notification-service.adapter';

const ACTOR_ID = '11111111-1111-4111-8111-111111111111';
const MEMBER_ID = '22222222-2222-4222-8222-222222222222';
const THIRD_ID = '33333333-3333-4333-8333-333333333333';

const okResponse = (
  status = 202,
  recipientCount = 1,
  createdCount = recipientCount,
): Response =>
  ({
    status,
    json: jest
      .fn()
      .mockResolvedValue({ status: 'queued', recipientCount, createdCount }),
    body: { cancel: jest.fn().mockResolvedValue(undefined) },
  }) as unknown as Response;

const makeMessage = (partial: Partial<Message> = {}) =>
  new Message({
    id: 'message-id',
    conversationId: 'conversation-id',
    senderId: ACTOR_ID,
    signalType: 1,
    content: 'Hello there',
    type: 'text',
    createdAt: new Date('2026-08-19T00:00:00.000Z'),
    ...partial,
  });

const makeAdapter = () => {
  const configService = {
    get: jest.fn((key: string) => {
      if (key === 'NOTIFICATION_SERVICE_URL') {
        return 'http://notification-service:3015';
      }

      if (key === 'NOTIFICATION_INTERNAL_SECRET') {
        return 'internal-secret';
      }

      return undefined;
    }),
  } as unknown as ConfigService;

  return new NotificationServiceAdapter(configService);
};

describe('NotificationServiceAdapter message fanout', () => {
  let fetchMock: jest.Mock;
  const originalFetch = global.fetch;

  beforeEach(() => {
    fetchMock = jest.fn();
    global.fetch = fetchMock;
  });

  afterEach(() => {
    global.fetch = originalFetch;
    jest.restoreAllMocks();
  });

  it('preserves direct-chat notification title and body', async () => {
    fetchMock.mockResolvedValue(okResponse());
    const adapter = makeAdapter();
    const conversation = new Conversation({
      id: 'conversation-id',
      creatorId: ACTOR_ID,
      participantIds: [ACTOR_ID, MEMBER_ID],
      participants: [
        { id: ACTOR_ID, name: 'Alice' },
        { id: MEMBER_ID, name: 'Bob' },
      ],
      isGroup: false,
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    await adapter.notifyNewMessage(conversation, makeMessage(), ACTOR_ID);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [, request] = fetchMock.mock.calls[0];
    expect(JSON.parse(String(request.body))).toEqual({
      recipientUserIds: [MEMBER_ID],
      actorUserId: ACTOR_ID,
      conversationId: 'conversation-id',
      messageId: 'message-id',
      title: 'Alice',
      body: 'Hello there',
    });
  });

  it('fans a group notification out to every unique participant except the sender', async () => {
    fetchMock.mockResolvedValue(okResponse(202, 2));
    const adapter = makeAdapter();
    const conversation = new Conversation({
      id: 'conversation-id',
      creatorId: ACTOR_ID,
      participantIds: [ACTOR_ID, MEMBER_ID, THIRD_ID, MEMBER_ID],
      participants: [
        { id: ACTOR_ID, name: 'Alice' },
        { id: MEMBER_ID, name: 'Bob' },
        { id: THIRD_ID, name: 'Charlie' },
      ],
      name: 'Core Team',
      isGroup: true,
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    await adapter.notifyNewMessage(conversation, makeMessage(), ACTOR_ID);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [, request] = fetchMock.mock.calls[0];
    expect(JSON.parse(String(request.body))).toEqual({
      recipientUserIds: [MEMBER_ID, THIRD_ID],
      actorUserId: ACTOR_ID,
      conversationId: 'conversation-id',
      messageId: 'message-id',
      title: 'Core Team',
      body: 'Alice: Hello there',
    });
  });

  it('uses stable group fallbacks when metadata enrichment is unavailable', async () => {
    fetchMock.mockResolvedValue(okResponse());
    const adapter = makeAdapter();
    const conversation = new Conversation({
      id: 'conversation-id',
      creatorId: ACTOR_ID,
      participantIds: [ACTOR_ID, MEMBER_ID],
      isGroup: true,
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    await adapter.notifyNewMessage(
      conversation,
      makeMessage({ content: '', type: 'image' }),
      ACTOR_ID,
    );

    const [, request] = fetchMock.mock.calls[0];
    expect(JSON.parse(String(request.body))).toEqual(
      expect.objectContaining({
        recipientUserIds: [MEMBER_ID],
        title: 'Group chat',
        body: 'Someone: [Image]',
      }),
    );
  });

  it.each([400, 401, 429, 500, 503, 200])(
    'retains failures and ambiguous HTTP %s for outbox retry without legacy fanout',
    async (status) => {
      fetchMock.mockResolvedValue(okResponse(status));
      const conversation = new Conversation({
        id: 'conversation-id',
        creatorId: ACTOR_ID,
        participantIds: [ACTOR_ID, MEMBER_ID],
        isGroup: true,
        createdAt: new Date(),
        updatedAt: new Date(),
      });
      await expect(
        makeAdapter().notifyNewMessage(conversation, makeMessage(), ACTOR_ID),
      ).rejects.toThrow(`HTTP ${status}`);
      expect(fetchMock).toHaveBeenCalledTimes(1);
    },
  );

  it.each([
    null,
    { status: 'sent', recipientCount: 1, createdCount: 1 },
    { status: 'queued', recipientCount: 2, createdCount: 1 },
    { status: 'queued', recipientCount: 1, createdCount: -1 },
    { status: 'queued', recipientCount: 1, createdCount: 2 },
    { status: 'queued', recipientCount: 1 },
  ])('rejects an invalid durable receipt %p', async (receipt) => {
    fetchMock.mockResolvedValue({
      status: 202,
      json: jest.fn().mockResolvedValue(receipt),
    });
    const conversation = new Conversation({
      id: 'conversation-id',
      creatorId: ACTOR_ID,
      participantIds: [ACTOR_ID, MEMBER_ID],
      isGroup: true,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    await expect(
      makeAdapter().notifyNewMessage(conversation, makeMessage(), ACTOR_ID),
    ).rejects.toThrow('did not confirm durable jobs');
  });

  it('accepts a replay receipt with zero new jobs and keeps the same message identity', async () => {
    const conversation = new Conversation({
      id: 'conversation-id',
      creatorId: ACTOR_ID,
      participantIds: [ACTOR_ID, MEMBER_ID],
      isGroup: false,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    fetchMock
      .mockResolvedValueOnce(okResponse())
      .mockResolvedValueOnce(okResponse(202, 1, 0));
    const adapter = makeAdapter();
    await adapter.notifyNewMessage(conversation, makeMessage(), ACTOR_ID);
    await adapter.notifyNewMessage(conversation, makeMessage(), ACTOR_ID);
    expect(fetchMock.mock.calls[0][1].body).toEqual(
      fetchMock.mock.calls[1][1].body,
    );
  });

  it('propagates a timeout and network failures instead of treating them as accepted', async () => {
    fetchMock.mockRejectedValue(new DOMException('Timed out', 'TimeoutError'));
    const timeout = jest.spyOn(AbortSignal, 'timeout');
    const conversation = new Conversation({
      id: 'conversation-id',
      creatorId: ACTOR_ID,
      participantIds: [ACTOR_ID, MEMBER_ID],
      isGroup: false,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    await expect(
      makeAdapter().notifyNewMessage(conversation, makeMessage(), ACTOR_ID),
    ).rejects.toThrow('Timed out');
    expect(timeout).toHaveBeenCalledWith(5000);
    expect(fetchMock.mock.calls[0][1].signal).toBeInstanceOf(AbortSignal);
  });

  it('propagates shutdown into the request signal', async () => {
    const shutdown = new AbortController();
    fetchMock.mockImplementation((_url, options: RequestInit) => {
      shutdown.abort();
      expect(options.signal?.aborted).toBe(true);
      return Promise.reject(new DOMException('Stopped', 'AbortError'));
    });
    const conversation = new Conversation({
      id: 'conversation-id',
      creatorId: ACTOR_ID,
      participantIds: [ACTOR_ID, MEMBER_ID],
      isGroup: false,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    await expect(
      makeAdapter().notifyNewMessage(
        conversation,
        makeMessage(),
        ACTOR_ID,
        shutdown.signal,
      ),
    ).rejects.toThrow('Stopped');
  });

  it('does not lose work when the internal secret is missing', async () => {
    const adapter = new NotificationServiceAdapter({
      get: () => undefined,
    } as unknown as ConfigService);
    const conversation = new Conversation({
      id: 'conversation-id',
      creatorId: ACTOR_ID,
      participantIds: [ACTOR_ID, MEMBER_ID],
      isGroup: false,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    await expect(
      adapter.notifyNewMessage(conversation, makeMessage(), ACTOR_ID),
    ).rejects.toThrow('NOTIFICATION_INTERNAL_SECRET');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('does not send a notification when no recipient remains after excluding the sender', async () => {
    const adapter = makeAdapter();
    const conversation = new Conversation({
      id: 'conversation-id',
      creatorId: ACTOR_ID,
      participantIds: [ACTOR_ID, ACTOR_ID],
      isGroup: true,
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    await adapter.notifyNewMessage(conversation, makeMessage(), ACTOR_ID);

    expect(fetchMock).not.toHaveBeenCalled();
  });
});
