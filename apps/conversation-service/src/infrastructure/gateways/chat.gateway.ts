import { CreateMessageDto } from '@common/conversation/dtos/create-message.dto';
import type { AuthUser } from '@common/auth/interfaces/auth-user.interface';
import {
  ForbiddenException,
  Inject,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { ClientProxy } from '@nestjs/microservices';
import {
  ConnectedSocket,
  MessageBody,
  OnGatewayConnection,
  OnGatewayDisconnect,
  SubscribeMessage,
  WebSocketGateway,
  WebSocketServer,
} from '@nestjs/websockets';
import { catchError, lastValueFrom, of, timeout } from 'rxjs';
import Redis from 'ioredis';
import { Server, Socket } from 'socket.io';
import { SendMessageUseCase } from '../../application/use-cases/send-message.use-case';
import { TriggerBotReplyUseCase } from '../../application/use-cases/trigger-bot-reply.use-case';
import { Conversation } from '../../domain/entities/conversation.entity';
import {
  type Message,
  type MessageMedia,
} from '../../domain/entities/message.entity';
import type { BotError } from '../../domain/interfaces/ai-service.interface';
import { IChatRepository } from '../../domain/interfaces/chat.repository.interface';
import { NotificationServiceAdapter } from '../adapters/notification-service.adapter';
import { ConversationPrometheusMetricsService } from '../metrics/conversation-prometheus-metrics.service';
import { ChatMapper } from '../repositories/chat.mapper';

interface PresencePayload {
  userId?: string;
  userIds?: string[];
  conversationId?: string;
}

@WebSocketGateway({ cors: { origin: '*' } })
export class ChatGateway implements OnGatewayConnection, OnGatewayDisconnect {
  @WebSocketServer()
  server!: Server;

  private readonly logger = new Logger(ChatGateway.name);
  private static readonly LAST_SEEN_KEY_PREFIX = 'presence:last-seen:';

  constructor(
    private readonly sendMessageUseCase: SendMessageUseCase,
    private readonly triggerBotReplyUseCase: TriggerBotReplyUseCase,
    private readonly notificationService: NotificationServiceAdapter,
    private readonly prometheusMetrics: ConversationPrometheusMetricsService,
    @Inject('IChatRepository') private readonly chatRepository: IChatRepository,
    @Inject('AUTH_SERVICE_RMQ') private readonly authClient: ClientProxy,
    @Inject('REDIS_CLIENT') private readonly redis: Redis,
  ) {}

  // --- 1. HANDLE CONNECTION ---
  async handleConnection(client: Socket) {
    const userId = await this.resolveUserId(client);
    if (userId) {
      const wasOnlineBefore = await this.isUserOnline(userId);

      await client.join(this.userRooms(userId));
      await this.clearLastSeenAt(userId);

      if (!wasOnlineBefore) {
        await this.emitPresenceStateToAudience(userId, null);
      }

      console.log(`Client connected: ${client.id} (User: ${userId})`);
      return;
    }

    client.disconnect(true);
  }

  // --- 2. HANDLE DISCONNECT ---
  async handleDisconnect(client: Socket) {
    const userId = this.getResolvedUserId(client);

    if (userId) {
      const isStillOnline = await this.isUserOnline(userId);

      if (!isStillOnline) {
        const lastSeenAt = new Date().toISOString();
        await this.setLastSeenAt(userId, lastSeenAt);
        await this.emitPresenceStateToAudience(userId, lastSeenAt);
      }
    }

    console.log(`Client disconnected: ${client.id}`);
  }

  emitToConversation(
    conversationId: string,
    eventName: string,
    payload: unknown,
  ): void {
    this.server
      .to(this.conversationRooms(conversationId))
      .emit(eventName, payload);
  }

  emitBotReplyFailure(
    userMessage: Pick<Message, 'id' | 'conversationId' | 'clientMessageId'>,
    error: BotError,
  ): void {
    this.emitToConversation(userMessage.conversationId, 'bot_reply_failed', {
      conversationId: userMessage.conversationId,
      userMessageId: userMessage.id,
      clientMessageId: userMessage.clientMessageId,
      error: {
        code: error.code,
        message:
          error.code === 'NO_CONTENT'
            ? 'No relevant video content found for this query.'
            : 'AI service is temporarily unavailable',
      },
    });
  }

  emitToUsers(userIds: string[], eventName: string, payload: unknown): void {
    const rooms = Array.from(
      new Set(
        userIds.filter(Boolean).flatMap((userId) => this.userRooms(userId)),
      ),
    );

    if (rooms.length === 0) {
      return;
    }

    this.server.to(rooms).emit(eventName, payload);
  }

  emitConversationCreated(
    conversation: Conversation,
    userIds: string[] = conversation.participantIds,
  ): void {
    this.emitToUsers(
      userIds,
      'conversation_created',
      ChatMapper.conversationToDto(conversation),
    );
  }

  emitConversationUpdated(
    conversation: Conversation,
    userIds: string[] = conversation.participantIds,
  ): void {
    this.emitToUsers(
      userIds,
      'conversation_updated',
      ChatMapper.conversationToDto(conversation),
    );
  }

  emitConversationMessageActivity(
    conversation: Conversation,
    message: Message,
    actorUserId: string,
  ): void {
    const recipientUserIds = conversation.participantIds.filter(
      (participantId) => participantId !== actorUserId,
    );

    this.emitToUsers(recipientUserIds, 'conversation_message_activity', {
      conversation: ChatMapper.conversationToDto(conversation),
      message: ChatMapper.toDto(message),
    });
  }

  evictConversationMember(input: {
    conversationId: string;
    userId: string;
    reason: 'removed' | 'left';
  }): void {
    this.emitToUsers([input.userId], 'conversation_removed', {
      conversationId: input.conversationId,
      reason: input.reason,
    });

    // Stage 1 of the rolling room migration targets both legacy raw rooms and
    // namespaced rooms. The Socket.IO adapter treats room arrays as a union,
    // so a dual-joined socket receives one event and is evicted once.
    this.server
      .in(this.userRooms(input.userId))
      .socketsLeave(this.conversationRooms(input.conversationId));
  }

  emitMediaProcessingCompleted(
    conversationId: string,
    payload: {
      fileKey: string;
      messageIds: string[];
      media: MessageMedia;
    },
  ) {
    this.emitToConversation(conversationId, 'media_processing_completed', {
      conversationId,
      ...payload,
    });
  }

  emitMediaProcessingFailed(
    conversationId: string,
    payload: {
      fileKey: string;
      messageIds: string[];
      media: MessageMedia;
    },
  ) {
    this.emitToConversation(conversationId, 'media_processing_failed', {
      conversationId,
      ...payload,
    });
  }

  // --- 3. HANDLE MESSAGE (CORE) ---
  @SubscribeMessage('send_message')
  async handleMessage(
    @MessageBody() payload: CreateMessageDto,
    @ConnectedSocket() client: Socket,
  ) {
    const startedAt = process.hrtime.bigint();
    const senderId = await this.resolveUserId(client);
    if (!senderId) {
      this.recordSendMessageOutcome(startedAt, 'rejected');
      return;
    }

    if (!payload.clientMessageId?.trim()) {
      client.emit('message_failed', {
        conversationId: payload.conversationId,
        clientMessageId: payload.clientMessageId,
      });
      this.recordSendMessageOutcome(startedAt, 'rejected');
      return;
    }

    try {
      await this.chatRepository.assertConversationParticipant(
        payload.conversationId,
        senderId,
      );
    } catch (error) {
      this.logger.warn(
        `Rejected send_message for socket ${client.id}: ${(error as Error).message}`,
      );
      this.server.to(client.id).emit('message_failed', {
        conversationId: payload.conversationId,
        clientMessageId: payload.clientMessageId,
      });
      this.recordSendMessageOutcome(startedAt, 'rejected');
      return;
    }

    try {
      const result = await this.sendMessageUseCase.execute(payload, senderId);
      const savedMessage = result.message;
      const savedMessageDto = ChatMapper.toDto(savedMessage);

      if (result.created) {
        this.prometheusMetrics.recordMessageCreated();
      }

      // Always reconcile the sending socket. For an idempotent retry this is
      // the only event: all fan-out must happen exactly once.
      client.emit('message_synced', savedMessageDto);

      if (!result.created) {
        this.recordSendMessageOutcome(startedAt, 'success');
        return;
      }

      client
        .to(this.conversationRooms(payload.conversationId))
        .emit('new_message', savedMessageDto);

      // Update conversation sidebar for all participants (lastMessage, ordering)
      const conversation = await this.chatRepository.findConversation(
        payload.conversationId,
      );
      if (conversation) {
        conversation.lastMessage =
          savedMessage.content ?? savedMessage.type ?? null;
        conversation.lastMessageAt = savedMessage.createdAt;
        this.emitToConversation(
          payload.conversationId,
          'conversation_updated',
          ChatMapper.conversationToDto(conversation),
        );
        this.emitConversationMessageActivity(
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
        async (botResult) => {
          if (botResult.botReply) {
            this.emitToConversation(
              savedMessage.conversationId,
              'new_message',
              ChatMapper.toDto(botResult.botReply),
            );

            // Update conversation sidebar with bot reply as lastMessage
            const botConversation = await this.chatRepository.findConversation(
              savedMessage.conversationId,
            );
            if (botConversation) {
              botConversation.lastMessage =
                botResult.botReply.content ?? botResult.botReply.type ?? null;
              botConversation.lastMessageAt = botResult.botReply.createdAt;
              this.emitToConversation(
                savedMessage.conversationId,
                'conversation_updated',
                ChatMapper.conversationToDto(botConversation),
              );
              this.emitConversationMessageActivity(
                botConversation,
                botResult.botReply,
                botResult.botReply.senderId,
              );
            }
          } else if (botResult.botError) {
            this.emitBotReplyFailure(savedMessage, botResult.botError);
          }
        },
        (err) => {
          this.logger.warn(
            `Bot reply trigger failed: ${(err as Error).message}`,
          );
          this.emitBotReplyFailure(savedMessage, {
            code: 'UNKNOWN',
            message: 'AI service is temporarily unavailable',
          });
        },
      );

      this.recordSendMessageOutcome(startedAt, 'success');
    } catch {
      this.recordSendMessageOutcome(startedAt, 'error');
      this.server.to(client.id).emit('message_failed', {
        conversationId: payload.conversationId,
        clientMessageId: payload.clientMessageId,
      });
    }
  }

  @SubscribeMessage('join_conversation')
  async handleJoinConversation(
    @MessageBody() conversationId: string,
    @ConnectedSocket() client: Socket,
  ) {
    const userId = await this.resolveUserId(client);
    if (!userId) return;

    try {
      await this.chatRepository.assertConversationParticipant(
        conversationId,
        userId,
      );
    } catch (error) {
      this.logger.warn(
        `Rejected join_conversation for socket ${client.id}: ${(error as Error).message}`,
      );

      if (
        error instanceof ForbiddenException ||
        error instanceof NotFoundException
      ) {
        client.emit('conversation_removed', {
          conversationId,
          reason: 'removed',
        });
      }
      return;
    }

    void client.join(this.conversationRooms(conversationId));
    console.log(`Client ${client.id} joined room ${conversationId}`);
  }

  // --- 4. WEBRTC SIGNALING ---
  @SubscribeMessage('offer')
  async handleOffer(
    @MessageBody() data: Record<string, unknown>,
    @ConnectedSocket() client: Socket,
  ) {
    const senderId = await this.resolveUserId(client);
    this.relaySignal(client, 'offer', data, senderId);
  }

  @SubscribeMessage('answer')
  async handleAnswer(
    @MessageBody() data: Record<string, unknown>,
    @ConnectedSocket() client: Socket,
  ) {
    const senderId = await this.resolveUserId(client);
    this.relaySignal(client, 'answer', data, senderId);
  }

  @SubscribeMessage('ice_candidate')
  async handleIceCandidate(
    @MessageBody() data: Record<string, unknown>,
    @ConnectedSocket() client: Socket,
  ) {
    const senderId = await this.resolveUserId(client);
    this.relaySignal(client, 'ice_candidate', data, senderId);
  }

  // --- 5. TYPING INDICATOR ---
  @SubscribeMessage('typing_start')
  async handleTypingStart(
    @MessageBody() conversationId: string,
    @ConnectedSocket() client: Socket,
  ) {
    const userId = await this.resolveUserId(client);
    if (!userId) return;

    try {
      await this.chatRepository.assertConversationParticipant(
        conversationId,
        userId,
      );
    } catch (error) {
      this.logger.warn(
        `Rejected typing_start for socket ${client.id}: ${(error as Error).message}`,
      );
      return;
    }

    client.to(this.conversationRooms(conversationId)).emit('user_typing', {
      conversationId,
      userId,
      isTyping: true,
    });
  }

  @SubscribeMessage('typing_stop')
  async handleTypingStop(
    @MessageBody() conversationId: string,
    @ConnectedSocket() client: Socket,
  ) {
    const userId = await this.resolveUserId(client);
    if (!userId) return;

    try {
      await this.chatRepository.assertConversationParticipant(
        conversationId,
        userId,
      );
    } catch (error) {
      this.logger.warn(
        `Rejected typing_stop for socket ${client.id}: ${(error as Error).message}`,
      );
      return;
    }

    client.to(this.conversationRooms(conversationId)).emit('user_typing', {
      conversationId,
      userId,
      isTyping: false,
    });
  }

  @SubscribeMessage('check_presence')
  async handleCheckPresence(
    @MessageBody()
    payload: string | PresencePayload,
    @ConnectedSocket() client: Socket,
  ) {
    const requesterId = await this.resolveUserId(client);
    if (!requesterId) return;

    const targetUserIds = this.normalizePresenceTargets(payload);
    const conversationId =
      typeof payload === 'object' && payload !== null
        ? payload.conversationId
        : undefined;

    if (targetUserIds.length === 0) {
      return;
    }

    await Promise.all(
      targetUserIds.map(async (targetUserId) => {
        const canAccessPresence = await this.canAccessPresence({
          requesterId,
          targetUserId,
          conversationId,
        });

        if (!canAccessPresence) {
          return;
        }

        client.emit(
          'presence_update',
          await this.buildPresencePayload(targetUserId),
        );
      }),
    );
  }

  // --- PRIVATE HELPERS ---
  private recordSendMessageOutcome(
    startedAt: bigint,
    status: 'success' | 'rejected' | 'error',
  ): void {
    const durationSeconds =
      Number(process.hrtime.bigint() - startedAt) / 1_000_000_000;
    this.prometheusMetrics.recordSendMessage(status, durationSeconds);
  }

  // Stage 1 keeps the legacy raw room and adds the namespaced room. Once all
  // conversation-service instances have this code, a later rollout can switch
  // readers/emitters to namespaced-only and finally remove the raw room.
  private userRooms(userId: string): string[] {
    return [userId, `user:${userId}`];
  }

  private conversationRooms(conversationId: string): string[] {
    return [conversationId, `conversation:${conversationId}`];
  }

  private getLastSeenKey(userId: string): string {
    return `${ChatGateway.LAST_SEEN_KEY_PREFIX}${userId}`;
  }

  private async getLastSeenAt(userId: string): Promise<string | null> {
    const value = await this.redis.get(this.getLastSeenKey(userId));

    if (!value) {
      return null;
    }

    return Number.isNaN(new Date(value).getTime()) ? null : value;
  }

  private async setLastSeenAt(
    userId: string,
    lastSeenAt: string,
  ): Promise<void> {
    await this.redis.set(this.getLastSeenKey(userId), lastSeenAt);
  }

  private async clearLastSeenAt(userId: string): Promise<void> {
    await this.redis.del(this.getLastSeenKey(userId));
  }

  private async buildPresencePayload(userId: string): Promise<{
    userId: string;
    isOnline: boolean;
    lastSeenAt: string | null;
  }> {
    const isOnline = await this.isUserOnline(userId);

    return {
      userId,
      isOnline,
      lastSeenAt: isOnline ? null : await this.getLastSeenAt(userId),
    };
  }

  private async canAccessPresence({
    requesterId,
    targetUserId,
    conversationId,
  }: {
    requesterId: string;
    targetUserId: string;
    conversationId?: string;
  }): Promise<boolean> {
    if (!requesterId || !targetUserId || requesterId === targetUserId) {
      return false;
    }

    if (conversationId) {
      try {
        await Promise.all([
          this.chatRepository.assertConversationParticipant(
            conversationId,
            requesterId,
          ),
          this.chatRepository.assertConversationParticipant(
            conversationId,
            targetUserId,
          ),
        ]);

        return true;
      } catch {
        return false;
      }
    }

    return this.chatRepository.hasSharedConversation(requesterId, targetUserId);
  }

  private async emitPresenceStateToAudience(
    userId: string,
    lastSeenAt: string | null,
  ): Promise<void> {
    const audienceUserIds =
      await this.chatRepository.findPresenceAudienceUserIds(userId);

    if (!audienceUserIds.length) {
      return;
    }

    const payload = {
      userId,
      lastSeenAt,
    };

    const eventName = lastSeenAt ? 'user:offline' : 'user:online';

    this.emitToUsers(audienceUserIds, eventName, payload);
  }

  private normalizePresenceTargets(
    payload: string | PresencePayload,
  ): string[] {
    if (typeof payload === 'string' && payload.trim()) {
      return [payload.trim()];
    }

    const payloadObject =
      typeof payload === 'object' && payload !== null ? payload : undefined;
    const rawIds = [
      payloadObject?.userId,
      ...(Array.isArray(payloadObject?.userIds) ? payloadObject.userIds : []),
    ];

    return Array.from(
      new Set(
        rawIds.filter(
          (userId): userId is string =>
            typeof userId === 'string' && userId.trim().length > 0,
        ),
      ),
    );
  }

  private getResolvedUserId(client: Socket): string | null {
    const socketData = client.data as Record<string, unknown>;
    const cachedUserId = socketData['userId'];
    return typeof cachedUserId === 'string' && cachedUserId
      ? cachedUserId
      : null;
  }

  private async isUserOnline(userId: string): Promise<boolean> {
    if (!userId) {
      return false;
    }

    const sockets = await this.server.in(this.userRooms(userId)).fetchSockets();
    return sockets.length > 0;
  }

  private relaySignal(
    client: Socket,
    event: string,
    data: Record<string, unknown>,
    senderId: string | null,
  ): void {
    const toUserId = String(data['toUserId']);
    if (toUserId && senderId) {
      client
        .to(this.userRooms(toUserId))
        .emit(event, { ...data, fromUserId: senderId });
    }
  }

  private extractAccessToken(client: Socket): string | null {
    const handshakeAuth = client.handshake.auth as
      | Record<string, unknown>
      | undefined;
    const authToken = handshakeAuth?.['token'];
    if (typeof authToken === 'string' && authToken.trim()) {
      return authToken;
    }

    const authHeader = client.handshake.headers['authorization'];
    if (typeof authHeader === 'string') {
      const [type, token] = authHeader.split(' ');
      if (type === 'Bearer' && token) {
        return token;
      }
    }

    const cookieHeader = client.handshake.headers.cookie;
    if (typeof cookieHeader !== 'string') {
      return null;
    }

    const accessTokenCookie = cookieHeader
      .split(';')
      .map((part) => part.trim())
      .find((part) => part.startsWith('access_token='));

    if (!accessTokenCookie) {
      return null;
    }

    return decodeURIComponent(accessTokenCookie.slice('access_token='.length));
  }

  private async resolveUserId(client: Socket): Promise<string | null> {
    const socketData = client.data as Record<string, unknown>;
    const cachedUserId = this.getResolvedUserId(client);
    if (cachedUserId) {
      return cachedUserId;
    }

    const token = this.extractAccessToken(client);
    if (token) {
      const user = await lastValueFrom(
        this.authClient
          .send<AuthUser | null>('auth.verify_token', { token })
          .pipe(
            timeout(5000),
            catchError(() => of(null)),
          ),
        { defaultValue: null },
      );

      if (user?.id) {
        socketData['userId'] = user.id;
        return user.id;
      }

      this.logger.warn(`Socket ${client.id} provided an invalid access token`);
      client.disconnect(true);
      return null;
    }

    return null;
  }

  @SubscribeMessage('mark_seen')
  async handleMarkSeen(
    @MessageBody()
    payload:
      | string
      | {
          conversationId: string;
          upToMessageId?: string;
        },
    @ConnectedSocket() client: Socket,
  ) {
    const userId = await this.resolveUserId(client);
    if (!userId) return;

    const conversationId =
      typeof payload === 'string' ? payload : payload?.conversationId;

    if (typeof conversationId !== 'string' || !conversationId.trim()) {
      return;
    }

    const result = await this.chatRepository.markMessagesAsSeen(
      conversationId,
      userId,
      typeof payload === 'object' && payload?.upToMessageId
        ? payload.upToMessageId
        : undefined,
    );

    if (result.seenUpTo) {
      client.to(this.conversationRooms(conversationId)).emit('messages_seen', {
        conversationId,
        readByUserId: userId,
        frontierCreatedAt: result.seenUpTo.createdAt.toISOString(),
        messageId: result.seenUpTo.messageId,
        at: result.seenAt?.toISOString() ?? new Date().toISOString(),
      });
      console.log(
        `✅ [Socket] Emitted messages_seen to room ${conversationId}`,
      );
    }
  }
}
