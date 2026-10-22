import { Conversation } from '../../domain/entities/conversation.entity';
import { Message } from '../../domain/entities/message.entity';
import { GroupActivityService } from './group-activity.service';

const CONVERSATION_ID = '507f1f77bcf86cd799439011';
const OWNER_ID = 'owner-id';
const ACTOR_ID = 'actor-id';
const TARGET_ID = 'target-id';

const group = (participantIds = [OWNER_ID, ACTOR_ID, TARGET_ID]) =>
  new Conversation({
    id: CONVERSATION_ID,
    creatorId: OWNER_ID,
    participantIds,
    participants: [
      { id: OWNER_ID, fullName: 'Owner User', email: 'owner@example.com' },
      { id: ACTOR_ID, fullName: 'Alice Admin', email: 'alice@example.com' },
      { id: TARGET_ID, fullName: 'Bob Member', email: 'bob@example.com' },
    ],
    isGroup: true,
    createdAt: new Date('2026-08-20T00:00:00.000Z'),
    updatedAt: new Date('2026-08-20T00:00:00.000Z'),
  });

const savedMessage = (overrides: Partial<Message> = {}) =>
  new Message({
    id: 'message-id',
    conversationId: CONVERSATION_ID,
    senderId: ACTOR_ID,
    clientMessageId: 'system:test',
    content: 'Alice Admin added Bob Member',
    type: 'text',
    createdAt: new Date('2026-08-20T01:00:00.000Z'),
    readBy: [],
    ...overrides,
  });

describe('GroupActivityService', () => {
  let chatRepository: any;
  let realtimePublisher: any;
  let configService: any;
  let service: GroupActivityService;

  beforeEach(() => {
    chatRepository = {
      findConversation: jest.fn().mockResolvedValue(group()),
      createMessageIdempotently: jest.fn().mockResolvedValue({
        created: true,
        message: savedMessage(),
      }),
    };
    realtimePublisher = {
      emitNewMessage: jest.fn(),
      emitConversationUpdated: jest.fn(),
    };
    configService = {
      get: jest.fn().mockReturnValue('true'),
    };
    service = new GroupActivityService(
      chatRepository,
      realtimePublisher,
      configService,
    );
  });

  it('is a complete no-op while the activity feature flag is disabled', () => {
    configService.get.mockReturnValue('false');

    service.publish({
      conversationId: CONVERSATION_ID,
      type: 'MEMBER_ADDED',
      actorUserId: ACTOR_ID,
      targetUserId: TARGET_ID,
    });

    expect(chatRepository.findConversation).not.toHaveBeenCalled();
    expect(chatRepository.createMessageIdempotently).not.toHaveBeenCalled();
    expect(realtimePublisher.emitNewMessage).not.toHaveBeenCalled();
  });

  it('persists structured metadata and emits realtime only after a new activity message is created', async () => {
    const persisted = savedMessage();
    chatRepository.createMessageIdempotently.mockResolvedValue({
      created: true,
      message: persisted,
    });
    chatRepository.findConversation
      .mockResolvedValueOnce(group())
      .mockResolvedValueOnce(group());

    await (service as any).persistAndPublish({
      conversationId: CONVERSATION_ID,
      type: 'MEMBER_ADDED',
      actorUserId: ACTOR_ID,
      actorName: 'Alice Admin',
      targetUserId: TARGET_ID,
      targetName: 'Bob Member',
    });

    expect(chatRepository.createMessageIdempotently).toHaveBeenCalledTimes(1);
    const message = chatRepository.createMessageIdempotently.mock
      .calls[0][0] as Message;
    expect(message.conversationId).toBe(CONVERSATION_ID);
    expect(message.senderId).toBe(ACTOR_ID);
    expect(message.type).toBe('text');
    expect(message.content).toBe('Alice Admin added Bob Member');
    expect(message.clientMessageId).toMatch(/^system:MEMBER_ADDED:/);
    expect(message.metadata).toEqual({
      kind: 'group_system_activity',
      groupActivity: {
        type: 'MEMBER_ADDED',
        actorUserId: ACTOR_ID,
        actorName: 'Alice Admin',
        targetUserId: TARGET_ID,
        targetName: 'Bob Member',
      },
    });
    expect(realtimePublisher.emitNewMessage).toHaveBeenCalledWith(
      CONVERSATION_ID,
      persisted,
    );
    expect(realtimePublisher.emitConversationUpdated).toHaveBeenCalledTimes(1);
  });

  it('resolves a missing activity actor name from the current conversation participants', async () => {
    chatRepository.findConversation
      .mockResolvedValueOnce(group())
      .mockResolvedValueOnce(group());

    await (service as any).persistAndPublish({
      conversationId: CONVERSATION_ID,
      type: 'GROUP_CREATED',
      actorUserId: OWNER_ID,
    });

    const message = chatRepository.createMessageIdempotently.mock
      .calls[0][0] as Message;
    expect(message.senderId).toBe(OWNER_ID);
    expect(message.content).toBe('Owner User created the group');
    expect(message.metadata?.groupActivity).toEqual({
      type: 'GROUP_CREATED',
      actorUserId: OWNER_ID,
      actorName: 'Owner User',
    });
  });

  it('does not emit realtime for an idempotent persistence result', async () => {
    chatRepository.createMessageIdempotently.mockResolvedValue({
      created: false,
      message: savedMessage(),
    });

    await (service as any).persistAndPublish({
      conversationId: CONVERSATION_ID,
      type: 'GROUP_RENAMED',
      actorUserId: ACTOR_ID,
      actorName: 'Alice Admin',
      previousValue: 'Old name',
      nextValue: 'New name',
    });

    expect(realtimePublisher.emitNewMessage).not.toHaveBeenCalled();
    expect(realtimePublisher.emitConversationUpdated).not.toHaveBeenCalled();
  });

  it('keeps the real actor in structured metadata when that actor already left the group', async () => {
    const afterLeave = group([OWNER_ID, TARGET_ID]);
    chatRepository.findConversation
      .mockResolvedValueOnce(afterLeave)
      .mockResolvedValueOnce(afterLeave);

    await (service as any).persistAndPublish({
      conversationId: CONVERSATION_ID,
      type: 'MEMBER_LEFT',
      actorUserId: ACTOR_ID,
      actorName: 'Alice Admin',
    });

    const message = chatRepository.createMessageIdempotently.mock
      .calls[0][0] as Message;
    expect(message.senderId).toBe(OWNER_ID);
    expect(message.content).toBe('Alice Admin left the group');
    expect(message.metadata?.groupActivity).toEqual(
      expect.objectContaining({
        type: 'MEMBER_LEFT',
        actorUserId: ACTOR_ID,
        actorName: 'Alice Admin',
      }),
    );
  });

  it('does nothing when the conversation disappeared or is no longer a group', async () => {
    chatRepository.findConversation.mockResolvedValue(null);

    await (service as any).persistAndPublish({
      conversationId: CONVERSATION_ID,
      type: 'GROUP_CREATED',
      actorUserId: OWNER_ID,
    });

    expect(chatRepository.createMessageIdempotently).not.toHaveBeenCalled();
    expect(realtimePublisher.emitNewMessage).not.toHaveBeenCalled();
  });
});
