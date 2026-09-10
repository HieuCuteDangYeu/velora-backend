import { Conversation } from '../../domain/entities/conversation.entity';
import type { CreateConversationResult } from '../../application/use-cases/create-conversastion.use-case';
import { ConversationMicroserviceController } from './conversation.controller';

const createConversation = (withParticipants = true) =>
  new Conversation({
    id: 'conversation-1',
    creatorId: 'user-1',
    participantIds: ['user-1', 'user-2'],
    ...(withParticipants
      ? {
          participants: [
            { id: 'user-1', name: 'User One' },
            { id: 'user-2', name: 'User Two' },
          ],
        }
      : {}),
    isGroup: false,
    createdAt: new Date('2026-07-16T00:00:00.000Z'),
    updatedAt: new Date('2026-07-16T00:00:00.000Z'),
  });

const createController = ({
  createConversationResult,
  findConversation,
}: {
  createConversationResult: CreateConversationResult;
  findConversation: jest.Mock;
}) => {
  const emitConversationCreated = jest.fn();
  const createConversationUseCase = {
    execute: jest.fn().mockResolvedValue(createConversationResult),
  };
  const chatRepository = { findConversation };
  const chatGateway = { emitConversationCreated };
  const controller = new ConversationMicroserviceController(
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    createConversationUseCase as never,
    {} as never,
    {} as never,
    chatGateway as never,
    {} as never,
    {} as never,
    chatRepository as never,
    {} as never,
  );

  return {
    controller,
    createConversationUseCase,
    findConversation,
    emitConversationCreated,
  };
};

describe('ConversationMicroserviceController conversation_created event', () => {
  it('emits a hydrated conversation to every participant when it creates one', async () => {
    const conversation = createConversation();
    const harness = createController({
      createConversationResult: { conversation, created: true },
      findConversation: jest.fn().mockResolvedValue(conversation),
    });

    await expect(
      harness.controller.handleCreateConversation({
        participantIds: conversation.participantIds,
        isGroup: false,
        creatorId: conversation.creatorId,
      }),
    ).resolves.toEqual({ id: conversation.id });

    expect(harness.findConversation).toHaveBeenCalledWith(conversation.id);
    expect(harness.emitConversationCreated).toHaveBeenCalledTimes(1);
    expect(harness.emitConversationCreated).toHaveBeenCalledWith(
      expect.objectContaining({
        id: conversation.id,
        participantIds: conversation.participantIds,
        participants: conversation.participants,
      }),
    );
  });

  it('does not emit when the direct conversation already exists', async () => {
    const conversation = createConversation();
    const harness = createController({
      createConversationResult: { conversation, created: false },
      findConversation: jest.fn(),
    });

    await expect(
      harness.controller.handleCreateConversation({
        participantIds: conversation.participantIds,
        isGroup: false,
        creatorId: conversation.creatorId,
      }),
    ).resolves.toEqual({ id: conversation.id });

    expect(harness.findConversation).not.toHaveBeenCalled();
    expect(harness.emitConversationCreated).not.toHaveBeenCalled();
  });

  it('emits the created conversation when participant enrichment fails', async () => {
    const conversation = createConversation(false);
    const harness = createController({
      createConversationResult: { conversation, created: true },
      findConversation: jest
        .fn()
        .mockRejectedValue(new Error('User service unavailable')),
    });

    await expect(
      harness.controller.handleCreateConversation({
        participantIds: conversation.participantIds,
        isGroup: false,
        creatorId: conversation.creatorId,
      }),
    ).resolves.toEqual({ id: conversation.id });

    expect(harness.emitConversationCreated).toHaveBeenCalledWith(
      expect.objectContaining({ id: conversation.id }),
    );
  });
});
