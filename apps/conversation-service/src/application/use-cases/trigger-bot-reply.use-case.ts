import { BOT_USER_ID } from '@common/constants/seed.constants';
import { RateLimitService } from '@common/rate-limit/rate-limit.service';
import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { Message } from '../../domain/entities/message.entity';
import { Conversation } from '../../domain/entities/conversation.entity';
import type { BotError } from '../../domain/interfaces/ai-service.interface';
import { IChatRepository } from '../../domain/interfaces/chat.repository.interface';
import { ProcessBotReplyUseCase } from './process-bot-reply.use-case';

export interface TriggerBotReplyResult {
  triggered: boolean;
  botReply?: Message;
  botError?: BotError;
}

@Injectable()
export class TriggerBotReplyUseCase {
  private readonly logger = new Logger(TriggerBotReplyUseCase.name);

  constructor(
    @Inject('IChatRepository') private readonly chatRepository: IChatRepository,
    private readonly processBotReplyUseCase: ProcessBotReplyUseCase,
    @Optional() private readonly rateLimits?: RateLimitService,
  ) {}

  async execute(
    userMessage: Message,
    senderId: string,
    conversationSnapshot?: Conversation | null,
  ): Promise<TriggerBotReplyResult> {
    if (userMessage.type !== 'text' || senderId === BOT_USER_ID) {
      return { triggered: false };
    }

    // The gateway has just loaded this conversation for dispatch. Reuse that
    // snapshot instead of hydrating the same participants through User RPC twice.
    const conversation =
      conversationSnapshot === undefined
        ? await this.chatRepository.findConversation(userMessage.conversationId)
        : conversationSnapshot;

    if (!conversation?.participantIds?.includes(BOT_USER_ID)) {
      return { triggered: false };
    }

    const rateLimited = await this.checkAiTurnBudget(senderId);
    if (rateLimited) {
      return { triggered: false, botError: rateLimited };
    }

    try {
      const result = await this.processBotReplyUseCase.execute(userMessage);

      return {
        triggered: true,
        botReply: result.botReply,
        botError: result.botError,
      };
    } catch (error: unknown) {
      const msg = error instanceof Error ? error.message : String(error);
      this.logger.error(`Bot reply trigger failed: ${msg}`);
      return {
        triggered: false,
        botError: { code: 'UNKNOWN', message: msg },
      };
    }
  }

  /**
   * The authoritative RAG budget. REST (`create_message`) and WebSocket
   * (`send_message`) both converge here, so one limit covers every client.
   * The user message is already stored; only the paid AI turn is withheld.
   */
  private async checkAiTurnBudget(userId: string): Promise<BotError | null> {
    if (!this.rateLimits) return null;
    for (const policy of ['ai_turn_minute', 'ai_turn_day'] as const) {
      const decision = await this.rateLimits.check(policy, `u:${userId}`);
      if (!decision.allowed) {
        this.rateLimits.logDenied(policy, decision);
        return {
          code: 'RATE_LIMITED',
          message: 'Too many AI requests. Please try again later.',
          retryAfterSeconds: decision.retryAfterSeconds,
        };
      }
    }
    return null;
  }
}
