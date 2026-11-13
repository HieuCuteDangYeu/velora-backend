import { Conversation } from '../../domain/entities/conversation.entity';
import type { ManageGroupConversationUseCase } from '../../application/use-cases/manage-group-conversation.use-case';
import type { ChatGateway } from '../gateways/chat.gateway';
import { ConversationMicroserviceController } from './conversation.controller';

const OWNER_ID = '11111111-1111-4111-8111-111111111111';
const MEMBER_ID = '22222222-2222-4222-8222-222222222222';
const THIRD_ID = '33333333-3333-4333-8333-333333333333';
const NEW_MEMBER_ID = '44444444-4444-4444-8444-444444444444';
const CONVERSATION_ID = '507f1f77bcf86cd799439011';

const group = (participantIds: string[], creatorId = OWNER_ID) =>
  new Conversation({
    id: CONVERSATION_ID,
    creatorId,
    participantIds,
    isGroup: true,
    name: 'Realtime Group',
    createdAt: new Date('2026-08-19T00:00:00.000Z'),
    updatedAt: new Date('2026-08-19T00:00:00.000Z'),
  });

describe('ConversationMicroserviceController realtime group orchestration', () => {
  let manageGroupConversationUseCase: {
    updateMetadata: jest.Mock;
    addMember: jest.Mock;
    transferOwnership: jest.Mock;
    removeMember: jest.Mock;
    leave: jest.Mock;
  };
  let chatGateway: {
    emitConversationCreated: jest.Mock;
    emitConversationUpdated: jest.Mock;
    evictConversationMember: jest.Mock;
  };
  let controller: ConversationMicroserviceController;

  beforeEach(() => {
    manageGroupConversationUseCase = {
      updateMetadata: jest.fn(),
      addMember: jest.fn(),
      transferOwnership: jest.fn(),
      removeMember: jest.fn(),
      leave: jest.fn(),
    };
    chatGateway = {
      emitConversationCreated: jest.fn(),
      emitConversationUpdated: jest.fn(),
      evictConversationMember: jest.fn(),
    };

    controller = new ConversationMicroserviceController(
      null as never,
      null as never,
      null as never,
      null as never,
      null as never,
      null as never,
      null as never,
      manageGroupConversationUseCase as unknown as ManageGroupConversationUseCase,
      null as never,
      chatGateway as unknown as ChatGateway,
      null as never,
      null as never,
      null as never,
      null as never,
    );
  });

  it('fans metadata changes out to every current participant', async () => {
    const updated = group([OWNER_ID, MEMBER_ID, THIRD_ID]);
    manageGroupConversationUseCase.updateMetadata.mockResolvedValue(updated);

    const result = await controller.handleUpdateGroupConversation({
      conversationId: CONVERSATION_ID,
      actorUserId: OWNER_ID,
      name: 'Renamed',
    });

    expect(chatGateway.emitConversationUpdated).toHaveBeenCalledWith(updated);
    expect(result).toEqual(expect.objectContaining({ id: CONVERSATION_ID }));
  });

  it('fans ownership transfer out to every current participant', async () => {
    const updated = group([OWNER_ID, MEMBER_ID, THIRD_ID], MEMBER_ID);
    manageGroupConversationUseCase.transferOwnership.mockResolvedValue(updated);

    const result = await controller.handleTransferGroupOwnership({
      conversationId: CONVERSATION_ID,
      actorUserId: OWNER_ID,
      userId: MEMBER_ID,
    });

    expect(chatGateway.emitConversationUpdated).toHaveBeenCalledWith(updated);
    expect(result).toEqual(
      expect.objectContaining({ id: CONVERSATION_ID, creatorId: MEMBER_ID }),
    );
  });

  it('sends conversation_created only to a newly-added member and updates existing members', async () => {
    const updated = group([OWNER_ID, MEMBER_ID, THIRD_ID, NEW_MEMBER_ID]);
    manageGroupConversationUseCase.addMember.mockResolvedValue({
      conversation: updated,
      added: true,
    });

    await controller.handleAddConversationMember({
      conversationId: CONVERSATION_ID,
      actorUserId: OWNER_ID,
      userId: NEW_MEMBER_ID,
    });

    expect(chatGateway.emitConversationCreated).toHaveBeenCalledWith(updated, [
      NEW_MEMBER_ID,
    ]);
    expect(chatGateway.emitConversationUpdated).toHaveBeenCalledWith(updated, [
      OWNER_ID,
      MEMBER_ID,
      THIRD_ID,
    ]);
  });

  it('does not replay cache events for an idempotent add-member retry', async () => {
    const unchanged = group([OWNER_ID, MEMBER_ID, THIRD_ID]);
    manageGroupConversationUseCase.addMember.mockResolvedValue({
      conversation: unchanged,
      added: false,
    });

    await controller.handleAddConversationMember({
      conversationId: CONVERSATION_ID,
      actorUserId: OWNER_ID,
      userId: MEMBER_ID,
    });

    expect(chatGateway.emitConversationCreated).not.toHaveBeenCalled();
    expect(chatGateway.emitConversationUpdated).not.toHaveBeenCalled();
  });

  it('evicts a removed member and refreshes the remaining participants', async () => {
    const updated = group([OWNER_ID, THIRD_ID]);
    manageGroupConversationUseCase.removeMember.mockResolvedValue(updated);

    await controller.handleRemoveConversationMember({
      conversationId: CONVERSATION_ID,
      actorUserId: OWNER_ID,
      userId: MEMBER_ID,
    });

    expect(chatGateway.evictConversationMember).toHaveBeenCalledWith({
      conversationId: CONVERSATION_ID,
      userId: MEMBER_ID,
      reason: 'removed',
    });
    expect(chatGateway.emitConversationUpdated).toHaveBeenCalledWith(updated);
  });

  it('evicts a leaving member while keeping their account socket connected', async () => {
    const updated = group([OWNER_ID, THIRD_ID]);
    manageGroupConversationUseCase.leave.mockResolvedValue(updated);

    await controller.handleLeaveGroupConversation({
      conversationId: CONVERSATION_ID,
      actorUserId: MEMBER_ID,
    });

    expect(chatGateway.evictConversationMember).toHaveBeenCalledWith({
      conversationId: CONVERSATION_ID,
      userId: MEMBER_ID,
      reason: 'left',
    });
    expect(chatGateway.emitConversationUpdated).toHaveBeenCalledWith(updated);
  });
});
