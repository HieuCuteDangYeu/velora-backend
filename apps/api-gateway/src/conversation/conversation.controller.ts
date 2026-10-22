import { CurrentUser } from '@common/auth/decorators/current-user.decorator';
import type { AuthUser } from '@common/auth/interfaces/auth-user.interface';
import { BOT_USER_ID } from '@common/constants/seed.constants';
import {
  AddConversationMemberDto,
  AddConversationMemberSchema,
} from '@common/conversation/dtos/add-conversation-member.dto';
import { ChatWithBotDto } from '@common/conversation/dtos/chat-with-bot.dto';
import { ConversationDto } from '@common/conversation/dtos/conversation.dto';
import {
  CreateConversationDto,
  CreateConversationSchema,
} from '@common/conversation/dtos/create-conversation.dto';
import { CreateMessageDto } from '@common/conversation/dtos/create-message.dto';
import { MessageDto } from '@common/conversation/dtos/message.dto';
import {
  TransferGroupOwnershipDto,
  TransferGroupOwnershipSchema,
} from '@common/conversation/dtos/transfer-group-ownership.dto';
import {
  UpdateGroupConversationDto,
  UpdateGroupConversationSchema,
} from '@common/conversation/dtos/update-group-conversation.dto';
import { CreateMessageResponse } from '@common/conversation/interfaces/create-message-response.interface';
import { MessageAnchorExpansionResponse } from '@common/conversation/interfaces/message-anchor-expansion.interface';
import { MessageAnchorWindowResponse } from '@common/conversation/interfaces/message-anchor-window.interface';
import type { Reel } from '@content/domain/entities/reel.entity';
import { JwtAuthGuard } from '@gateway/auth/guards/jwt-auth.guard';
import { ReelAuthorService } from '@gateway/content/reel-author.service';
import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  Inject,
  NotImplementedException,
  Param,
  Patch,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { ClientProxy } from '@nestjs/microservices';
import {
  ApiBearerAuth,
  ApiBody,
  ApiOkResponse,
  ApiOperation,
  ApiQuery,
  ApiTags,
} from '@nestjs/swagger';
import { lastValueFrom } from 'rxjs';

interface ConversationParticipantPayload {
  id: string;
  email?: string;
  picture?: string;
  avatar?: string;
}

@ApiTags('Conversations')
@Controller('conversations')
@UseGuards(JwtAuthGuard)
@ApiBearerAuth()
export class ConversationController {
  constructor(
    @Inject('CONVERSATION_SERVICE')
    private readonly conversationClient: ClientProxy,
    @Inject('CONTENT_SERVICE')
    private readonly contentClient: ClientProxy,
    private readonly reelAuthorService: ReelAuthorService,
  ) {}

  private async enrichReelOwnersInMessageResponses(
    messages: MessageDto[],
  ): Promise<MessageDto[]> {
    const reelIdsByIndex = new Map<number, string>();
    const reelOwnerIdsByIndex = new Map<number, string>();

    messages.forEach((message, index) => {
      const media = this.getMediaRecord(message.media);
      if (!media || !this.isReelLikeMessage(message)) {
        return;
      }

      const reelId = this.getNonEmptyString(media.reelId);
      const reelOwnerId = this.getNonEmptyString(media.reelOwnerId);

      if (reelId) {
        reelIdsByIndex.set(index, reelId);
      }

      if (reelOwnerId) {
        reelOwnerIdsByIndex.set(index, reelOwnerId);
      }
    });

    const reelsById = await this.loadReelMap([
      ...new Set(reelIdsByIndex.values()),
    ]);

    for (const [index, reelId] of reelIdsByIndex.entries()) {
      if (reelOwnerIdsByIndex.has(index)) {
        continue;
      }

      const reelOwnerId = this.getNonEmptyString(reelsById.get(reelId)?.userId);
      if (reelOwnerId) {
        reelOwnerIdsByIndex.set(index, reelOwnerId);
      }
    }

    const authorsById = await this.reelAuthorService.loadAuthorMap([
      ...new Set(reelOwnerIdsByIndex.values()),
    ]);

    return messages.map((message, index) =>
      this.buildReelOwnerEnrichedMessageResponse(
        message,
        reelOwnerIdsByIndex.get(index) ?? null,
        reelIdsByIndex.get(index)
          ? (reelsById.get(reelIdsByIndex.get(index)!) ?? null)
          : null,
        authorsById,
      ),
    );
  }

  private async enrichReelOwnerInMessageResponse(
    message: MessageDto,
  ): Promise<MessageDto> {
    const [enrichedMessage] = await this.enrichReelOwnersInMessageResponses([
      message,
    ]);

    return enrichedMessage;
  }

  private buildReelOwnerEnrichedMessageResponse(
    message: MessageDto,
    reelOwnerId: string | null,
    reel: Reel | null,
    authorsById: Parameters<ReelAuthorService['resolveAuthor']>[0],
  ): MessageDto {
    const media = this.getMediaRecord(message.media);
    if (!media || !this.isReelLikeMessage(message)) {
      return message;
    }

    const resolvedReelId = this.getNonEmptyString(media.reelId) ?? reel?.id;
    const resolvedReelOwnerId =
      reelOwnerId ?? this.getNonEmptyString(media.reelOwnerId);
    const author = resolvedReelOwnerId
      ? this.reelAuthorService.resolveAuthor(authorsById, resolvedReelOwnerId)
      : null;
    const reelTitle = this.getNonEmptyString(media.reelTitle) ?? reel?.title;
    const reelDescription =
      this.getNonEmptyString(media.reelDescription) ?? reel?.description;
    const reelTags =
      this.normalizeStringArray(media.reelTags) ??
      this.normalizeStringArray(reel?.tags);

    return {
      ...message,
      media: {
        ...media,
        ...(resolvedReelId ? { reelId: resolvedReelId } : {}),
        ...(resolvedReelOwnerId ? { reelOwnerId: resolvedReelOwnerId } : {}),
        ...(author?.username
          ? { reelOwnerUsername: author.username }
          : this.getNonEmptyString(media.reelOwnerUsername)
            ? {
                reelOwnerUsername: this.getNonEmptyString(
                  media.reelOwnerUsername,
                )!,
              }
            : {}),
        ...(author?.avatarUrl
          ? { reelOwnerAvatarUrl: author.avatarUrl }
          : this.getNonEmptyString(media.reelOwnerAvatarUrl)
            ? {
                reelOwnerAvatarUrl: this.getNonEmptyString(
                  media.reelOwnerAvatarUrl,
                )!,
              }
            : {}),
        ...(reelTitle ? { reelTitle } : {}),
        ...(reelDescription ? { reelDescription } : {}),
        ...(reelTags !== undefined ? { reelTags } : {}),
      } as MessageDto['media'],
    };
  }

  private getMediaRecord(
    media: MessageDto['media'] | undefined,
  ): Record<string, unknown> | null {
    if (!media || typeof media !== 'object' || Array.isArray(media)) {
      return null;
    }

    return media;
  }

  private isReelLikeMessage(
    message: Pick<MessageDto, 'type' | 'media'>,
  ): boolean {
    const media = this.getMediaRecord(message.media);

    return (
      message.type === 'reel' ||
      (media !== null &&
        (this.getNonEmptyString(media.mimeType) ===
          'application/vnd.velora.reel' ||
          this.getNonEmptyString(media.reelId) !== null))
    );
  }

  private getNonEmptyString(value: unknown): string | null {
    if (typeof value !== 'string') {
      return null;
    }

    const normalized = value.trim();
    return normalized.length > 0 ? normalized : null;
  }

  private normalizeStringArray(value: unknown): string[] | undefined {
    if (!Array.isArray(value)) {
      return undefined;
    }

    return value.filter(
      (item): item is string =>
        typeof item === 'string' && item.trim().length > 0,
    );
  }

  private async loadReelMap(reelIds: string[]): Promise<Map<string, Reel>> {
    const uniqueReelIds = [...new Set(reelIds.filter(Boolean))];

    if (uniqueReelIds.length === 0) {
      return new Map();
    }

    const reels = await Promise.all(
      uniqueReelIds.map(async (reelId) => {
        try {
          const reel = await lastValueFrom(
            this.contentClient.send<Reel | null>('content.get_reel', {
              reelId,
            }),
          );

          return reel ? ([reelId, reel] as const) : null;
        } catch {
          return null;
        }
      }),
    );

    return new Map(
      reels.filter((entry): entry is readonly [string, Reel] => entry !== null),
    );
  }

  @Post()
  @ApiOperation({ summary: 'Tạo cuộc hội thoại mới' })
  @ApiBody({ type: CreateConversationDto })
  async createConversation(
    @Body() body: unknown,
    @CurrentUser() user: AuthUser,
  ): Promise<{ id: string }> {
    const rawBody =
      body && typeof body === 'object' ? (body as Record<string, unknown>) : {};
    const participantIds = Array.isArray(rawBody.participantIds)
      ? rawBody.participantIds
          .filter(
            (participantId): participantId is string =>
              typeof participantId === 'string',
          )
          .map((participantId) => participantId.trim())
          .filter(Boolean)
      : [];

    const parsed = CreateConversationSchema.safeParse({
      ...rawBody,
      participantIds,
    });
    if (!parsed.success) {
      throw new BadRequestException(parsed.error.flatten());
    }

    return await lastValueFrom(
      this.conversationClient.send<{ id: string }>('create_conversation', {
        participantIds: parsed.data.participantIds,
        ...(parsed.data.type !== undefined ? { type: parsed.data.type } : {}),
        ...(parsed.data.isGroup !== undefined
          ? { isGroup: parsed.data.isGroup }
          : {}),
        ...(parsed.data.name !== undefined ? { name: parsed.data.name } : {}),
        ...(parsed.data.picture !== undefined
          ? { picture: parsed.data.picture }
          : {}),
        creatorId: user.id,
      }),
    );
  }

  @Get()
  @ApiOperation({ summary: 'Lấy danh sách hội thoại (Pagination)' })
  @ApiQuery({ name: 'limit', required: false, type: Number })
  @ApiQuery({ name: 'cursor', required: false, type: String })
  getMyConversations(
    @CurrentUser() user: AuthUser,
    @Query('limit') limit?: number,
    @Query('cursor') cursor?: string,
  ) {
    return this.conversationClient.send('get_user_conversations', {
      userId: user.id,
      limit: limit ? Number(limit) : 15,
      cursor,
    });
  }

  @Get(':id/messages')
  @ApiOperation({ summary: 'Lấy lịch sử tin nhắn (Pagination)' })
  @ApiOkResponse({ type: [MessageDto] })
  @ApiQuery({ name: 'limit', required: false, type: Number })
  @ApiQuery({ name: 'cursor', required: false, type: String })
  async getMessages(
    @Param('id') conversationId: string,
    @CurrentUser() user: AuthUser,
    @Query('limit') limit?: number,
    @Query('cursor') cursor?: string,
  ): Promise<MessageDto[]> {
    const messages = await lastValueFrom(
      this.conversationClient.send<MessageDto[]>('get_messages', {
        conversationId,
        userId: user.id,
        limit: limit ? Number(limit) : 20,
        cursor,
      }),
    );

    return await this.enrichReelOwnersInMessageResponses(messages);
  }

  @Get(':id/messages/around/:messageId')
  @ApiOperation({ summary: 'Lấy cửa sổ tin nhắn quanh một tin nhắn mục tiêu' })
  @ApiOkResponse({ type: MessageDto, isArray: true })
  @ApiQuery({ name: 'before', required: false, type: Number })
  @ApiQuery({ name: 'after', required: false, type: Number })
  async getMessagesAround(
    @Param('id') conversationId: string,
    @Param('messageId') messageId: string,
    @CurrentUser() user: AuthUser,
    @Query('before') before?: number,
    @Query('after') after?: number,
  ): Promise<MessageAnchorWindowResponse> {
    const response = await lastValueFrom(
      this.conversationClient.send<MessageAnchorWindowResponse>(
        'get_messages_around',
        {
          conversationId,
          userId: user.id,
          messageId,
          before: before ? Number(before) : 30,
          after: after ? Number(after) : 30,
        },
      ),
    );

    return {
      ...response,
      messages: await this.enrichReelOwnersInMessageResponses(
        response.messages,
      ),
    };
  }

  @Get(':id/messages/anchor/older')
  @ApiOperation({ summary: 'Lấy thêm tin nhắn cũ hơn trong anchor timeline' })
  @ApiQuery({ name: 'cursor', required: true, type: String })
  @ApiQuery({ name: 'limit', required: false, type: Number })
  async getAnchorOlderMessages(
    @Param('id') conversationId: string,
    @CurrentUser() user: AuthUser,
    @Query('cursor') cursor: string,
    @Query('limit') limit?: number,
  ): Promise<MessageAnchorExpansionResponse> {
    if (typeof cursor !== 'string' || cursor.trim().length === 0) {
      throw new BadRequestException('cursor must be a non-empty string');
    }

    const response = await lastValueFrom(
      this.conversationClient.send<MessageAnchorExpansionResponse>(
        'get_anchor_older_messages',
        {
          conversationId,
          userId: user.id,
          cursor: cursor.trim(),
          limit: limit ? Number(limit) : 30,
        },
      ),
    );

    return {
      ...response,
      messages: await this.enrichReelOwnersInMessageResponses(
        response.messages,
      ),
    };
  }

  @Get(':id/messages/anchor/newer')
  @ApiOperation({ summary: 'Lấy thêm tin nhắn mới hơn trong anchor timeline' })
  @ApiQuery({ name: 'cursor', required: true, type: String })
  @ApiQuery({ name: 'limit', required: false, type: Number })
  async getAnchorNewerMessages(
    @Param('id') conversationId: string,
    @CurrentUser() user: AuthUser,
    @Query('cursor') cursor: string,
    @Query('limit') limit?: number,
  ): Promise<MessageAnchorExpansionResponse> {
    if (typeof cursor !== 'string' || cursor.trim().length === 0) {
      throw new BadRequestException('cursor must be a non-empty string');
    }

    const response = await lastValueFrom(
      this.conversationClient.send<MessageAnchorExpansionResponse>(
        'get_anchor_newer_messages',
        {
          conversationId,
          userId: user.id,
          cursor: cursor.trim(),
          limit: limit ? Number(limit) : 30,
        },
      ),
    );

    return {
      ...response,
      messages: await this.enrichReelOwnersInMessageResponses(
        response.messages,
      ),
    };
  }

  @Post(':id/messages')
  @ApiOperation({ summary: 'Gửi tin nhắn theo conversation id (HTTP)' })
  @ApiOkResponse({ type: MessageDto })
  async createMessageForConversation(
    @Param('id') conversationId: string,
    @Body()
    body: {
      clientMessageId?: string;
      content?: string;
      type?: 'text' | 'image' | 'video' | 'file' | 'call' | 'reel';
      media?: {
        fileKey?: string;
        fileUrl: string;
        thumbnailKey?: string;
        thumbnailUrl?: string;
        mimeType?: string;
        width?: number;
        height?: number;
        durationMs?: number;
        status?: 'ready' | 'processing' | 'failed';
        failureReason?: string;
        reelId?: string;
        reelOwnerId?: string;
        reelOwnerUsername?: string;
        reelOwnerAvatarUrl?: string;
        reelTitle?: string;
        reelDescription?: string;
        reelTags?: string[];
      };
      replyToId?: string;
    },
    @CurrentUser() user: AuthUser,
  ): Promise<MessageDto> {
    if (typeof body?.content !== 'string' || body.content.trim().length === 0) {
      throw new BadRequestException('Content cannot be empty');
    }

    if (
      typeof body?.clientMessageId !== 'string' ||
      body.clientMessageId.trim().length === 0 ||
      body.clientMessageId.length > 200
    ) {
      throw new BadRequestException('clientMessageId is required');
    }

    const type = body?.type ?? 'text';
    if (!['text', 'image', 'video', 'file', 'call', 'reel'].includes(type)) {
      throw new BadRequestException('Invalid message type');
    }

    if (
      body?.replyToId !== undefined &&
      (typeof body.replyToId !== 'string' || body.replyToId.trim().length === 0)
    ) {
      throw new BadRequestException('replyToId must be a non-empty string');
    }

    const response = await lastValueFrom(
      this.conversationClient.send<CreateMessageResponse>('create_message', {
        conversationId,
        clientMessageId: body.clientMessageId.trim(),
        content: body.content.trim(),
        media: body.media,
        type,
        replyToId: body.replyToId,
        senderId: user.id,
      }),
    );

    return await this.enrichReelOwnerInMessageResponse(response.message);
  }

  @Patch(':id/messages/:messageId')
  @ApiOperation({ summary: 'Cập nhật tin nhắn (chưa được hỗ trợ)' })
  updateMessage(): never {
    throw new NotImplementedException(
      'Message editing is not implemented by conversation-service yet',
    );
  }

  @Delete(':id/messages/:messageId')
  @ApiOperation({ summary: 'Xóa tin nhắn (chưa được hỗ trợ)' })
  deleteMessage(): never {
    throw new NotImplementedException(
      'Message deletion is not implemented by conversation-service yet',
    );
  }

  @Post(':id/read')
  @ApiOperation({ summary: 'Đánh dấu hội thoại đã đọc' })
  async markConversationSeen(
    @Param('id') conversationId: string,
    @CurrentUser() user: AuthUser,
  ): Promise<{ updatedCount: number }> {
    return await lastValueFrom(
      this.conversationClient.send<{ updatedCount: number }>(
        'mark_conversation_seen',
        {
          conversationId,
          userId: user.id,
        },
      ),
    );
  }

  @Patch(':id')
  @ApiOperation({ summary: 'Cập nhật metadata của group conversation' })
  @ApiBody({ type: UpdateGroupConversationDto })
  async updateGroupConversation(
    @Param('id') conversationId: string,
    @Body() body: unknown,
    @CurrentUser() user: AuthUser,
  ): Promise<ConversationDto> {
    const parsed = UpdateGroupConversationSchema.safeParse(body);
    if (!parsed.success) {
      throw new BadRequestException(parsed.error.flatten());
    }

    return await lastValueFrom(
      this.conversationClient.send<ConversationDto>(
        'update_group_conversation',
        {
          conversationId,
          actorUserId: user.id,
          ...parsed.data,
        },
      ),
    );
  }

  @Patch(':id/owner')
  @ApiOperation({ summary: 'Chuyển quyền sở hữu group conversation' })
  @ApiBody({ type: TransferGroupOwnershipDto })
  async transferGroupOwnership(
    @Param('id') conversationId: string,
    @Body() body: unknown,
    @CurrentUser() user: AuthUser,
  ): Promise<ConversationDto> {
    const parsed = TransferGroupOwnershipSchema.safeParse(body);
    if (!parsed.success) {
      throw new BadRequestException(parsed.error.flatten());
    }

    return await lastValueFrom(
      this.conversationClient.send<ConversationDto>(
        'transfer_group_ownership',
        {
          conversationId,
          actorUserId: user.id,
          userId: parsed.data.userId,
        },
      ),
    );
  }

  @Get(':id/members')
  @ApiOperation({ summary: 'Lấy danh sách thành viên hội thoại' })
  async getConversationMembers(
    @Param('id') conversationId: string,
    @CurrentUser() user: AuthUser,
  ) {
    const conversation = await lastValueFrom(
      this.conversationClient.send<{
        createdAt?: string;
        participants?: ConversationParticipantPayload[];
        memberJoinedAt?: Record<string, string>;
      }>('get_conversation_detail', {
        id: conversationId,
        userId: user.id,
      }),
    );

    const fallbackJoinedAt =
      conversation?.createdAt ?? new Date(0).toISOString();

    return Array.isArray(conversation?.participants)
      ? conversation.participants.map((participant) => ({
          userId: participant.id,
          user: {
            id: participant.id,
            email: participant.email ?? '',
            ...(participant.picture || participant.avatar
              ? { picture: participant.picture ?? participant.avatar }
              : {}),
          },
          joinedAt:
            conversation.memberJoinedAt?.[participant.id] ?? fallbackJoinedAt,
        }))
      : [];
  }

  @Post(':id/members')
  @ApiOperation({ summary: 'Thêm thành viên vào group conversation' })
  @ApiBody({ type: AddConversationMemberDto })
  async addMember(
    @Param('id') conversationId: string,
    @Body() body: unknown,
    @CurrentUser() user: AuthUser,
  ): Promise<{
    userId: string;
    user: { id: string; email: string; picture?: string };
    joinedAt: string;
  }> {
    const parsed = AddConversationMemberSchema.safeParse(body);
    if (!parsed.success) {
      throw new BadRequestException(parsed.error.flatten());
    }

    const conversation = await lastValueFrom(
      this.conversationClient.send<{
        createdAt?: string;
        participants?: ConversationParticipantPayload[];
        memberJoinedAt?: Record<string, string>;
      }>('add_conversation_member', {
        conversationId,
        actorUserId: user.id,
        userId: parsed.data.userId,
      }),
    );
    const participant = conversation.participants?.find(
      (candidate) => candidate.id === parsed.data.userId,
    );
    const fallbackJoinedAt =
      conversation.createdAt ?? new Date(0).toISOString();

    return {
      userId: parsed.data.userId,
      user: {
        id: parsed.data.userId,
        email: participant?.email ?? '',
        ...(participant?.picture || participant?.avatar
          ? { picture: participant.picture ?? participant.avatar }
          : {}),
      },
      joinedAt:
        conversation.memberJoinedAt?.[parsed.data.userId] ?? fallbackJoinedAt,
    };
  }

  @Delete(':id/members/:userId')
  @ApiOperation({ summary: 'Xóa thành viên khỏi group conversation' })
  async removeMember(
    @Param('id') conversationId: string,
    @Param('userId') userId: string,
    @CurrentUser() user: AuthUser,
  ) {
    return await lastValueFrom(
      this.conversationClient.send('remove_conversation_member', {
        conversationId,
        actorUserId: user.id,
        userId,
      }),
    );
  }

  @Post(':id/leave')
  @ApiOperation({ summary: 'Rời group conversation' })
  async leaveGroup(
    @Param('id') conversationId: string,
    @CurrentUser() user: AuthUser,
  ) {
    return await lastValueFrom(
      this.conversationClient.send('leave_group_conversation', {
        conversationId,
        actorUserId: user.id,
      }),
    );
  }

  @Post(':id/messages/:messageId/recall')
  @ApiOperation({ summary: 'Thu hồi một tin nhắn' })
  @ApiOkResponse({ type: MessageDto })
  async recallMessage(
    @Param('id') conversationId: string,
    @Param('messageId') messageId: string,
    @CurrentUser() user: AuthUser,
  ): Promise<MessageDto> {
    if (!/^[0-9a-fA-F]{24}$/.test(messageId)) {
      throw new BadRequestException('Invalid message ID');
    }

    const source$ = this.conversationClient.send('recall_message', {
      conversationId,
      messageId,
      userId: user.id,
    });

    return (await lastValueFrom(source$)) as MessageDto;
  }

  // --- 3. LẤY CHI TIẾT CONVERSATION ---
  @Get(':id')
  @ApiOperation({ summary: 'Lấy thông tin cuộc hội thoại' })
  async getConversation(
    @Param('id') id: string,
    @CurrentUser() user: AuthUser,
  ): Promise<ConversationDto> {
    return await lastValueFrom(
      this.conversationClient.send<ConversationDto>('get_conversation_detail', {
        id,
        userId: user.id,
      }),
    );
  }

  @Post('message')
  @ApiOperation({ summary: 'Gửi tin nhắn (HTTP)' })
  @ApiBody({ type: CreateMessageDto })
  @ApiOkResponse({ type: MessageDto })
  async createMessage(
    @Body() body: CreateMessageDto,
    @CurrentUser() user: AuthUser,
  ): Promise<MessageDto> {
    const response = await lastValueFrom(
      this.conversationClient.send<CreateMessageResponse>('create_message', {
        ...body,
        senderId: user.id,
      }),
    );
    return await this.enrichReelOwnerInMessageResponse(response.message);
  }

  @Post('chat')
  @ApiOperation({
    summary:
      'Chat with AI Bot — creates/finds bot conversation then sends message. Bot reply comes via WebSocket.',
  })
  @ApiBody({ type: ChatWithBotDto })
  @ApiOkResponse({ type: MessageDto })
  async chatWithBot(
    @Body() body: ChatWithBotDto,
    @CurrentUser() user: AuthUser,
  ): Promise<MessageDto> {
    const botParticipantId = BOT_USER_ID;

    const convResult = await lastValueFrom(
      this.conversationClient.send<{ id: string }>('create_conversation', {
        participantIds: [user.id, botParticipantId],
        isGroup: false,
      }),
    );

    const messageResponse = await lastValueFrom(
      this.conversationClient.send<CreateMessageResponse>('create_message', {
        content: body.content,
        type: body.type,
        conversationId: convResult.id,
        senderId: user.id,
      }),
    );

    return messageResponse.message;
  }
}
