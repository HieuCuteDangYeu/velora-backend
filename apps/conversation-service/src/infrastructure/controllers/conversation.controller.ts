import { CreateMessageDto } from '@common/conversation/dtos/create-message.dto';
import { CreateMessageResponse } from '@common/conversation/interfaces/create-message-response.interface';
import { MessageAnchorExpansionResponse } from '@common/conversation/interfaces/message-anchor-expansion.interface';
import { MessageAnchorWindowResponse } from '@common/conversation/interfaces/message-anchor-window.interface';
import type {
  CompletedVideoProcessingPayload,
  FailedVideoProcessingPayload,
} from '@common/media/dtos/video-processing-result.dto';
import { Controller, Inject, Logger } from '@nestjs/common';
import {
  EventPattern,
  MessagePattern,
  Payload,
  RpcException,
} from '@nestjs/microservices';
import { CreateConversationUseCase } from '../../application/use-cases/create-conversastion.use-case';
import { GetAnchorNewerMessagesUseCase } from '../../application/use-cases/get-anchor-newer-messages.use-case';
import { GetAnchorOlderMessagesUseCase } from '../../application/use-cases/get-anchor-older-messages.use-case';
import { GetConversationUseCase } from '../../application/use-cases/get-conversation.use-case';
import { GetMessagesAroundUseCase } from '../../application/use-cases/get-messages-around.use-case';
import { GetMessagesUseCase } from '../../application/use-cases/get-messages.use-case';
import { ManageGroupConversationUseCase } from '../../application/use-cases/manage-group-conversation.use-case';
import { SendMessageUseCase } from '../../application/use-cases/send-message.use-case';
import { TriggerBotReplyUseCase } from '../../application/use-cases/trigger-bot-reply.use-case';
import { IChatRepository } from '../../domain/interfaces/chat.repository.interface';
import type { IChatMediaService } from '../../domain/interfaces/chat-media.service.interface';
import { NotificationServiceAdapter } from '../adapters/notification-service.adapter';
import { ChatGateway } from '../gateways/chat.gateway';
import { ChatMapper } from '../repositories/chat.mapper';
import { GetUserConversationsUseCase } from './../../application/use-cases/get-user-conversations.use-case';

@Controller()
export class ConversationMicroserviceController {
  private readonly logger = new Logger(ConversationMicroserviceController.name);

  constructor(
    private readonly sendMessageUseCase: SendMessageUseCase,
    private readonly getMessagesUseCase: GetMessagesUseCase,
    private readonly getMessagesAroundUseCase: GetMessagesAroundUseCase,
    private readonly getAnchorOlderMessagesUseCase: GetAnchorOlderMessagesUseCase,
    private readonly getAnchorNewerMessagesUseCase: GetAnchorNewerMessagesUseCase,
    private readonly getConversationUseCase: GetConversationUseCase,
    private readonly createConversationUseCase: CreateConversationUseCase,
    private readonly manageGroupConversationUseCase: ManageGroupConversationUseCase,
    private readonly getUserConversationsUseCase: GetUserConversationsUseCase,
    private readonly chatGateway: ChatGateway,
    private readonly triggerBotReplyUseCase: TriggerBotReplyUseCase,
    private readonly notificationService: NotificationServiceAdapter,
    @Inject('IChatRepository') private readonly chatRepository: IChatRepository,
    @Inject('IChatMediaService')
    private readonly chatMediaService: IChatMediaService,
  ) {}

  @MessagePattern('create_conversation')
  async handleCreateConversation(
    @Payload()
    payload: {
      participantIds: string[];
      isGroup?: boolean;
      type?: 'DIRECT' | 'GROUP';
      name?: string;
      picture?: string;
      creatorId?: string;
    },
  ) {
    try {
      const creatorId = payload.creatorId ?? payload.participantIds[0];
      const { conversation, created } =
        await this.createConversationUseCase.execute(
          {
            participantIds: payload.participantIds,
            ...(payload.isGroup !== undefined
              ? { isGroup: payload.isGroup }
              : {}),
            ...(payload.type !== undefined ? { type: payload.type } : {}),
            ...(payload.name !== undefined ? { name: payload.name } : {}),
            ...(payload.picture !== undefined
              ? { picture: payload.picture }
              : {}),
          },
          creatorId,
        );

      if (created) {
        let eventConversation = conversation;

        try {
          eventConversation =
            (await this.chatRepository.findConversation(conversation.id)) ??
            conversation;
        } catch (error) {
          this.logger.warn(
            `Unable to enrich created conversation ${conversation.id}: ${(error as Error).message}`,
          );
        }

        this.chatGateway.emitConversationCreated(eventConversation);
      }

      return { id: conversation.id };
    } catch (err: unknown) {
      const error = err as Error;
      this.logger.error(`❌ [CreateConversation] Error: ${error.message}`);
      throw new RpcException(error.message);
    }
  }

  @MessagePattern('get_messages')
  async handleGetMessages(
    @Payload()
    data: {
      conversationId: string;
      userId: string;
      limit?: number;
      cursor?: string;
    },
  ) {
    try {
      return await this.getMessagesUseCase.execute(
        data.conversationId,
        data.userId,
        Number(data.limit),
        data.cursor,
      );
    } catch (err: unknown) {
      const error = err as Error;
      this.logger.error(`❌ [GetMessages] Error: ${error.message}`);
      throw new RpcException(error.message);
    }
  }

  @MessagePattern('get_messages_around')
  async handleGetMessagesAround(
    @Payload()
    data: {
      conversationId: string;
      userId: string;
      messageId: string;
      before?: number;
      after?: number;
    },
  ): Promise<MessageAnchorWindowResponse> {
    try {
      const result = await this.getMessagesAroundUseCase.execute(
        data.conversationId,
        data.userId,
        data.messageId,
        Number(data.before) || 30,
        Number(data.after) || 30,
      );

      return {
        targetMessageId: result.targetMessageId,
        messages: result.messages.map((message) => ChatMapper.toDto(message)),
        hasOlder: result.hasOlder,
        hasNewer: result.hasNewer,
        ...(result.oldestCursor ? { oldestCursor: result.oldestCursor } : {}),
        ...(result.newestCursor ? { newestCursor: result.newestCursor } : {}),
      };
    } catch (err: unknown) {
      const error = err as Error;
      this.logger.error(`❌ [GetMessagesAround] Error: ${error.message}`);
      throw new RpcException(error.message);
    }
  }

  @MessagePattern('get_anchor_older_messages')
  async handleGetAnchorOlderMessages(
    @Payload()
    data: {
      conversationId: string;
      userId: string;
      cursor: string;
      limit?: number;
    },
  ): Promise<MessageAnchorExpansionResponse> {
    try {
      const result = await this.getAnchorOlderMessagesUseCase.execute(
        data.conversationId,
        data.userId,
        data.cursor,
        Number(data.limit) || 30,
      );

      return {
        messages: result.messages.map((message) => ChatMapper.toDto(message)),
        hasMore: result.hasMore,
        ...(result.nextCursor ? { nextCursor: result.nextCursor } : {}),
      };
    } catch (err: unknown) {
      const error = err as Error;
      this.logger.error(`❌ [GetAnchorOlderMessages] Error: ${error.message}`);
      throw new RpcException(error.message);
    }
  }

  @MessagePattern('get_anchor_newer_messages')
  async handleGetAnchorNewerMessages(
    @Payload()
    data: {
      conversationId: string;
      userId: string;
      cursor: string;
      limit?: number;
    },
  ): Promise<MessageAnchorExpansionResponse> {
    try {
      const result = await this.getAnchorNewerMessagesUseCase.execute(
        data.conversationId,
        data.userId,
        data.cursor,
        Number(data.limit) || 30,
      );

      return {
        messages: result.messages.map((message) => ChatMapper.toDto(message)),
        hasMore: result.hasMore,
        ...(result.nextCursor ? { nextCursor: result.nextCursor } : {}),
      };
    } catch (err: unknown) {
      const error = err as Error;
      this.logger.error(`❌ [GetAnchorNewerMessages] Error: ${error.message}`);
      throw new RpcException(error.message);
    }
  }

  @MessagePattern('get_conversation_detail')
  async handleGetConversation(@Payload() data: { id: string; userId: string }) {
    try {
      return await this.getConversationUseCase.execute(data.id, data.userId);
    } catch (err: unknown) {
      const error = err as Error;
      this.logger.error(`❌ [GetConversation] Error: ${error.message}`);
      throw new RpcException(error.message);
    }
  }

  @MessagePattern('update_group_conversation')
  async handleUpdateGroupConversation(
    @Payload()
    data: {
      conversationId: string;
      actorUserId: string;
      name?: string;
      picture?: string | null;
    },
  ) {
    try {
      const conversation =
        await this.manageGroupConversationUseCase.updateMetadata(data);
      this.chatGateway.emitConversationUpdated(conversation);
      return ChatMapper.conversationToDto(conversation);
    } catch (err: unknown) {
      const error = err as Error;
      this.logger.error(`❌ [UpdateGroupConversation] Error: ${error.message}`);
      throw new RpcException(error.message);
    }
  }

  @MessagePattern('transfer_group_ownership')
  async handleTransferGroupOwnership(
    @Payload()
    data: {
      conversationId: string;
      actorUserId: string;
      userId: string;
    },
  ) {
    try {
      const conversation =
        await this.manageGroupConversationUseCase.transferOwnership(data);
      this.chatGateway.emitConversationUpdated(conversation);
      return ChatMapper.conversationToDto(conversation);
    } catch (err: unknown) {
      const error = err as Error;
      this.logger.error('❌ [TransferGroupOwnership] Error: ' + error.message);
      throw new RpcException(error.message);
    }
  }

  @MessagePattern('add_conversation_member')
  async handleAddConversationMember(
    @Payload()
    data: {
      conversationId: string;
      actorUserId: string;
      userId: string;
    },
  ) {
    try {
      const memberUserId = data.userId.trim();
      const { conversation, added } =
        await this.manageGroupConversationUseCase.addMember(data);

      if (added) {
        this.chatGateway.emitConversationCreated(conversation, [memberUserId]);
        this.chatGateway.emitConversationUpdated(
          conversation,
          conversation.participantIds.filter(
            (participantId) => participantId !== memberUserId,
          ),
        );
      }

      return ChatMapper.conversationToDto(conversation);
    } catch (err: unknown) {
      const error = err as Error;
      this.logger.error(`❌ [AddConversationMember] Error: ${error.message}`);
      throw new RpcException(error.message);
    }
  }

  @MessagePattern('remove_conversation_member')
  async handleRemoveConversationMember(
    @Payload()
    data: {
      conversationId: string;
      actorUserId: string;
      userId: string;
    },
  ) {
    try {
      const removedUserId = data.userId.trim();
      const conversation =
        await this.manageGroupConversationUseCase.removeMember(data);

      this.chatGateway.evictConversationMember({
        conversationId: data.conversationId,
        userId: removedUserId,
        reason: 'removed',
      });
      this.chatGateway.emitConversationUpdated(conversation);

      return ChatMapper.conversationToDto(conversation);
    } catch (err: unknown) {
      const error = err as Error;
      this.logger.error(
        `❌ [RemoveConversationMember] Error: ${error.message}`,
      );
      throw new RpcException(error.message);
    }
  }

  @MessagePattern('leave_group_conversation')
  async handleLeaveGroupConversation(
    @Payload() data: { conversationId: string; actorUserId: string },
  ) {
    try {
      const conversation =
        await this.manageGroupConversationUseCase.leave(data);

      this.chatGateway.evictConversationMember({
        conversationId: data.conversationId,
        userId: data.actorUserId,
        reason: 'left',
      });
      this.chatGateway.emitConversationUpdated(conversation);

      return ChatMapper.conversationToDto(conversation);
    } catch (err: unknown) {
      const error = err as Error;
      this.logger.error(`❌ [LeaveGroupConversation] Error: ${error.message}`);
      throw new RpcException(error.message);
    }
  }

  @MessagePattern('create_message')
  async handleCreateMessage(
    @Payload() data: CreateMessageDto & { senderId: string },
  ): Promise<CreateMessageResponse> {
    try {
      const { senderId, ...dto } = data;
      const result = await this.sendMessageUseCase.execute(dto, senderId);
      const savedMessage = result.message;

      // A retry must get the original message back, but it must not fan out
      // another socket event, notification, or bot invocation.
      if (!result.created) {
        return {
          message: ChatMapper.toDto(savedMessage),
          created: false,
        };
      }

      this.chatGateway.emitToConversation(
        dto.conversationId,
        'new_message',
        ChatMapper.toDto(savedMessage),
      );

      const conversation = result.conversation
        ? await this.chatRepository.populateConversationParticipants(
            result.conversation,
          )
        : await this.chatRepository.findConversation(dto.conversationId);
      if (conversation) {
        conversation.lastMessage =
          savedMessage.content ?? savedMessage.type ?? null;
        conversation.lastMessageAt = savedMessage.createdAt;
        this.chatGateway.emitToConversation(
          dto.conversationId,
          'conversation_updated',
          ChatMapper.conversationToDto(conversation),
        );
        this.chatGateway.emitConversationMessageActivity(
          conversation,
          savedMessage,
          senderId,
        );
      }

      void this.notificationService.notifyNewMessage(
        conversation,
        savedMessage,
        senderId,
      );

      void this.triggerBotReplyUseCase.execute(savedMessage, senderId).then(
        async (result) => {
          if (result.botReply) {
            this.chatGateway.emitToConversation(
              savedMessage.conversationId,
              'new_message',
              ChatMapper.toDto(result.botReply),
            );

            // Update conversation sidebar with bot reply as lastMessage
            const conversation = await this.chatRepository.findConversation(
              savedMessage.conversationId,
            );
            if (conversation) {
              conversation.lastMessage =
                result.botReply.content ?? result.botReply.type ?? null;
              conversation.lastMessageAt = result.botReply.createdAt;
              this.chatGateway.emitToConversation(
                savedMessage.conversationId,
                'conversation_updated',
                ChatMapper.conversationToDto(conversation),
              );
              this.chatGateway.emitConversationMessageActivity(
                conversation,
                result.botReply,
                result.botReply.senderId,
              );
            }
          } else if (result.botError) {
            this.chatGateway.emitBotReplyFailure(savedMessage, result.botError);
          }
        },
        (err) => {
          this.logger.warn(
            `Bot reply trigger failed: ${(err as Error).message}`,
          );
          this.chatGateway.emitBotReplyFailure(savedMessage, {
            code: 'UNKNOWN',
            message: 'AI service is temporarily unavailable',
          });
        },
      );

      return {
        message: ChatMapper.toDto(savedMessage),
        created: true,
      };
    } catch (err: unknown) {
      const error = err as Error;
      this.logger.error(`❌ [CreateMessage] Error: ${error.message}`);
      throw new RpcException(error.message);
    }
  }

  @MessagePattern('mark_conversation_seen')
  async handleMarkConversationSeen(
    @Payload() data: { conversationId: string; userId: string },
  ) {
    try {
      return {
        updatedCount: (
          await this.chatRepository.markMessagesAsSeen(
            data.conversationId,
            data.userId,
          )
        ).updatedCount,
      };
    } catch (err: unknown) {
      const error = err as Error;
      this.logger.error(`❌ [MarkConversationSeen] Error: ${error.message}`);
      throw new RpcException(error.message);
    }
  }

  @MessagePattern('get_user_conversations')
  async handleGetUserConversations(
    @Payload() data: { userId: string; limit?: number; cursor?: string },
  ) {
    try {
      return await this.getUserConversationsUseCase.execute(
        data.userId,
        Number(data.limit),
        data.cursor,
      );
    } catch (err: unknown) {
      const error = err as Error;
      this.logger.error(error.message);
      throw new RpcException(error.message);
    }
  }

  @MessagePattern('add_reaction')
  async handleAddReaction(
    @Payload() data: { messageId: string; userId: string; emoji: string },
  ) {
    try {
      const message = await this.chatRepository.addReaction(
        data.messageId,
        data.userId,
        data.emoji,
      );

      this.chatGateway.emitToConversation(
        message.conversationId,
        'message_reaction_updated',
        message,
      );

      return message;
    } catch (err: unknown) {
      const error = err as Error;
      this.logger.error(`❌ [AddReaction] Error: ${error.message}`);
      throw new RpcException(error.message);
    }
  }

  @MessagePattern('remove_reaction')
  async handleRemoveReaction(
    @Payload() data: { messageId: string; userId: string },
  ) {
    try {
      const message = await this.chatRepository.removeReaction(
        data.messageId,
        data.userId,
      );

      this.chatGateway.emitToConversation(
        message.conversationId,
        'message_reaction_updated',
        message,
      );

      return message;
    } catch (err: unknown) {
      const error = err as Error;
      this.logger.error(`❌ [RemoveReaction] Error: ${error.message}`);
      throw new RpcException(error.message);
    }
  }

  @MessagePattern('recall_message')
  async handleRecallMessage(
    @Payload() data: { messageId: string; userId: string },
  ) {
    try {
      const result = await this.chatRepository.recallMessage(
        data.messageId,
        data.userId,
      );

      this.chatGateway.emitToConversation(
        result.message.conversationId,
        'message_recalled',
        {
          messageId: result.message.id,
          conversationId: result.message.conversationId,
          recalledAt: result.message.recalledAt,
        },
      );

      if (result.updatedReplyMessageIds.length > 0) {
        this.chatGateway.emitToConversation(
          result.message.conversationId,
          'reply_previews_updated',
          {
            updatedMessageIds: result.updatedReplyMessageIds,
            previewContent: result.previewContent,
          },
        );
      }

      const conversation = await this.chatRepository.findConversation(
        result.message.conversationId,
      );

      if (conversation?.participantIds?.length) {
        this.chatGateway.emitConversationUpdated(conversation);
      }

      return result.message;
    } catch (err: unknown) {
      const error = err as Error;
      this.logger.error(`❌ [RecallMessage] Error: ${error.message}`);
      throw new RpcException(error.message);
    }
  }

  @EventPattern('media.video_processing_completed')
  async handleMediaProcessingCompleted(
    @Payload() data: CompletedVideoProcessingPayload,
  ) {
    try {
      const result = await this.chatRepository.syncMediaProcessingResult(
        data.fileKey,
        data.media,
      );

      if (result.discardedBecauseRecalled) {
        await this.chatMediaService.deleteRecalledChatMedia({
          userId: data.userId,
          fileKeys: [
            data.fileKey,
            data.media.fileKey,
            data.media.thumbnailKey,
          ].filter((key): key is string => Boolean(key)),
        });
        return;
      }

      result.conversationIds.forEach((conversationId) => {
        this.chatGateway.emitMediaProcessingCompleted(conversationId, {
          fileKey: data.fileKey,
          messageIds: result.messageIds,
          media: result.media,
        });
      });
    } catch (err: unknown) {
      const error = err as Error;
      this.logger.error(
        `❌ [MediaProcessingCompleted] Error: ${error.message}`,
      );
    }
  }

  @EventPattern('media.video_processing_failed')
  async handleMediaProcessingFailed(
    @Payload() data: FailedVideoProcessingPayload,
  ) {
    try {
      const result = await this.chatRepository.syncMediaProcessingResult(
        data.fileKey,
        data.media,
      );

      if (result.discardedBecauseRecalled) {
        await this.chatMediaService.deleteRecalledChatMedia({
          userId: data.userId,
          fileKeys: [
            data.fileKey,
            data.media.fileKey,
            data.media.thumbnailKey,
          ].filter((key): key is string => Boolean(key)),
        });
        return;
      }

      result.conversationIds.forEach((conversationId) => {
        this.chatGateway.emitMediaProcessingFailed(conversationId, {
          fileKey: data.fileKey,
          messageIds: result.messageIds,
          media: result.media,
        });
      });
    } catch (err: unknown) {
      const error = err as Error;
      this.logger.error(`❌ [MediaProcessingFailed] Error: ${error.message}`);
    }
  }

  @EventPattern('ai.stream_token')
  handleStreamToken(
    @Payload() data: { conversationId: string; userId: string; token: string },
  ): void {
    this.logger.debug(
      `[AI_STREAM_TOKEN] conversation=${data.conversationId} tokenLength=${data.token.length}`,
    );

    this.chatGateway.emitToConversation(data.conversationId, 'bot_token', {
      conversationId: data.conversationId,
      token: data.token,
    });
  }
}
