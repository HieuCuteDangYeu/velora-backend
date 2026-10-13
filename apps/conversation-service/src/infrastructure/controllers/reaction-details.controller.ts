import type { MessageReactionDetailsDto } from '@common/conversation/dtos/message-reaction-details.dto';
import type { ValidateUserResponse } from '@common/user/interfaces/validate-user-response.types';
import {
  BadRequestException,
  Controller,
  Inject,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { MessagePattern, Payload } from '@nestjs/microservices';
import type { IChatRepository } from '../../domain/interfaces/chat.repository.interface';
import type { IUserService } from '../../domain/interfaces/user-service.interface';
import { PrismaService } from '../prisma/prisma.service';
import { toRpcException } from '../rpc/to-rpc-exception';

type StoredReaction = {
  emoji: string;
  createdAt: string;
};

@Controller()
export class ReactionDetailsMicroserviceController {
  private readonly logger = new Logger(
    ReactionDetailsMicroserviceController.name,
  );

  constructor(
    private readonly prisma: PrismaService,
    @Inject('IChatRepository')
    private readonly chatRepository: IChatRepository,
    @Inject('IUserService')
    private readonly userService: IUserService,
  ) {}

  @MessagePattern('get_reaction_details')
  async handleGetReactionDetails(
    @Payload() data: { messageId: string; userId: string },
  ): Promise<MessageReactionDetailsDto> {
    try {
      if (!/^[0-9a-fA-F]{24}$/.test(data.messageId)) {
        throw new BadRequestException('Invalid message ID');
      }

      const message = await this.prisma.message.findUnique({
        where: { id: data.messageId },
        select: {
          id: true,
          conversationId: true,
          isRecalled: true,
          reactions: true,
        },
      });

      if (!message) {
        throw new NotFoundException('Message not found');
      }

      await this.chatRepository.assertConversationParticipant(
        message.conversationId,
        data.userId,
      );

      const reactions = message.isRecalled
        ? {}
        : this.normalizeReactions(message.reactions);
      const entries = Object.entries(reactions);
      const actorIds = entries.map(([userId]) => userId);
      const users = await this.resolveUsers(actorIds);
      const userById = new Map(users.map((user) => [user.id, user]));

      return {
        messageId: message.id,
        conversationId: message.conversationId,
        total: entries.length,
        reactions: entries.map(([userId, reaction]) => {
          const user = userById.get(userId);

          return {
            userId,
            emoji: reaction.emoji,
            createdAt: reaction.createdAt,
            user: user
              ? {
                  id: user.id,
                  ...(user.fullName !== undefined
                    ? { fullName: user.fullName ?? null }
                    : {}),
                  ...(user.username !== undefined
                    ? { username: user.username ?? null }
                    : {}),
                  ...(user.picture !== undefined
                    ? { picture: user.picture ?? null }
                    : {}),
                }
              : null,
          };
        }),
      };
    } catch (error: unknown) {
      const resolved = error as Error;
      this.logger.error(`❌ [ReactionDetails] Error: ${resolved.message}`);
      throw toRpcException(error);
    }
  }

  private normalizeReactions(value: unknown): Record<string, StoredReaction> {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      return {};
    }

    const normalized: Record<string, StoredReaction> = {};
    for (const [userId, raw] of Object.entries(
      value as Record<string, unknown>,
    )) {
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
        continue;
      }

      const emoji = (raw as Record<string, unknown>).emoji;
      const createdAt = (raw as Record<string, unknown>).createdAt;
      if (typeof emoji !== 'string' || typeof createdAt !== 'string') {
        continue;
      }

      normalized[userId] = { emoji, createdAt };
    }

    return normalized;
  }

  private async resolveUsers(ids: string[]): Promise<ValidateUserResponse[]> {
    if (ids.length === 0) {
      return [];
    }

    const response = await this.userService.findUsersByIds(ids);
    return Array.isArray(response) ? (response as ValidateUserResponse[]) : [];
  }
}
