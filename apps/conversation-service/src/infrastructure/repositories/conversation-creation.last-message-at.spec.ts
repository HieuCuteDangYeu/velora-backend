import { Conversation } from '../../domain/entities/conversation.entity';
import { PrismaChatRepository } from './prisma-chat.repository';
import { PrismaConversationChatRepository } from './prisma-conversation-chat.repository';

const CREATED_AT = new Date('2026-10-14T01:00:00.000Z');

const savedRecord = (data: Record<string, unknown>) => ({
  id: '507f1f77bcf86cd799439011',
  name: null,
  picture: null,
  memberJoinedAt: null,
  lastMessage: null,
  ...data,
});

const newConversation = (partial: Partial<Conversation> = {}) =>
  new Conversation({
    creatorId: 'alice',
    participantIds: ['alice', 'bob'],
    isGroup: false,
    createdAt: CREATED_AT,
    updatedAt: CREATED_AT,
    ...partial,
  });

const collaborators = () => ({
  redis: { del: jest.fn() } as never,
  encryption: { decrypt: jest.fn(), encrypt: jest.fn() },
  userService: { findUsersByIds: jest.fn() } as never,
  chatMediaService: { deleteRecalledChatMedia: jest.fn() },
});

describe('conversation creation lastMessageAt', () => {
  // A null lastMessageAt sorts last in the descending conversation list, so a
  // new chat or group with no messages yet used to start at the bottom.
  const repositories = [
    [
      'PrismaConversationChatRepository',
      (create: jest.Mock) => {
        const c = collaborators();
        const repository = new PrismaConversationChatRepository(
          { conversation: { create } } as never,
          c.redis,
          c.encryption,
          c.userService,
          c.chatMediaService,
        );
        // The group projection is covered by its own suite.
        (
          repository as unknown as Record<string, unknown>
        ).syncGroupMemberProjection = jest.fn().mockResolvedValue(undefined);
        return repository;
      },
    ],
    [
      'PrismaChatRepository',
      (create: jest.Mock) => {
        const c = collaborators();
        return new PrismaChatRepository(
          { conversation: { create } } as never,
          c.redis,
          c.encryption,
          c.userService,
          c.chatMediaService,
        );
      },
    ],
  ] as const;

  it.each(repositories)(
    '%s starts an empty conversation at its creation time',
    async (_name, build) => {
      const create = jest.fn((args: { data: Record<string, unknown> }) =>
        Promise.resolve(savedRecord(args.data)),
      );
      const repository = build(create);

      const direct = await repository.createConversation(newConversation());
      const group = await repository.createConversation(
        newConversation({ isGroup: true, participantIds: ['a', 'b', 'c'] }),
      );

      expect(create.mock.calls[0][0].data.lastMessageAt).toEqual(CREATED_AT);
      expect(create.mock.calls[1][0].data.lastMessageAt).toEqual(CREATED_AT);
      expect(direct.lastMessageAt).toEqual(CREATED_AT);
      expect(group.lastMessageAt).toEqual(CREATED_AT);
    },
  );

  it.each(repositories)(
    '%s keeps an explicit lastMessageAt',
    async (_name, build) => {
      const explicit = new Date('2026-10-14T02:00:00.000Z');
      const create = jest.fn((args: { data: Record<string, unknown> }) =>
        Promise.resolve(savedRecord(args.data)),
      );

      await build(create).createConversation(
        newConversation({ lastMessageAt: explicit }),
      );

      expect(create.mock.calls[0][0].data.lastMessageAt).toEqual(explicit);
    },
  );
});
