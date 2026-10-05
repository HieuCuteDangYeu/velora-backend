import { Inject, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/conversation-client';
import Redis from 'ioredis';

import { Conversation } from '../../domain/entities/conversation.entity';
import type { IChatMediaService } from '../../domain/interfaces/chat-media.service.interface';
import type { IConversationMutationRepository } from '../../domain/interfaces/conversation-mutation.repository.interface';
import type { IEncryptionRepository } from '../../domain/interfaces/encryption.repository.interface';
import type { IUserService } from '../../domain/interfaces/user-service.interface';
import { ConversationPrometheusMetricsService } from '../metrics/conversation-prometheus-metrics.service';
import { PrismaService } from '../prisma/prisma.service';
import { ConversationMapper } from './conversation.mapper';
import { PrismaChatRepository } from './prisma-chat.repository';

const MEMBERSHIP_CAS_MAX_ATTEMPTS = 8;

type ProjectionChange =
  | {
      kind: 'created';
      actorUserId: string;
    }
  | {
      kind: 'added';
      actorUserId: string;
      userId: string;
    }
  | {
      kind: 'removed';
      actorUserId?: string;
      userId: string;
      at: Date;
    }
  | {
      kind: 'left';
      userId: string;
      at: Date;
    }
  | {
      kind: 'ownership-transferred';
    };

const normalizeMemberJoinedAt = (
  value: Prisma.JsonValue | null | undefined,
  participantIds: string[],
  fallbackJoinedAt: Date,
): Record<string, string> => {
  const result: Record<string, string> = {};

  if (value && typeof value === 'object' && !Array.isArray(value)) {
    Object.entries(value).forEach(([userId, joinedAt]) => {
      if (typeof joinedAt === 'string' && joinedAt.trim()) {
        result[userId] = joinedAt;
      }
    });
  }

  const fallback = fallbackJoinedAt.toISOString();
  participantIds.forEach((participantId) => {
    if (!result[participantId]) {
      result[participantId] = fallback;
    }
  });

  return result;
};

type MembershipSnapshot = {
  creatorId: string;
  participantIds: string[];
  memberJoinedAt: Prisma.JsonValue | null;
  createdAt: Date;
};

@Injectable()
export class PrismaConversationChatRepository
  extends PrismaChatRepository
  implements IConversationMutationRepository
{
  private readonly projectionLogger = new Logger(
    PrismaConversationChatRepository.name,
  );

  constructor(
    private readonly conversationPrisma: PrismaService,
    @Inject('REDIS_CLIENT') redis: Redis,
    @Inject('IEncryptionRepository')
    encryptionRepository: IEncryptionRepository,
    @Inject('IUserService') userService: IUserService,
    @Inject('IChatMediaService') chatMediaService: IChatMediaService,
    metrics?: ConversationPrometheusMetricsService,
  ) {
    super(
      conversationPrisma,
      redis,
      encryptionRepository,
      userService,
      chatMediaService,
      metrics,
    );
  }

  override async createConversation(
    conversation: Conversation,
  ): Promise<Conversation> {
    const savedConversation = await this.conversationPrisma.conversation.create(
      {
        data: {
          creatorId: conversation.creatorId,
          participantIds: conversation.participantIds,
          name: conversation.name ?? null,
          picture: conversation.picture ?? null,
          memberJoinedAt: conversation.memberJoinedAt
            ? (conversation.memberJoinedAt as Prisma.InputJsonValue)
            : null,
          createdAt: conversation.createdAt,
          updatedAt: conversation.updatedAt,
          isGroup: conversation.isGroup,
          lastMessage: conversation.lastMessage || null,
          lastMessageAt: conversation.lastMessageAt || null,
        },
      },
    );

    if (savedConversation.isGroup) {
      await this.syncGroupMemberProjection(savedConversation.id, {
        kind: 'created',
        actorUserId: savedConversation.creatorId,
      });
    }

    return ConversationMapper.toDomain(savedConversation);
  }

  async updateMetadataAsOwner(
    conversationId: string,
    currentOwnerUserId: string,
    patch: { name?: string; picture?: string | null },
  ): Promise<boolean> {
    const result = await this.conversationPrisma.conversation.updateMany({
      where: {
        id: conversationId,
        creatorId: currentOwnerUserId,
        isGroup: true,
      },
      data: {
        ...(patch.name !== undefined ? { name: patch.name } : {}),
        ...(patch.picture !== undefined ? { picture: patch.picture } : {}),
      },
    });

    return result.count === 1;
  }

  async addParticipantAsOwner(
    conversationId: string,
    currentOwnerUserId: string,
    userId: string,
    joinedAt: Date,
  ): Promise<boolean> {
    for (let attempt = 0; attempt < MEMBERSHIP_CAS_MAX_ATTEMPTS; attempt += 1) {
      const conversation = await this.findMembershipSnapshot(conversationId);

      if (conversation.creatorId !== currentOwnerUserId) {
        return false;
      }

      if (conversation.participantIds.includes(userId)) {
        return false;
      }

      const participantIds = [...conversation.participantIds, userId];
      const memberJoinedAt = normalizeMemberJoinedAt(
        conversation.memberJoinedAt,
        conversation.participantIds,
        conversation.createdAt,
      );
      memberJoinedAt[userId] = joinedAt.toISOString();

      const updated = await this.compareAndSetMembership(
        conversationId,
        conversation.participantIds,
        participantIds,
        memberJoinedAt,
        { creatorId: currentOwnerUserId },
      );

      if (updated) {
        await this.syncGroupMemberProjection(conversationId, {
          kind: 'added',
          actorUserId: currentOwnerUserId,
          userId,
        });
        return true;
      }
    }

    return false;
  }

  async transferOwnership(
    conversationId: string,
    currentOwnerUserId: string,
    newOwnerUserId: string,
  ): Promise<boolean> {
    const result = await this.conversationPrisma.conversation.updateMany({
      where: {
        id: conversationId,
        creatorId: currentOwnerUserId,
        participantIds: { has: newOwnerUserId },
      },
      data: { creatorId: newOwnerUserId },
    });

    if (result.count === 1) {
      await this.syncGroupMemberProjection(conversationId, {
        kind: 'ownership-transferred',
      });
      return true;
    }

    return false;
  }

  async removeParticipantAsOwner(
    conversationId: string,
    currentOwnerUserId: string,
    userId: string,
  ): Promise<boolean> {
    for (let attempt = 0; attempt < MEMBERSHIP_CAS_MAX_ATTEMPTS; attempt += 1) {
      const conversation = await this.findMembershipSnapshot(conversationId);

      if (
        conversation.creatorId !== currentOwnerUserId ||
        !conversation.participantIds.includes(userId) ||
        conversation.participantIds.length <= 2
      ) {
        return false;
      }

      const participantIds = conversation.participantIds.filter(
        (participantId) => participantId !== userId,
      );
      const memberJoinedAt = normalizeMemberJoinedAt(
        conversation.memberJoinedAt,
        conversation.participantIds,
        conversation.createdAt,
      );
      delete memberJoinedAt[userId];

      const updated = await this.compareAndSetMembership(
        conversationId,
        conversation.participantIds,
        participantIds,
        memberJoinedAt,
        { creatorId: currentOwnerUserId },
      );

      if (updated) {
        await this.syncGroupMemberProjection(conversationId, {
          kind: 'removed',
          actorUserId: currentOwnerUserId,
          userId,
          at: new Date(),
        });
        return true;
      }
    }

    return false;
  }

  async removeParticipantAsMember(
    conversationId: string,
    userId: string,
  ): Promise<boolean> {
    for (let attempt = 0; attempt < MEMBERSHIP_CAS_MAX_ATTEMPTS; attempt += 1) {
      const conversation = await this.findMembershipSnapshot(conversationId);

      if (
        conversation.creatorId === userId ||
        !conversation.participantIds.includes(userId) ||
        conversation.participantIds.length <= 2
      ) {
        return false;
      }

      const participantIds = conversation.participantIds.filter(
        (participantId) => participantId !== userId,
      );
      const memberJoinedAt = normalizeMemberJoinedAt(
        conversation.memberJoinedAt,
        conversation.participantIds,
        conversation.createdAt,
      );
      delete memberJoinedAt[userId];

      const updated = await this.compareAndSetMembership(
        conversationId,
        conversation.participantIds,
        participantIds,
        memberJoinedAt,
        { creatorId: { not: userId } },
      );

      if (updated) {
        await this.syncGroupMemberProjection(conversationId, {
          kind: 'left',
          userId,
          at: new Date(),
        });
        return true;
      }
    }

    return false;
  }

  async removeParticipant(
    conversationId: string,
    userId: string,
  ): Promise<void> {
    for (let attempt = 0; attempt < MEMBERSHIP_CAS_MAX_ATTEMPTS; attempt += 1) {
      const conversation = await this.findMembershipSnapshot(conversationId);

      if (!conversation.participantIds.includes(userId)) {
        return;
      }

      const participantIds = conversation.participantIds.filter(
        (participantId) => participantId !== userId,
      );
      const memberJoinedAt = normalizeMemberJoinedAt(
        conversation.memberJoinedAt,
        conversation.participantIds,
        conversation.createdAt,
      );
      delete memberJoinedAt[userId];

      const updated = await this.compareAndSetMembership(
        conversationId,
        conversation.participantIds,
        participantIds,
        memberJoinedAt,
      );

      if (updated) {
        await this.syncGroupMemberProjection(conversationId, {
          kind: 'removed',
          userId,
          at: new Date(),
        });
        return;
      }
    }
  }

  private async findMembershipSnapshot(
    conversationId: string,
  ): Promise<MembershipSnapshot> {
    const conversation = await this.conversationPrisma.conversation.findUnique({
      where: { id: conversationId },
      select: {
        creatorId: true,
        participantIds: true,
        memberJoinedAt: true,
        createdAt: true,
      },
    });

    if (!conversation) {
      throw new NotFoundException('Conversation not found');
    }

    return conversation;
  }

  private async compareAndSetMembership(
    conversationId: string,
    expectedParticipantIds: string[],
    participantIds: string[],
    memberJoinedAt: Record<string, string>,
    extraWhere: Prisma.ConversationWhereInput = {},
  ): Promise<boolean> {
    const result = await this.conversationPrisma.conversation.updateMany({
      where: {
        id: conversationId,
        participantIds: { equals: expectedParticipantIds },
        ...extraWhere,
      },
      data: {
        participantIds: { set: participantIds },
        memberJoinedAt: memberJoinedAt,
      },
    });

    return result.count === 1;
  }

  private async syncGroupMemberProjection(
    conversationId: string,
    change: ProjectionChange,
  ): Promise<void> {
    // During the rolling V2 migration the legacy Conversation document remains
    // authoritative. Projection failures must therefore not turn a successful
    // V1 mutation into an apparent client failure; the audit/backfill command
    // detects and repairs projection drift before cutover.
    try {
      const memberRepository = this.conversationPrisma.conversationMember;
      if (!memberRepository) {
        return;
      }

      const conversation =
        await this.conversationPrisma.conversation.findUnique({
          where: { id: conversationId },
          select: {
            creatorId: true,
            participantIds: true,
            memberJoinedAt: true,
            createdAt: true,
            isGroup: true,
          },
        });

      if (!conversation?.isGroup) {
        return;
      }

      const participantIds = Array.from(new Set(conversation.participantIds));
      const participantSet = new Set(participantIds);
      const joinedAtByUserId = normalizeMemberJoinedAt(
        conversation.memberJoinedAt,
        participantIds,
        conversation.createdAt,
      );
      const existingMembers = await memberRepository.findMany({
        where: { conversationId },
      });
      const existingByUserId = new Map(
        existingMembers.map((member) => [member.userId, member]),
      );

      for (const userId of participantIds) {
        const existing = existingByUserId.get(userId);
        const role =
          userId === conversation.creatorId
            ? 'OWNER'
            : existing?.status === 'ACTIVE' && existing.role === 'ADMIN'
              ? 'ADMIN'
              : 'MEMBER';
        const invitedBy =
          change.kind === 'created' && userId !== conversation.creatorId
            ? change.actorUserId
            : change.kind === 'added' && userId === change.userId
              ? change.actorUserId
              : (existing?.invitedBy ?? null);

        await memberRepository.upsert({
          where: {
            conversationId_userId: {
              conversationId,
              userId,
            },
          },
          create: {
            conversationId,
            userId,
            role,
            status: 'ACTIVE',
            joinedAt: new Date(joinedAtByUserId[userId]),
            ...(invitedBy ? { invitedBy } : {}),
          },
          update: {
            role,
            status: 'ACTIVE',
            joinedAt: new Date(joinedAtByUserId[userId]),
            leftAt: null,
            removedBy: null,
            ...(invitedBy ? { invitedBy } : {}),
          },
        });
      }

      for (const existing of existingMembers) {
        if (
          participantSet.has(existing.userId) ||
          existing.status !== 'ACTIVE'
        ) {
          continue;
        }

        const isExplicitLeave =
          change.kind === 'left' && change.userId === existing.userId;
        const isExplicitRemoval =
          change.kind === 'removed' && change.userId === existing.userId;

        await memberRepository.update({
          where: { id: existing.id },
          data: {
            role: existing.role === 'OWNER' ? 'MEMBER' : existing.role,
            status: isExplicitLeave ? 'LEFT' : 'REMOVED',
            ...(isExplicitLeave ? { leftAt: change.at } : { leftAt: null }),
            ...(isExplicitRemoval && change.actorUserId
              ? { removedBy: change.actorUserId }
              : { removedBy: null }),
          },
        });
      }
    } catch (error) {
      this.projectionLogger.warn(
        `ConversationMember projection sync failed for ${conversationId}: ${(error as Error).message}`,
      );
    }
  }
}
