import { randomUUID } from 'node:crypto';
import { Inject, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import { Conversation } from '../../domain/entities/conversation.entity';
import {
  Message,
  type GroupSystemActivity,
  type GroupSystemActivityType,
} from '../../domain/entities/message.entity';
import { IChatRepository } from '../../domain/interfaces/chat.repository.interface';
import { IConversationRealtimePublisher } from '../../domain/interfaces/conversation-realtime-publisher.interface';

export type PublishGroupActivityInput = {
  conversationId: string;
  type: GroupSystemActivityType;
  actorUserId: string;
  actorName?: string;
  targetUserId?: string;
  targetName?: string;
  previousValue?: string | null;
  nextValue?: string | null;
};

@Injectable()
export class GroupActivityService {
  private readonly logger = new Logger(GroupActivityService.name);

  constructor(
    @Inject('IChatRepository')
    private readonly chatRepository: IChatRepository,
    @Inject('IConversationRealtimePublisher')
    private readonly realtimePublisher: IConversationRealtimePublisher,
    private readonly configService: ConfigService,
  ) {}

  publish(input: PublishGroupActivityInput): void {
    if (!this.isEnabled()) {
      return;
    }

    void this.persistAndPublish(input).catch((error) => {
      this.logger.warn(
        `Group activity ${input.type} failed for ${input.conversationId}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    });
  }

  private async persistAndPublish(
    input: PublishGroupActivityInput,
  ): Promise<void> {
    const conversation = await this.chatRepository.findConversation(
      input.conversationId,
    );

    if (!conversation?.isGroup || conversation.participantIds.length === 0) {
      return;
    }

    const senderId = conversation.participantIds.includes(input.actorUserId)
      ? input.actorUserId
      : conversation.creatorId;
    const actorName =
      input.actorName?.trim() ||
      this.displayName(conversation, input.actorUserId) ||
      undefined;
    const targetName = input.targetUserId
      ? input.targetName?.trim() ||
        this.displayName(conversation, input.targetUserId) ||
        undefined
      : input.targetName?.trim() || undefined;
    const activity: GroupSystemActivity = {
      type: input.type,
      actorUserId: input.actorUserId,
      ...(actorName ? { actorName } : {}),
      ...(input.targetUserId ? { targetUserId: input.targetUserId } : {}),
      ...(targetName ? { targetName } : {}),
      ...(input.previousValue !== undefined
        ? { previousValue: input.previousValue }
        : {}),
      ...(input.nextValue !== undefined ? { nextValue: input.nextValue } : {}),
    };
    const content = this.buildContent(activity);
    const message = new Message({
      conversationId: input.conversationId,
      senderId,
      clientMessageId: `system:${input.type}:${randomUUID()}`,
      content,
      type: 'text',
      metadata: {
        kind: 'group_system_activity',
        groupActivity: activity,
      },
      createdAt: new Date(),
      readBy: [],
    });

    const result = await this.chatRepository.createMessageIdempotently(message);
    if (!result.created) {
      return;
    }

    this.realtimePublisher.emitNewMessage(input.conversationId, result.message);

    const updatedConversation = await this.chatRepository.findConversation(
      input.conversationId,
    );
    if (updatedConversation) {
      this.realtimePublisher.emitConversationUpdated(updatedConversation);
    }
  }

  private displayName(
    conversation: Conversation,
    userId: string,
  ): string | null {
    const participant = conversation.participants?.find(
      (candidate) => candidate.id === userId,
    );

    return (
      participant?.name?.trim() ||
      participant?.fullName?.trim() ||
      participant?.email?.split('@')[0]?.trim() ||
      null
    );
  }

  private buildContent(activity: GroupSystemActivity): string {
    const actor = activity.actorName?.trim() || 'A member';
    const target = activity.targetName?.trim() || 'a member';

    switch (activity.type) {
      case 'GROUP_CREATED':
        return `${actor} created the group`;
      case 'MEMBER_ADDED':
        return `${actor} added ${target}`;
      case 'MEMBER_LEFT':
        return `${actor} left the group`;
      case 'MEMBER_REMOVED':
        return `${actor} removed ${target}`;
      case 'MEMBER_PROMOTED':
        return `${actor} made ${target} an admin`;
      case 'MEMBER_DEMOTED':
        return `${actor} removed ${target} as admin`;
      case 'OWNERSHIP_TRANSFERRED':
        return `${actor} transferred ownership to ${target}`;
      case 'GROUP_RENAMED':
        return activity.nextValue?.trim()
          ? `${actor} renamed the group to ${activity.nextValue.trim()}`
          : `${actor} renamed the group`;
      case 'GROUP_PICTURE_CHANGED':
        return activity.nextValue
          ? `${actor} changed the group photo`
          : `${actor} removed the group photo`;
    }
  }

  private isEnabled(): boolean {
    const value = this.configService.get<string>(
      'GROUP_V2_SYSTEM_ACTIVITIES_ENABLED',
      'false',
    );
    return ['1', 'true', 'yes', 'on'].includes(
      String(value).trim().toLowerCase(),
    );
  }
}
