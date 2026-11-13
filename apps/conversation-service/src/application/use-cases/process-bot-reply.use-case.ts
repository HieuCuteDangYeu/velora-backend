import { BOT_USER_ID } from '@common/constants/seed.constants';
import { Inject, Injectable, Logger } from '@nestjs/common';
import { Message } from '../../domain/entities/message.entity';
import type {
  BotError,
  IAiService,
} from '../../domain/interfaces/ai-service.interface';
import { IChatRepository } from '../../domain/interfaces/chat.repository.interface';
import { BuildBotMemoryContextUseCase } from './build-bot-memory-context.use-case';
import { BuildCompletedTurnMemoryContextUseCase } from './build-completed-turn-memory-context.use-case';

export interface ProcessBotReplyResult {
  botReply?: Message;
  botError?: BotError;
}

@Injectable()
export class ProcessBotReplyUseCase {
  private readonly logger = new Logger(ProcessBotReplyUseCase.name);

  constructor(
    @Inject('IChatRepository')
    private readonly chatRepository: IChatRepository,

    @Inject('IAiService')
    private readonly aiService: IAiService,

    private readonly buildBotMemoryContextUseCase: BuildBotMemoryContextUseCase,
    private readonly buildCompletedTurnMemoryContextUseCase: BuildCompletedTurnMemoryContextUseCase,
  ) {}

  async execute(userMessage: Message): Promise<ProcessBotReplyResult> {
    let botReply: Message | undefined;
    let botError: BotError | undefined;

    try {
      const answerMemory = await this.buildBotMemoryContextUseCase.execute({
        conversationId: userMessage.conversationId,
        currentMessageId: userMessage.id,
        requesterUserId: userMessage.senderId,
      });

      const replyToReelId = await this.resolveReplyToReelId(userMessage);

      const result = await this.aiService.askQuestionStream({
        message: userMessage.content,
        userId: userMessage.senderId,
        conversationId: userMessage.conversationId,
        memory: answerMemory,
        ...(replyToReelId ? { replyToReelId } : {}),
      });

      if (result.answer) {
        const hasCitations = result.citations && result.citations.length > 0;
        const hasRecommendedReels =
          result.recommendedReels && result.recommendedReels.length > 0;
        const hasSuggestedQueries =
          result.suggestedQueries && result.suggestedQueries.length > 0;
        const hasAiMetadata =
          hasCitations || hasRecommendedReels || hasSuggestedQueries;

        const botMessage = new Message({
          id: '',
          conversationId: userMessage.conversationId,
          senderId: BOT_USER_ID,
          content: result.answer,
          type: 'text',
          createdAt: new Date(),
          metadata: hasAiMetadata
            ? {
                kind:
                  hasRecommendedReels || hasSuggestedQueries
                    ? 'velora_ai_reel_recommendations'
                    : 'velora_ai_response',
                citations: result.citations ?? [],
                recommendedReels: result.recommendedReels ?? [],
                suggestedQueries: result.suggestedQueries ?? [],
              }
            : undefined,
        });

        botReply = await this.chatRepository.createMessage(botMessage);

        const completedTurnMemory =
          this.buildCompletedTurnMemoryContextUseCase.execute({
            previousMemory: answerMemory,
            userMessage,
            assistantMessage: botReply,
          });

        this.aiService.emitConversationTurnCompleted({
          conversationId: userMessage.conversationId,
          userId: userMessage.senderId,
          userMessage: userMessage.content,
          assistantMessage: result.answer,
          memory: completedTurnMemory,
        });

        this.logger.debug(
          `Bot reply ${botReply.id} saved for conversation ${userMessage.conversationId}`,
        );
      }

      if (result.error) {
        botError = result.error;
      }
    } catch (error: unknown) {
      if (error instanceof Error) {
        this.logger.error(
          `Failed to process bot reply: ${error.message}`,
          error.stack,
        );
      }

      botError = {
        code: 'AI_UNAVAILABLE',
        message: 'AI service is temporarily unavailable',
      };
    }

    return { botReply, botError };
  }

  /**
   * When the user swipe-replied to a shared Reel, the AI needs to know which one: "What is this
   * reel about?" is ambiguous once several Reels are shared in the chat. This is a best-effort
   * hint, so a failed lookup must never block the reply.
   */
  private async resolveReplyToReelId(
    userMessage: Message,
  ): Promise<string | undefined> {
    if (!userMessage.replyToId) {
      return undefined;
    }

    try {
      const target = await this.chatRepository.findMessageById(
        userMessage.conversationId,
        userMessage.replyToId,
      );

      if (!target || target.isRecalled) {
        return undefined;
      }

      return target.media?.reelId?.trim() || undefined;
    } catch (error: unknown) {
      this.logger.warn(
        `Could not resolve the replied-to Reel for message ${userMessage.id}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      return undefined;
    }
  }
}
