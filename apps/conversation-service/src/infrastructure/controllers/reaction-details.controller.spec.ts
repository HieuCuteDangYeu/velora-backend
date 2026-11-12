import { ReactionDetailsMicroserviceController } from './reaction-details.controller';

const MESSAGE_ID = '0123456789abcdef01234567';
const CONVERSATION_ID = 'fedcba987654321001234567';

function build(messageFromRead: unknown) {
  const readReplicaQueries: jest.Mock[] = [];
  const read = jest.fn(
    async (
      _operation: string,
      query: (client: unknown) => Promise<unknown>,
    ) => {
      const findUnique = jest.fn().mockResolvedValue(messageFromRead);
      await query({ message: { findUnique } });
      readReplicaQueries.push(findUnique);
      return messageFromRead;
    },
  );
  const chatRepository = {
    assertConversationParticipant: jest.fn().mockResolvedValue(undefined),
  };
  const userService = {
    findUsersByIds: jest
      .fn()
      .mockResolvedValue([
        { id: 'user-1', fullName: 'An', username: 'an', picture: null },
      ]),
  };
  const controller = new ReactionDetailsMicroserviceController(
    { read } as never,
    chatRepository as never,
    userService as never,
  );
  return { controller, read, chatRepository, readReplicaQueries };
}

describe('ReactionDetailsMicroserviceController', () => {
  it('reads the message through the replica-aware reader and keeps the membership check', async () => {
    const { controller, read, chatRepository, readReplicaQueries } = build({
      id: MESSAGE_ID,
      conversationId: CONVERSATION_ID,
      isRecalled: false,
      reactions: {
        'user-1': { emoji: '👍', createdAt: '2026-11-12T10:00:00.000Z' },
      },
    });

    const result = await controller.handleGetReactionDetails({
      messageId: MESSAGE_ID,
      userId: 'viewer',
    });

    expect(read).toHaveBeenCalledWith(
      'reaction_details',
      expect.any(Function),
      { confirmMiss: true },
    );
    expect(readReplicaQueries[0]).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: MESSAGE_ID } }),
    );
    expect(chatRepository.assertConversationParticipant).toHaveBeenCalledWith(
      CONVERSATION_ID,
      'viewer',
    );
    expect(result.total).toBe(1);
    expect(result.reactions[0]).toMatchObject({
      userId: 'user-1',
      emoji: '👍',
    });
  });

  it('returns no reactions for a recalled message', async () => {
    const { controller } = build({
      id: MESSAGE_ID,
      conversationId: CONVERSATION_ID,
      isRecalled: true,
      reactions: {
        'user-1': { emoji: '👍', createdAt: '2026-11-12T10:00:00.000Z' },
      },
    });

    const result = await controller.handleGetReactionDetails({
      messageId: MESSAGE_ID,
      userId: 'viewer',
    });

    expect(result.total).toBe(0);
  });

  it('rejects when neither the replica nor the primary has the message', async () => {
    const { controller, chatRepository } = build(null);

    await expect(
      controller.handleGetReactionDetails({
        messageId: MESSAGE_ID,
        userId: 'viewer',
      }),
    ).rejects.toBeDefined();
    expect(chatRepository.assertConversationParticipant).not.toHaveBeenCalled();
  });

  it('rejects a malformed message id before touching any database', async () => {
    const { controller, read } = build(null);

    await expect(
      controller.handleGetReactionDetails({
        messageId: 'not-an-object-id',
        userId: 'viewer',
      }),
    ).rejects.toBeDefined();
    expect(read).not.toHaveBeenCalled();
  });
});
