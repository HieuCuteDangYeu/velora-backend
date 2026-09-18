import type { MessageDto } from '@common/conversation/dtos/message.dto';
import {
  MessageReadStatus,
  Prisma,
  Message as PrismaMessage,
} from '@prisma/conversation-client';
import { Conversation } from '../../domain/entities/conversation.entity';
import {
  Message,
  MessageMetadata,
  RECALLED_MESSAGE_CONTENT,
  type MessageMedia,
  type MessageReactionMap,
  type MessageReplyPreview,
} from '../../domain/entities/message.entity';
import { ReadStatus } from '../../domain/entities/read-status.entity';

export class ChatMapper {
  static toDomain(
    prismaMsg: PrismaMessage & {
      media?: Prisma.JsonValue | null;
      metadata?: Prisma.JsonValue | null;
      readBy?: MessageReadStatus[];
      replyPreview?: Prisma.JsonValue | null;
      reactions?: Prisma.JsonValue | null;
    },
  ): Message {
    return new Message({
      id: prismaMsg.id,
      conversationId: prismaMsg.conversationId,
      senderId: prismaMsg.senderId,
      clientMessageId: prismaMsg.clientMessageId ?? undefined,
      type: prismaMsg.type,
      signalType: prismaMsg.signalType,
      content: prismaMsg.content,
      media: ChatMapper.toMedia(prismaMsg.media),
      metadata: ChatMapper.toMetadata(prismaMsg.metadata),
      registrationId: prismaMsg.registrationId ?? undefined,
      createdAt: prismaMsg.createdAt,
      isRecalled: prismaMsg.isRecalled,
      recalledAt: prismaMsg.recalledAt ?? undefined,
      replyToId: prismaMsg.replyToId ?? undefined,
      replyPreview: ChatMapper.toReplyPreview(prismaMsg.replyPreview),
      readBy: prismaMsg.readBy
        ? prismaMsg.readBy.map(
            (r) => new ReadStatus({ userId: r.userId, at: r.at }),
          )
        : [],
      reactions: ChatMapper.toReactionMap(prismaMsg.reactions),
    });
  }

  private static toMetadata(
    value: Prisma.JsonValue | null | undefined,
  ): MessageMetadata | undefined {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      return undefined;
    }

    return value;
  }

  private static toReactionMap(
    value: Prisma.JsonValue | null | undefined,
  ): MessageReactionMap | undefined {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      return undefined;
    }

    const entries = Object.entries(value as Record<string, unknown>)
      .map(([userId, reaction]) => {
        if (
          !reaction ||
          typeof reaction !== 'object' ||
          Array.isArray(reaction)
        ) {
          return null;
        }

        const emoji = (reaction as Record<string, unknown>).emoji;
        const createdAt = (reaction as Record<string, unknown>).createdAt;

        if (typeof emoji !== 'string' || typeof createdAt !== 'string') {
          return null;
        }

        return [userId, { emoji, createdAt }] as const;
      })
      .filter(
        (
          entry,
        ): entry is readonly [string, { emoji: string; createdAt: string }] =>
          entry !== null,
      );

    return entries.length > 0 ? Object.fromEntries(entries) : undefined;
  }

  private static toMedia(
    value: Prisma.JsonValue | null | undefined,
  ): MessageMedia | undefined {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      return undefined;
    }

    const record = value as Record<string, unknown>;

    const fileUrl = record.fileUrl;
    if (typeof fileUrl !== 'string' || !fileUrl) {
      return undefined;
    }

    const fileKey = record.fileKey;
    const thumbnailKey = record.thumbnailKey;
    const thumbnailUrl = record.thumbnailUrl;
    const mimeType = record.mimeType;
    const width = record.width;
    const height = record.height;
    const durationMs = record.durationMs;
    const status = record.status;
    const failureReason = record.failureReason;
    const reelId = record.reelId;
    const reelSourceOrientation = record.reelSourceOrientation;
    const reelSourceAspectRatio = record.reelSourceAspectRatio;
    const reelPlaybackPresentation = record.reelPlaybackPresentation;
    const reelOwnerId = record.reelOwnerId;
    const reelOwnerUsername = record.reelOwnerUsername;
    const reelOwnerAvatarUrl = record.reelOwnerAvatarUrl;
    const reelTitle = record.reelTitle;
    const reelDescription = record.reelDescription;
    const reelTags = ChatMapper.toStringArray(record.reelTags);

    return {
      ...(typeof fileKey === 'string' ? { fileKey } : {}),
      fileUrl,
      ...(typeof thumbnailKey === 'string' ? { thumbnailKey } : {}),
      ...(typeof thumbnailUrl === 'string' ? { thumbnailUrl } : {}),
      ...(typeof mimeType === 'string' ? { mimeType } : {}),
      ...(typeof width === 'number' ? { width } : {}),
      ...(typeof height === 'number' ? { height } : {}),
      ...(typeof durationMs === 'number' ? { durationMs } : {}),
      ...(status === 'ready' || status === 'processing' || status === 'failed'
        ? { status }
        : {}),
      ...(typeof failureReason === 'string' ? { failureReason } : {}),
      ...(typeof reelId === 'string' ? { reelId } : {}),
      ...(reelSourceOrientation === 'PORTRAIT' ||
      reelSourceOrientation === 'LANDSCAPE' ||
      reelSourceOrientation === 'SQUARE'
        ? { reelSourceOrientation }
        : {}),
      ...(typeof reelSourceAspectRatio === 'number'
        ? { reelSourceAspectRatio }
        : {}),
      ...(reelPlaybackPresentation === 'PORTRAIT_COVER' ||
      reelPlaybackPresentation === 'FIT_WITH_LETTERBOX'
        ? { reelPlaybackPresentation }
        : {}),
      ...(typeof reelOwnerId === 'string' ? { reelOwnerId } : {}),
      ...(typeof reelOwnerUsername === 'string' ? { reelOwnerUsername } : {}),
      ...(typeof reelOwnerAvatarUrl === 'string' ? { reelOwnerAvatarUrl } : {}),
      ...(typeof reelTitle === 'string' ? { reelTitle } : {}),
      ...(typeof reelDescription === 'string' ? { reelDescription } : {}),
      ...(reelTags !== undefined ? { reelTags } : {}),
    };
  }

  private static toStringArray(value: unknown): string[] | undefined {
    if (!Array.isArray(value)) {
      return undefined;
    }

    return value.filter(
      (item): item is string => typeof item === 'string' && item.length > 0,
    );
  }

  private static toReplyPreview(
    value: Prisma.JsonValue | null | undefined,
  ): MessageReplyPreview | undefined {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      return undefined;
    }

    const senderName = (value as Record<string, unknown>).senderName;
    const content = (value as Record<string, unknown>).content;
    const thumbnailUri = (value as Record<string, unknown>).thumbnailUri;
    const mediaWidth = (value as Record<string, unknown>).mediaWidth;
    const mediaHeight = (value as Record<string, unknown>).mediaHeight;
    const type = (value as Record<string, unknown>).type;

    if (
      typeof senderName !== 'string' ||
      typeof content !== 'string' ||
      !['text', 'image', 'video', 'file', 'call', 'reel'].includes(String(type))
    ) {
      return undefined;
    }

    return {
      senderName,
      content,
      ...(typeof thumbnailUri === 'string' ? { thumbnailUri } : {}),
      ...(typeof mediaWidth === 'number' ? { mediaWidth } : {}),
      ...(typeof mediaHeight === 'number' ? { mediaHeight } : {}),
      type: type as MessageReplyPreview['type'],
    };
  }

  static toDto(domain: Message): MessageDto {
    const isRecalled = domain.isRecalled === true;

    return {
      id: domain.id,
      conversationId: domain.conversationId,
      senderId: domain.senderId,
      clientMessageId: domain.clientMessageId,
      // Never serialize residual content or media from legacy recalled records.
      content: isRecalled ? RECALLED_MESSAGE_CONTENT : domain.content,
      media: isRecalled ? undefined : domain.media,
      metadata: isRecalled ? undefined : domain.metadata,
      type: domain.type,
      signalType: domain.signalType,
      createdAt: domain.createdAt.toISOString(),
      isRecalled: domain.isRecalled,
      recalledAt: domain.recalledAt?.toISOString(),
      replyToId: domain.replyToId,
      replyPreview: isRecalled ? undefined : domain.replyPreview,
      reactions: isRecalled ? undefined : domain.reactions,
      createdAtMs: domain.createdAt.getTime(),
      readBy: domain.readBy.map((r) => ({
        userId: r.userId,
        at: r.at.toISOString(),
      })),
    };
  }

  static conversationToDto(domain: Conversation) {
    return {
      id: domain.id,
      creatorId: domain.creatorId,
      participantIds: domain.participantIds,
      participants: domain.participants,
      ...(domain.name !== undefined ? { name: domain.name } : {}),
      ...(domain.picture !== undefined ? { picture: domain.picture } : {}),
      ...(domain.memberJoinedAt !== undefined
        ? { memberJoinedAt: domain.memberJoinedAt }
        : {}),
      lastMessage: domain.lastMessage,
      lastMessageAt: domain.lastMessageAt?.toISOString() ?? null,
      isGroup: domain.isGroup,
      ...(domain.unreadCount !== undefined
        ? { unreadCount: domain.unreadCount }
        : {}),
      createdAt: domain.createdAt.toISOString(),
      updatedAt: domain.updatedAt.toISOString(),
    };
  }
}
