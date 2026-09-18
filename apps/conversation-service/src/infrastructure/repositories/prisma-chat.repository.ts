import {
  BadRequestException,
  ForbiddenException,
  Inject,
  Injectable,
  InternalServerErrorException,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import {
  Prisma,
  type Message as PrismaMessage,
} from '@prisma/conversation-client';
import Redis from 'ioredis';
import { randomUUID } from 'node:crypto';

// Entities & Interfaces
import {
  ChatParticipant,
  Conversation,
} from '../../domain/entities/conversation.entity';
import {
  Message,
  MessageMetadata,
  RECALLED_MESSAGE_CONTENT,
  type MessageMedia,
  type MessageReactionMap,
  type MessageReplyPreview,
  type RecallMessageResult,
} from '../../domain/entities/message.entity';
import {
  IChatRepository,
  type AnchorMessageExpansion,
  type AnchorMessageWindow,
  type CreateMessageResult,
  type MarkMessagesAsSeenResult,
  type MediaProcessingSyncResult,
} from '../../domain/interfaces/chat.repository.interface';
import { PrismaService } from '../prisma/prisma.service';

// Mappers
import type { IEncryptionRepository } from '../../domain/interfaces/encryption.repository.interface';
import type { IChatMediaService } from '../../domain/interfaces/chat-media.service.interface';
import type { IUserService } from '../../domain/interfaces/user-service.interface';
import { ChatMapper } from './chat.mapper';
import { ConversationMapper } from './conversation.mapper';

const RECALLED_PREVIEW_CONTENT = 'Tin nhắn đã thu hồi';
const RECALLED_LAST_MESSAGE = '🚫 Message recalled';
const RECALL_WINDOW_MS = 24 * 60 * 60 * 1000;
const MEDIA_PROCESSING_TTL_SECONDS = 60 * 60 * 24;

type AnchorBoundary = {
  createdAt: Date;
  stableId: string;
};

@Injectable()
export class PrismaChatRepository implements IChatRepository {
  private readonly logger = new Logger(PrismaChatRepository.name);

  constructor(
    private readonly prisma: PrismaService,
    @Inject('REDIS_CLIENT') private readonly redis: Redis,

    // 👇 INJECT QUA INTERFACE TOKEN
    @Inject('IEncryptionRepository')
    private readonly encryptionRepository: IEncryptionRepository,

    @Inject('IUserService')
    private readonly userService: IUserService,

    @Inject('IChatMediaService')
    private readonly chatMediaService: IChatMediaService,
  ) {}

  // --- 1. CREATE MESSAGE ---
  async createMessage(message: Message): Promise<Message> {
    return (await this.createMessageIdempotently(message)).message;
  }

  async createMessageIdempotently(
    message: Message,
  ): Promise<CreateMessageResult> {
    // Legacy internal producers do not supply a client key. They keep working
    // with a server-generated key; public HTTP and Socket entry points require
    // a client key before reaching this method.
    const clientMessageId =
      message.clientMessageId?.trim() || `server:${randomUUID()}`;

    await this.assertConversationParticipant(
      message.conversationId,
      message.senderId,
    );

    // BƯỚC 1: Chuẩn bị dữ liệu (CPU bound - cực nhanh)
    let contentToSave = message.content;
    const replyPreview = await this.buildReplyPreview(
      message.replyToId,
      message.conversationId,
    );

    // Logic mã hóa
    if (message.signalType === 0) {
      contentToSave = this.encryptionRepository.encrypt(message.content);
    }

    // Tính toán Preview Text NGAY LẬP TỨC (để dùng cho transaction)
    let previewText = '';
    if (message.type === 'text') {
      if (message.signalType === 0) {
        previewText = message.content; // Normal: Server thấy text
      } else {
        previewText = '🔒 Tin nhắn được bảo mật'; // Signal: Server mù
      }
    } else {
      // Map loại file sang text hiển thị
      const typeMap: Record<string, string> = {
        image: '[Hình ảnh]',
        video: '[Video]',
        file: '[Tập tin]',
        call: '📞 Cuộc gọi',
        reel: '[Reel]',
      };
      previewText = typeMap[message.type] || 'Tin nhắn mới';
    }

    // BƯỚC 2: Thực thi DB song song (Prisma Transaction)
    // Giúp giảm Round-trip time xuống DB từ 2 lần còn 1 lần
    let savedMsg: PrismaMessage;
    try {
      [savedMsg] = await this.prisma.$transaction([
        // Op 1: Tạo message
        this.prisma.message.create({
          data: {
            type: message.type,
            clientMessageId,
            signalType: message.signalType ?? 1,
            content: contentToSave,
            media: message.media
              ? (message.media as unknown as Prisma.InputJsonValue)
              : null,
            metadata: message.metadata
              ? (message.metadata as unknown as Prisma.InputJsonValue)
              : null,
            registrationId: message.registrationId,
            senderId: message.senderId,
            isRecalled: false,
            replyToId: message.replyToId,
            replyPreview: replyPreview
              ? (replyPreview as unknown as Prisma.InputJsonValue)
              : null,
            conversationId: message.conversationId,
            readBy: [],
          },
        }),
        // Op 2: Update conversation (Last message)
        this.prisma.conversation.update({
          where: { id: message.conversationId },
          data: {
            lastMessage: previewText,
            lastMessageAt: new Date(),
          },
        }),
      ]);
    } catch (error: unknown) {
      // The compound unique index is the source of truth. A retry may race
      // with the original request, so P2002 is a successful idempotent read.
      if (!this.isClientMessageIdConflict(error)) {
        throw error;
      }

      const existingMessage = await this.prisma.message.findFirst({
        where: {
          conversationId: message.conversationId,
          senderId: message.senderId,
          clientMessageId,
        },
      });

      if (!existingMessage) {
        throw error;
      }

      return {
        message: await this.syncPendingMediaTracking(
          this.hydrateReadableMessageContent(
            ChatMapper.toDomain(existingMessage),
          ),
        ),
        created: false,
      };
    }

    // BƯỚC 3: Map về Domain Model
    let domainMsg = ChatMapper.toDomain(savedMsg);
    // Nếu là normal mode, trả về content gốc cho người gửi (đỡ phải decrypt lại)
    if (message.signalType === 0) {
      domainMsg.content = message.content;
    }

    domainMsg = await this.syncPendingMediaTracking(domainMsg);

    // History cache is invalidated instead of incrementally writing plaintext
    // messages. A delayed cache write could otherwise resurrect recalled data.
    await this.clearConversationCache(domainMsg.conversationId);

    return { message: domainMsg, created: true };
  }

  async syncMediaProcessingResult(
    fileKey: string,
    media: MessageMedia,
  ): Promise<MediaProcessingSyncResult> {
    const normalizedFileKey = this.normalizeMediaFileKey(fileKey);
    const mergedMedia = this.mergeMessageMedia(undefined, {
      ...media,
      fileKey: normalizedFileKey,
    });

    await this.redis.set(
      this.mediaResultKey(normalizedFileKey),
      JSON.stringify(mergedMedia),
      'EX',
      MEDIA_PROCESSING_TTL_SECONDS,
    );

    const pendingRefs = await this.redis.hgetall(
      this.pendingMediaKey(normalizedFileKey),
    );
    const messageIds = Object.keys(pendingRefs);

    if (messageIds.length === 0) {
      return {
        conversationIds: [],
        messageIds: [],
        media: mergedMedia,
      };
    }

    const existingMessages = await this.prisma.message.findMany({
      where: {
        id: { in: messageIds },
      },
    });

    if (existingMessages.length === 0) {
      await this.redis.del(this.pendingMediaKey(normalizedFileKey));

      return {
        conversationIds: [],
        messageIds: [],
        media: mergedMedia,
      };
    }

    const activeMessages = existingMessages.filter(
      (messageRecord) => !messageRecord.isRecalled,
    );

    if (activeMessages.length === 0) {
      await this.redis.del(
        this.pendingMediaKey(normalizedFileKey),
        this.mediaResultKey(normalizedFileKey),
      );

      return {
        conversationIds: [],
        messageIds: [],
        media: mergedMedia,
        discardedBecauseRecalled: true,
      };
    }

    const updatedMessages = activeMessages.map((messageRecord) => {
      const currentMedia = ChatMapper.toDomain(messageRecord).media;
      const nextMedia = this.mergeMessageMedia(currentMedia, mergedMedia);

      return {
        id: messageRecord.id,
        conversationId: messageRecord.conversationId,
        media: nextMedia,
      };
    });

    await this.prisma.$transaction(
      updatedMessages.map((messageRecord) =>
        this.prisma.message.update({
          where: { id: messageRecord.id },
          data: {
            media: messageRecord.media as unknown as Prisma.InputJsonValue,
          },
        }),
      ),
    );

    const conversationIds = [
      ...new Set(
        updatedMessages.map((messageRecord) => messageRecord.conversationId),
      ),
    ];
    await this.clearConversationCaches(conversationIds);
    await this.redis.del(this.pendingMediaKey(normalizedFileKey));

    return {
      conversationIds,
      messageIds: updatedMessages.map((messageRecord) => messageRecord.id),
      media: mergedMedia,
    };
  }

  // --- 2. FIND MESSAGES ---
  async findMessagesByConversationId(
    conversationId: string,
    limit: number = 20,
    cursor?: string,
  ): Promise<Message[]> {
    // Do not serve history from Redis. A recalled message must never be
    // recoverable from an asynchronous/stale content cache.

    const boundaryRecord = cursor
      ? await this.prisma.message.findUnique({
          where: { id: cursor },
          select: { id: true, conversationId: true, createdAt: true },
        })
      : null;

    if (
      cursor &&
      (!boundaryRecord || boundaryRecord.conversationId !== conversationId)
    ) {
      return [];
    }

    // CASE 2: Redis Miss HOẶC Load History (Có cursor) -> Query MongoDB
    const mongoMsgs = await this.prisma.message.findMany({
      where: boundaryRecord
        ? this.buildOlderThanBoundaryWhere(
            conversationId,
            this.toAnchorBoundary(boundaryRecord),
          )
        : { conversationId },
      take: limit,
      orderBy: this.anchorOrderBy(),
    });

    const domainMsgs = mongoMsgs.map((msg) => {
      const domain = ChatMapper.toDomain(msg);
      if (domain.isRecalled) {
        return this.redactRecalledMessage(domain);
      }

      // Decrypt logic cho Normal Mode
      if (domain.signalType === 0) {
        domain.content = this.encryptionRepository.decrypt(domain.content);
      }
      return domain;
    });

    // Trả về kết quả (Reverse để client dễ render: Trên cùng là tin cũ, dưới cùng là tin mới)
    return domainMsgs
      .sort((left, right) =>
        this.compareMessagesCanonicalNewestFirst(left, right),
      )
      .reverse();
  }

  private normalizeMetadata(
    value: MessageMetadata | null | undefined,
  ): MessageMetadata | undefined {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      return undefined;
    }

    return value;
  }

  async findMessageWindowAroundId(
    conversationId: string,
    messageId: string,
    before: number,
    after: number,
  ): Promise<AnchorMessageWindow> {
    const targetRecord = await this.resolveAnchorBoundaryRecord(
      conversationId,
      messageId,
    );
    const targetBoundary = this.toAnchorBoundary(targetRecord);
    const normalizedBefore = Math.max(0, before);
    const normalizedAfter = Math.max(0, after);

    const [newerRecords, olderRecords] = await Promise.all([
      normalizedBefore > 0
        ? this.prisma.message.findMany({
            where: this.buildNewerThanBoundaryWhere(
              conversationId,
              targetBoundary,
            ),
            orderBy: this.anchorOrderByAsc(),
            take: normalizedBefore,
          })
        : Promise.resolve([]),
      normalizedAfter > 0
        ? this.prisma.message.findMany({
            where: this.buildOlderThanBoundaryWhere(
              conversationId,
              targetBoundary,
            ),
            orderBy: this.anchorOrderBy(),
            take: normalizedAfter,
          })
        : Promise.resolve([]),
    ]);

    const combinedRecords = [
      ...[...newerRecords].reverse(),
      targetRecord,
      ...olderRecords,
    ];
    const messages = await this.mapPrismaMessagesToDomain(combinedRecords);
    const newestRecord = combinedRecords[0] ?? targetRecord;
    const oldestRecord =
      combinedRecords[combinedRecords.length - 1] ?? targetRecord;

    const [hasNewerRecord, hasOlderRecord] = await Promise.all([
      this.prisma.message.findFirst({
        where: this.buildNewerThanBoundaryWhere(
          conversationId,
          this.toAnchorBoundary(newestRecord),
        ),
        select: { id: true },
      }),
      this.prisma.message.findFirst({
        where: this.buildOlderThanBoundaryWhere(
          conversationId,
          this.toAnchorBoundary(oldestRecord),
        ),
        select: { id: true },
      }),
    ]);

    return {
      targetMessageId: targetRecord.id,
      messages,
      hasOlder: Boolean(hasOlderRecord),
      hasNewer: Boolean(hasNewerRecord),
      oldestCursor: oldestRecord.id,
      newestCursor: newestRecord.id,
    };
  }

  async findOlderMessagesFromAnchorCursor(
    conversationId: string,
    cursor: string,
    limit: number,
  ): Promise<AnchorMessageExpansion> {
    const boundaryRecord = await this.resolveAnchorBoundaryRecord(
      conversationId,
      cursor,
    );
    const normalizedLimit = Math.max(1, limit);
    const records = await this.prisma.message.findMany({
      where: this.buildOlderThanBoundaryWhere(
        conversationId,
        this.toAnchorBoundary(boundaryRecord),
      ),
      orderBy: this.anchorOrderBy(),
      take: normalizedLimit + 1,
    });
    const hasMore = records.length > normalizedLimit;
    const visibleRecords = records.slice(0, normalizedLimit);

    return {
      messages: await this.mapPrismaMessagesToDomain(visibleRecords),
      hasMore,
      ...(visibleRecords.length > 0
        ? { nextCursor: visibleRecords[visibleRecords.length - 1]?.id }
        : {}),
    };
  }

  async findNewerMessagesFromAnchorCursor(
    conversationId: string,
    cursor: string,
    limit: number,
  ): Promise<AnchorMessageExpansion> {
    const boundaryRecord = await this.resolveAnchorBoundaryRecord(
      conversationId,
      cursor,
    );
    const normalizedLimit = Math.max(1, limit);
    const records = await this.prisma.message.findMany({
      where: this.buildNewerThanBoundaryWhere(
        conversationId,
        this.toAnchorBoundary(boundaryRecord),
      ),
      orderBy: this.anchorOrderByAsc(),
      take: normalizedLimit + 1,
    });
    const hasMore = records.length > normalizedLimit;
    const visibleRecords = records.slice(0, normalizedLimit);
    const visibleRecordsDesc = [...visibleRecords].reverse();

    return {
      messages: await this.mapPrismaMessagesToDomain(visibleRecordsDesc),
      hasMore,
      ...(visibleRecordsDesc.length > 0
        ? { nextCursor: visibleRecordsDesc[0]?.id }
        : {}),
    };
  }

  // --- CÁC HÀM KHÁC GIỮ NGUYÊN ---

  async createConversation(conversation: Conversation): Promise<Conversation> {
    const savedConv = await this.prisma.conversation.create({
      data: {
        creatorId: conversation.creatorId,
        participantIds: conversation.participantIds,
        createdAt: conversation.createdAt,
        updatedAt: conversation.updatedAt,
        isGroup: conversation.isGroup,
        lastMessage: conversation.lastMessage || null,
        lastMessageAt: conversation.lastMessageAt || null,
      },
    });
    return ConversationMapper.toDomain(savedConv);
  }

  async findConversation(id: string): Promise<Conversation | null> {
    // 1. Lấy dữ liệu thô từ MongoDB
    const foundConv = await this.prisma.conversation.findUnique({
      where: { id },
    });

    if (!foundConv) return null;

    // 2. Chuyển sang Domain Entity
    const domainConv = ConversationMapper.toDomain(foundConv);

    // 3. Gọi User Service để lấy thông tin chi tiết Participants
    try {
      const response = await this.userService.findUsersByIds(
        domainConv.participantIds,
      );

      let usersList: ChatParticipant[] = [];

      // Xử lý response (Array hoặc Object wrapping)
      if (Array.isArray(response)) {
        usersList = response;
      } else if (
        response &&
        'users' in response &&
        Array.isArray((response as Record<string, unknown>).users)
      ) {
        usersList = (response as Record<string, unknown>)
          .users as ChatParticipant[];
      }

      // Tạo Map để lookup cho nhanh
      const usersMap = new Map<string, ChatParticipant>();
      usersList.forEach((u) => {
        if (u && u.id) usersMap.set(u.id, this.normalizeChatParticipant(u));
      });

      // 4. Map dữ liệu user vào Conversation
      domainConv.participants = domainConv.participantIds
        .map((uid) => usersMap.get(uid))
        .filter((u): u is ChatParticipant => u !== undefined);
    } catch (error) {
      // Nếu User Service chết, log lỗi nhưng KHÔNG throw exception.
      // Vẫn trả về conversation để user chat được (dù không thấy avatar/tên)
      this.logger.error(
        `[findConversation] Failed to fetch participants for ${id}`,
        error,
      );
      domainConv.participants = [];
    }

    return domainConv;
  }

  async findConversationsByUserId(
    userId: string,
    limit: number = 15,
    cursor?: string, // ID của conversation cuối cùng trong list hiện tại
  ): Promise<Conversation[]> {
    // 1. Query Prisma với Cursor
    const conversations = await this.prisma.conversation.findMany({
      where: { participantIds: { has: userId } },
      take: limit,
      skip: cursor ? 1 : 0,
      cursor: cursor ? { id: cursor } : undefined,
      orderBy: { lastMessageAt: 'desc' }, // Sắp xếp theo tin nhắn mới nhất
    });

    if (!conversations.length) return [];

    const unreadCountsByConversationId = new Map<string, number>();

    await Promise.all(
      conversations.map(async (conversation) => {
        const unreadCount = await this.prisma.message.count({
          where: {
            conversationId: conversation.id,
            senderId: { not: userId },
            readBy: { none: { userId } },
          },
        });

        unreadCountsByConversationId.set(conversation.id, unreadCount);
      }),
    );

    // 2. Gom ID để Bulk Fetch User Info (Giữ nguyên logic tối ưu cũ)
    const allParticipantIds = [
      ...new Set(conversations.flatMap((c) => c.participantIds)),
    ];

    const usersMap = new Map<string, ChatParticipant>();

    try {
      const response = await this.userService.findUsersByIds(allParticipantIds);
      let usersList: ChatParticipant[] = [];

      if (Array.isArray(response)) {
        usersList = response;
      } else if (
        response &&
        'users' in response &&
        Array.isArray((response as Record<string, unknown>).users)
      ) {
        usersList = (response as Record<string, unknown>)
          .users as ChatParticipant[];
      }

      usersList.forEach((u) => {
        if (u && u.id) usersMap.set(u.id, this.normalizeChatParticipant(u));
      });
    } catch (error) {
      this.logger.error('Failed to fetch user details', error);
    }

    // 3. Map Participants
    return conversations.map((c) => {
      const domainConv = ConversationMapper.toDomain(c);
      domainConv.participants = c.participantIds
        .map((id) => usersMap.get(id))
        .filter((u): u is ChatParticipant => u !== undefined);
      domainConv.unreadCount = unreadCountsByConversationId.get(c.id) ?? 0;
      return domainConv;
    });
  }

  async findPrivateConversation(
    userId1: string,
    userId2: string,
  ): Promise<Conversation | null> {
    const conversation = await this.prisma.conversation.findFirst({
      where: {
        isGroup: false,
        participantIds: { hasEvery: [userId1, userId2] },
      },
    });
    if (!conversation) return null;
    return ConversationMapper.toDomain(conversation);
  }

  async hasSharedConversation(
    userId1: string,
    userId2: string,
  ): Promise<boolean> {
    const conversation = await this.prisma.conversation.findFirst({
      where: {
        participantIds: { hasEvery: [userId1, userId2] },
      },
      select: { id: true },
    });

    return Boolean(conversation);
  }

  async findPresenceAudienceUserIds(userId: string): Promise<string[]> {
    const conversations = await this.prisma.conversation.findMany({
      where: { participantIds: { has: userId } },
      select: { participantIds: true },
    });

    return [
      ...new Set(
        conversations
          .flatMap((conversation) => conversation.participantIds)
          .filter((participantId) => participantId !== userId),
      ),
    ];
  }

  async addReaction(
    messageId: string,
    userId: string,
    emoji: string,
  ): Promise<Message> {
    if (!emoji.trim()) {
      throw new BadRequestException('Emoji is required');
    }

    const existingMessage = await this.prisma.message.findUnique({
      where: { id: messageId },
    });

    if (!existingMessage) {
      throw new NotFoundException('Message not found');
    }

    await this.assertConversationParticipant(
      existingMessage.conversationId,
      userId,
    );

    const reactions = this.normalizeReactions(existingMessage.reactions);
    const nextReactions: MessageReactionMap = {
      ...(reactions || {}),
      [userId]: {
        emoji,
        createdAt: new Date().toISOString(),
      },
    };

    const updatedMessage = await this.prisma.message.update({
      where: { id: messageId },
      data: {
        reactions: nextReactions as unknown as Prisma.InputJsonValue,
      },
    });

    await this.clearConversationCache(updatedMessage.conversationId);
    return this.hydrateReactionUpdateMessage(
      ChatMapper.toDomain(updatedMessage),
    );
  }

  async removeReaction(messageId: string, userId: string): Promise<Message> {
    const existingMessage = await this.prisma.message.findUnique({
      where: { id: messageId },
    });

    if (!existingMessage) {
      throw new NotFoundException('Message not found');
    }

    await this.assertConversationParticipant(
      existingMessage.conversationId,
      userId,
    );

    const reactions = this.normalizeReactions(existingMessage.reactions);
    if (!reactions || !reactions[userId]) {
      return this.hydrateReactionUpdateMessage(
        ChatMapper.toDomain(existingMessage),
      );
    }

    const remainingReactions = { ...reactions };
    delete remainingReactions[userId];

    const updatedMessage = await this.prisma.message.update({
      where: { id: messageId },
      data: {
        reactions:
          Object.keys(remainingReactions).length > 0
            ? (remainingReactions as unknown as Prisma.InputJsonValue)
            : null,
      },
    });

    await this.clearConversationCache(updatedMessage.conversationId);
    return this.hydrateReactionUpdateMessage(
      ChatMapper.toDomain(updatedMessage),
    );
  }

  async recallMessage(
    messageId: string,
    userId: string,
  ): Promise<RecallMessageResult> {
    if (!this.isValidMessageObjectId(messageId)) {
      throw new BadRequestException('Invalid message ID');
    }

    const existingMessage = await this.prisma.message.findUnique({
      where: { id: messageId },
    });

    if (!existingMessage) {
      throw new NotFoundException('Message not found');
    }

    await this.assertConversationParticipant(
      existingMessage.conversationId,
      userId,
    );

    if (existingMessage.senderId !== userId) {
      throw new ForbiddenException('You can only recall your own messages');
    }

    if (existingMessage.isRecalled) {
      throw new BadRequestException('Message already recalled');
    }

    if (existingMessage.type === 'call') {
      throw new BadRequestException(
        'This message type does not support recall',
      );
    }

    if (Date.now() - existingMessage.createdAt.getTime() > RECALL_WINDOW_MS) {
      throw new BadRequestException(
        'Message can only be recalled within 24 hours',
      );
    }

    const recalledAt = new Date();
    const conversationId = existingMessage.conversationId;
    const recalledMedia = this.normalizeMedia(existingMessage.media);
    const recalledMediaKeys = this.getOwnedChatMediaKeys(
      recalledMedia,
      existingMessage.senderId,
    );

    // Chat attachments are publicly addressed in R2. Remove the source objects
    // before confirming the recall, otherwise clearing the database reference
    // alone would leave the original URL accessible.
    await this.chatMediaService.deleteRecalledChatMedia({
      userId: existingMessage.senderId,
      fileKeys: recalledMediaKeys,
    });

    const result = await this.prisma.$transaction(async (tx) => {
      const replyMessages = await tx.message.findMany({
        where: {
          conversationId,
          replyToId: messageId,
        },
        select: {
          id: true,
          replyPreview: true,
        },
      });

      const latestMessage = await tx.message.findFirst({
        where: { conversationId },
        orderBy: { createdAt: 'desc' },
        select: { id: true },
      });

      const updatedMessage = await tx.message.update({
        where: { id: messageId },
        data: {
          isRecalled: true,
          recalledAt,
          content:
            existingMessage.signalType === 0
              ? this.encryptionRepository.encrypt(RECALLED_MESSAGE_CONTENT)
              : RECALLED_MESSAGE_CONTENT,
          media: null,
          metadata: null,
          registrationId: null,
          replyPreview: null,
          reactions: null,
        },
      });

      const updatedReplyMessageIds: string[] = [];

      for (const replyMessage of replyMessages) {
        const nextReplyPreview = this.mergeReplyPreviewContent(
          replyMessage.replyPreview,
          RECALLED_PREVIEW_CONTENT,
        );

        if (!nextReplyPreview) {
          continue;
        }

        await tx.message.update({
          where: { id: replyMessage.id },
          data: {
            replyPreview: nextReplyPreview as unknown as Prisma.InputJsonValue,
          },
        });

        updatedReplyMessageIds.push(replyMessage.id);
      }

      if (latestMessage?.id === messageId) {
        await tx.conversation.update({
          where: { id: conversationId },
          data: {
            lastMessage: RECALLED_LAST_MESSAGE,
          },
        });
      }

      return {
        updatedMessage,
        updatedReplyMessageIds,
      };
    });

    if (recalledMedia?.fileKey) {
      await this.redis.hdel(
        this.pendingMediaKey(this.normalizeMediaFileKey(recalledMedia.fileKey)),
        messageId,
      );
    }

    await this.clearConversationCache(conversationId);

    return {
      message: this.redactRecalledMessage(
        ChatMapper.toDomain(result.updatedMessage),
      ),
      updatedReplyMessageIds: result.updatedReplyMessageIds,
      previewContent: RECALLED_PREVIEW_CONTENT,
    };
  }

  async markMessagesAsSeen(
    conversationId: string,
    userId: string,
    upToMessageId?: string,
  ): Promise<MarkMessagesAsSeenResult> {
    const isObjectId = /^[0-9a-fA-F]{24}$/.test(conversationId);
    if (!isObjectId) throw new BadRequestException('Invalid conversation ID');

    await this.assertConversationParticipant(conversationId, userId);

    try {
      const boundaryRecord = upToMessageId
        ? await this.resolveAnchorBoundaryRecord(conversationId, upToMessageId)
        : await this.prisma.message.findFirst({
            where: { conversationId },
            orderBy: this.anchorOrderBy(),
            select: { id: true, createdAt: true, conversationId: true },
          });

      if (!boundaryRecord) {
        return { updatedCount: 0 };
      }

      const boundary = this.toAnchorBoundary(boundaryRecord);
      const seenAt = new Date();
      const result = await this.prisma.message.updateMany({
        where: {
          conversationId: conversationId,
          senderId: { not: userId },
          readBy: { none: { userId: userId } },
          OR: [
            { createdAt: { lt: boundary.createdAt } },
            {
              createdAt: boundary.createdAt,
              id: { lte: boundary.stableId },
            },
          ],
        },
        data: {
          readBy: { push: { userId: userId, at: seenAt } },
        },
      });

      if (result.count > 0) {
        await this.clearConversationCache(conversationId);
      }
      return {
        updatedCount: result.count,
        seenAt,
        seenUpTo: {
          messageId: boundaryRecord.id,
          createdAt: boundaryRecord.createdAt,
        },
      };
    } catch (error) {
      if (
        error instanceof BadRequestException ||
        error instanceof ForbiddenException ||
        error instanceof NotFoundException
      ) {
        throw error;
      }

      this.logger.error(error);
      throw new InternalServerErrorException('Could not mark seen');
    }
  }

  private normalizeReactions(value: unknown): MessageReactionMap | undefined {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      return undefined;
    }

    const normalized = Object.entries(value as Record<string, unknown>)
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

    return normalized.length > 0 ? Object.fromEntries(normalized) : undefined;
  }

  private normalizeMedia(value: unknown): MessageMedia | undefined {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      return undefined;
    }

    const fileUrl = (value as Record<string, unknown>).fileUrl;
    if (typeof fileUrl !== 'string' || !fileUrl) {
      return undefined;
    }

    const fileKey = (value as Record<string, unknown>).fileKey;
    const thumbnailKey = (value as Record<string, unknown>).thumbnailKey;
    const thumbnailUrl = (value as Record<string, unknown>).thumbnailUrl;
    const mimeType = (value as Record<string, unknown>).mimeType;
    const width = (value as Record<string, unknown>).width;
    const height = (value as Record<string, unknown>).height;
    const durationMs = (value as Record<string, unknown>).durationMs;
    const status = (value as Record<string, unknown>).status;
    const failureReason = (value as Record<string, unknown>).failureReason;
    const reelId = (value as Record<string, unknown>).reelId;
    const reelSourceOrientation = (value as Record<string, unknown>)
      .reelSourceOrientation;
    const reelSourceAspectRatio = (value as Record<string, unknown>)
      .reelSourceAspectRatio;
    const reelPlaybackPresentation = (value as Record<string, unknown>)
      .reelPlaybackPresentation;
    const reelOwnerId = (value as Record<string, unknown>).reelOwnerId;
    const reelOwnerUsername = (value as Record<string, unknown>)
      .reelOwnerUsername;
    const reelOwnerAvatarUrl = (value as Record<string, unknown>)
      .reelOwnerAvatarUrl;
    const reelTitle = (value as Record<string, unknown>).reelTitle;
    const reelDescription = (value as Record<string, unknown>).reelDescription;
    const reelTags = this.normalizeStringArray(
      (value as Record<string, unknown>).reelTags,
    );

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

  private normalizeStringArray(value: unknown): string[] | undefined {
    if (!Array.isArray(value)) {
      return undefined;
    }

    return value.filter(
      (item): item is string => typeof item === 'string' && item.length > 0,
    );
  }

  private normalizeReplyPreview(
    value: unknown,
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

    if (content === RECALLED_PREVIEW_CONTENT) {
      return this.buildTextOnlyReplyPreview({
        content,
        senderName,
      });
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

  private buildTextOnlyReplyPreview({
    content,
    senderName,
  }: {
    content?: string;
    senderName: string;
  }): MessageReplyPreview {
    return {
      senderName,
      content:
        typeof content === 'string' && content.length > 0
          ? content
          : RECALLED_PREVIEW_CONTENT,
      type: 'text',
    };
  }

  private mergeReplyPreviewContent(
    value: unknown,
    content: string,
  ): MessageReplyPreview | undefined {
    const current = this.normalizeReplyPreview(value);

    if (!current) {
      return undefined;
    }

    if (content === RECALLED_PREVIEW_CONTENT) {
      return this.buildTextOnlyReplyPreview({
        content,
        senderName: current.senderName,
      });
    }

    return {
      ...current,
      content,
    };
  }

  private async clearConversationCache(conversationId: string) {
    try {
      await this.redis.del(`chat:history:${conversationId}`);
    } catch (error) {
      this.logger.error(error);
    }
  }

  private isClientMessageIdConflict(error: unknown): boolean {
    return (
      error instanceof Prisma.PrismaClientKnownRequestError &&
      error.code === 'P2002'
    );
  }

  private async clearConversationCaches(conversationIds: string[]) {
    if (conversationIds.length === 0) {
      return;
    }

    try {
      const pipeline = this.redis.pipeline();
      conversationIds.forEach((conversationId) => {
        pipeline.del(`chat:history:${conversationId}`);
      });
      await pipeline.exec();
    } catch (error) {
      this.logger.error(error);
    }
  }

  async assertConversationParticipant(conversationId: string, userId: string) {
    const conversation = await this.prisma.conversation.findUnique({
      where: { id: conversationId },
      select: { participantIds: true },
    });

    if (!conversation) {
      throw new NotFoundException('Conversation not found');
    }

    if (!conversation.participantIds.includes(userId)) {
      throw new ForbiddenException(
        'You are not allowed to access messages in this conversation',
      );
    }
  }

  private anchorOrderBy(): Prisma.MessageOrderByWithRelationInput[] {
    return [{ createdAt: 'desc' }, { id: 'desc' }];
  }

  private anchorOrderByAsc(): Prisma.MessageOrderByWithRelationInput[] {
    return [{ createdAt: 'asc' }, { id: 'asc' }];
  }

  private compareMessagesCanonicalNewestFirst(left: Message, right: Message) {
    const timestampDelta = right.createdAt.getTime() - left.createdAt.getTime();

    if (timestampDelta !== 0) {
      return timestampDelta;
    }

    return right.id.localeCompare(left.id);
  }

  private toAnchorBoundary(message: {
    createdAt: Date;
    id: string;
  }): AnchorBoundary {
    return {
      createdAt: message.createdAt,
      stableId: message.id,
    };
  }

  private buildOlderThanBoundaryWhere(
    conversationId: string,
    boundary: AnchorBoundary,
  ): Prisma.MessageWhereInput {
    return {
      conversationId,
      OR: [
        { createdAt: { lt: boundary.createdAt } },
        {
          createdAt: boundary.createdAt,
          id: { lt: boundary.stableId },
        },
      ],
    };
  }

  private buildNewerThanBoundaryWhere(
    conversationId: string,
    boundary: AnchorBoundary,
  ): Prisma.MessageWhereInput {
    return {
      conversationId,
      OR: [
        { createdAt: { gt: boundary.createdAt } },
        {
          createdAt: boundary.createdAt,
          id: { gt: boundary.stableId },
        },
      ],
    };
  }

  private async resolveAnchorBoundaryRecord(
    conversationId: string,
    messageId: string,
  ) {
    const message = await this.prisma.message.findUnique({
      where: { id: messageId },
    });

    if (!message || message.conversationId !== conversationId) {
      throw new NotFoundException('Anchor target not found');
    }

    return message;
  }

  private async mapPrismaMessagesToDomain(
    messages: Array<
      Prisma.MessageGetPayload<{
        select: {
          id: true;
          conversationId: true;
          senderId: true;
          clientMessageId: true;
          type: true;
          signalType: true;
          content: true;
          media: true;
          metadata: true;
          registrationId: true;
          isRecalled: true;
          recalledAt: true;
          replyToId: true;
          replyPreview: true;
          reactions: true;
          createdAt: true;
          readBy: true;
        };
      }>
    >,
  ): Promise<Message[]> {
    return Promise.all(
      messages.map(async (message) => {
        const domain = ChatMapper.toDomain(message);

        if (domain.isRecalled) {
          return this.redactRecalledMessage(domain);
        }

        if (domain.signalType === 0) {
          domain.content = this.encryptionRepository.decrypt(domain.content);
        }

        return this.syncPendingMediaTracking(domain);
      }),
    );
  }

  private async buildReplyPreview(
    replyToId: string | undefined,
    conversationId: string,
  ): Promise<MessageReplyPreview | undefined> {
    if (!replyToId) {
      return undefined;
    }

    const replyTarget = await this.prisma.message.findUnique({
      where: { id: replyToId },
    });

    if (!replyTarget || replyTarget.conversationId !== conversationId) {
      throw new BadRequestException('Reply target is invalid');
    }

    const replyTargetMedia = this.normalizeMedia(replyTarget.media);
    const senderName = await this.getUserPreviewName(replyTarget.senderId);
    const isReelLikeReply = this.isReelLikeMessage(
      replyTarget.type,
      replyTargetMedia,
    );

    if (replyTarget.isRecalled) {
      return this.buildTextOnlyReplyPreview({
        senderName,
      });
    }

    const thumbnailUri =
      isReelLikeReply || replyTarget.type === 'video'
        ? replyTargetMedia?.thumbnailUrl
        : (replyTargetMedia?.thumbnailUrl ?? replyTargetMedia?.fileUrl);

    return {
      senderName,
      content: this.getReplyPreviewContent({
        ...replyTarget,
        media: replyTargetMedia,
      }),
      ...(thumbnailUri ? { thumbnailUri } : {}),
      ...(replyTargetMedia?.width
        ? { mediaWidth: replyTargetMedia.width }
        : {}),
      ...(replyTargetMedia?.height
        ? { mediaHeight: replyTargetMedia.height }
        : {}),
      type: this.getReplyPreviewType(replyTarget.type, replyTargetMedia),
    };
  }

  private async syncPendingMediaTracking(message: Message): Promise<Message> {
    if (
      !message.media?.fileKey ||
      message.media.status !== 'processing' ||
      typeof message.media.fileUrl !== 'string'
    ) {
      return message;
    }

    const normalizedFileKey = this.normalizeMediaFileKey(message.media.fileKey);
    const storedMedia = await this.getStoredMediaResult(normalizedFileKey);

    if (!storedMedia) {
      await this.registerPendingMediaReference(
        normalizedFileKey,
        message.id,
        message.conversationId,
      );
      return message;
    }

    const nextMedia = this.mergeMessageMedia(message.media, storedMedia);

    await this.prisma.message.update({
      where: { id: message.id },
      data: {
        media: nextMedia as unknown as Prisma.InputJsonValue,
      },
    });

    message.media = nextMedia;
    return message;
  }

  private async registerPendingMediaReference(
    fileKey: string,
    messageId: string,
    conversationId: string,
  ) {
    await this.redis.hset(
      this.pendingMediaKey(fileKey),
      messageId,
      conversationId,
    );
    await this.redis.expire(
      this.pendingMediaKey(fileKey),
      MEDIA_PROCESSING_TTL_SECONDS,
    );
  }

  private async getStoredMediaResult(
    fileKey: string,
  ): Promise<MessageMedia | undefined> {
    const raw = await this.redis.get(this.mediaResultKey(fileKey));

    if (!raw) {
      return undefined;
    }

    try {
      return this.normalizeMedia(JSON.parse(raw));
    } catch {
      return undefined;
    }
  }

  private mergeMessageMedia(
    current: MessageMedia | undefined,
    patch: MessageMedia,
  ): MessageMedia {
    const fileUrl = patch.fileUrl || current?.fileUrl;
    const failureReason =
      patch.status === 'failed'
        ? (patch.failureReason ?? current?.failureReason)
        : patch.failureReason;
    const reelId = patch.reelId ?? current?.reelId;
    const reelOwnerId = patch.reelOwnerId ?? current?.reelOwnerId;
    const reelOwnerUsername =
      patch.reelOwnerUsername ?? current?.reelOwnerUsername;
    const reelOwnerAvatarUrl =
      patch.reelOwnerAvatarUrl ?? current?.reelOwnerAvatarUrl;
    const reelTitle = patch.reelTitle ?? current?.reelTitle;
    const reelDescription = patch.reelDescription ?? current?.reelDescription;
    const reelTags =
      patch.reelTags !== undefined
        ? this.normalizeStringArray(patch.reelTags)
        : current?.reelTags;

    if (!fileUrl) {
      throw new InternalServerErrorException(
        'Message media fileUrl is missing',
      );
    }

    const mergedMedia: MessageMedia = {
      ...((patch.fileKey ?? current?.fileKey)
        ? { fileKey: patch.fileKey ?? current?.fileKey }
        : {}),
      fileUrl,
      ...((patch.thumbnailKey ?? current?.thumbnailKey)
        ? { thumbnailKey: patch.thumbnailKey ?? current?.thumbnailKey }
        : {}),
      ...((patch.thumbnailUrl ?? current?.thumbnailUrl)
        ? { thumbnailUrl: patch.thumbnailUrl ?? current?.thumbnailUrl }
        : {}),
      ...((patch.mimeType ?? current?.mimeType)
        ? { mimeType: patch.mimeType ?? current?.mimeType }
        : {}),
      ...((current?.width ?? patch.width)
        ? { width: current?.width ?? patch.width }
        : {}),
      ...((current?.height ?? patch.height)
        ? { height: current?.height ?? patch.height }
        : {}),
      ...((current?.durationMs ?? patch.durationMs)
        ? { durationMs: current?.durationMs ?? patch.durationMs }
        : {}),
      ...((patch.status ?? current?.status)
        ? { status: patch.status ?? current?.status }
        : {}),
      ...(reelId ? { reelId } : {}),
      ...(reelOwnerId ? { reelOwnerId } : {}),
      ...(reelOwnerUsername ? { reelOwnerUsername } : {}),
      ...(reelOwnerAvatarUrl ? { reelOwnerAvatarUrl } : {}),
      ...(reelTitle ? { reelTitle } : {}),
      ...(reelDescription ? { reelDescription } : {}),
      ...(reelTags !== undefined ? { reelTags } : {}),
    };

    if (failureReason) {
      mergedMedia.failureReason = failureReason;
    }

    return mergedMedia;
  }

  private normalizeMediaFileKey(fileKey: string): string {
    return fileKey.replace(/^\/+/, '');
  }

  private isValidMessageObjectId(messageId: string): boolean {
    return /^[0-9a-fA-F]{24}$/.test(messageId);
  }

  private pendingMediaKey(fileKey: string): string {
    return `chat:media:pending:${fileKey}`;
  }

  private mediaResultKey(fileKey: string): string {
    return `chat:media:result:${fileKey}`;
  }

  private hydrateReadableMessageContent(message: Message): Message {
    if (message.isRecalled) {
      return this.redactRecalledMessage(message);
    }

    if (message.signalType !== 0) {
      return message;
    }

    message.content = this.encryptionRepository.decrypt(message.content);
    return message;
  }

  private redactRecalledMessage(message: Message): Message {
    message.content = RECALLED_MESSAGE_CONTENT;
    message.media = undefined;
    message.metadata = undefined;
    message.registrationId = undefined;
    message.replyPreview = undefined;
    message.reactions = undefined;
    return message;
  }

  private getOwnedChatMediaKeys(
    media: MessageMedia | undefined,
    userId: string,
  ): string[] {
    const keys = [media?.fileKey, media?.thumbnailKey].filter(
      (key): key is string => typeof key === 'string' && key.trim().length > 0,
    );
    const ownedChatPrefixPattern = new RegExp(
      `^(chat-images|chat-videos|chat-thumbnails)/${this.escapeRegExp(userId)}/`,
    );

    return [
      ...new Set(keys.map((key) => this.normalizeMediaFileKey(key))),
    ].filter((key) => ownedChatPrefixPattern.test(key));
  }

  private escapeRegExp(value: string): string {
    return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }

  private hydrateReactionUpdateMessage(message: Message): Message {
    const hydratedMessage = this.hydrateReadableMessageContent(message);
    hydratedMessage.reactions = hydratedMessage.reactions ?? {};
    return hydratedMessage;
  }

  private getReplyPreviewContent(message: {
    content: string;
    type: string;
    signalType: number;
    isRecalled: boolean;
    media?: MessageMedia;
  }) {
    if (message.isRecalled) {
      return RECALLED_PREVIEW_CONTENT;
    }

    if (this.isReelLikeMessage(message.type, message.media)) {
      if (message.media?.reelTitle?.trim()) {
        return message.media.reelTitle.trim();
      }

      if (message.signalType === 0) {
        try {
          const decrypted = this.encryptionRepository.decrypt(message.content);
          if (decrypted.trim()) {
            return decrypted;
          }
        } catch {
          // Fall through to the reel label when legacy content is unreadable.
        }
      }

      return this.getAttachmentPreviewLabel('reel');
    }

    if (message.type !== 'text') {
      return this.getAttachmentPreviewLabel(message.type);
    }

    if (message.signalType !== 0) {
      return '🔒 Tin nhắn được bảo mật';
    }

    try {
      return this.encryptionRepository.decrypt(message.content);
    } catch {
      return '🔒 Tin nhắn được bảo mật';
    }
  }

  private getReplyPreviewType(
    type: string,
    media?: MessageMedia,
  ): MessageReplyPreview['type'] {
    if (this.isReelLikeMessage(type, media)) {
      return 'reel';
    }

    if (['image', 'video', 'file', 'call'].includes(type)) {
      return type as MessageReplyPreview['type'];
    }

    return 'text';
  }

  private isReelLikeMessage(type: string, media?: MessageMedia): boolean {
    return (
      type === 'reel' ||
      media?.mimeType === 'application/vnd.velora.reel' ||
      (typeof media?.reelId === 'string' && media.reelId.trim().length > 0)
    );
  }

  private getAttachmentPreviewLabel(type: string) {
    const typeMap: Record<string, string> = {
      image: '[Hình ảnh]',
      video: '[Video]',
      file: '[Tập tin]',
      call: '📞 Cuộc gọi',
      reel: '[Reel]',
    };

    return typeMap[type] || 'Tin nhắn mới';
  }

  private async getUserPreviewName(userId: string) {
    try {
      const response = await this.userService.findUsersByIds([userId]);

      let usersList: ChatParticipant[] = [];

      if (Array.isArray(response)) {
        usersList = response;
      } else if (
        response &&
        'users' in response &&
        Array.isArray((response as Record<string, unknown>).users)
      ) {
        usersList = (response as Record<string, unknown>)
          .users as ChatParticipant[];
      }

      const user = usersList.find((item) => item.id === userId);
      const name = this.getParticipantName(user);
      if (name) {
        return name;
      }
      if (user?.email?.trim()) {
        return user.email.split('@')[0];
      }
    } catch (error) {
      this.logger.error(`[getUserPreviewName] Failed for ${userId}`, error);
    }

    return 'User';
  }

  private normalizeChatParticipant(user: ChatParticipant): ChatParticipant {
    const name = this.getParticipantName(user);

    return name ? { ...user, name } : user;
  }

  private getParticipantName(user?: ChatParticipant) {
    return user?.name?.trim() || user?.fullName?.trim();
  }
}
