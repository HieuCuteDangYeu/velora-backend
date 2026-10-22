import type {
  AiChatMemoryContext,
  AiChatMemoryRole,
} from '@common/ai/interfaces/chat-memory-context.interface';
import { BOT_USER_ID } from '@common/constants/seed.constants';
import { Inject, Injectable } from '@nestjs/common';
import type { Message } from '../../domain/entities/message.entity';
import { IChatRepository } from '../../domain/interfaces/chat.repository.interface';

@Injectable()
export class BuildBotMemoryContextUseCase {
  private readonly historyLimit = 20;
  private readonly finalLimit = 12;

  constructor(
    @Inject('IChatRepository')
    private readonly chatRepository: IChatRepository,
  ) {}

  async execute(input: {
    conversationId: string;
    currentMessageId: string;
  }): Promise<AiChatMemoryContext> {
    const messages = await this.chatRepository.findMessagesByConversationId(
      input.conversationId,
      this.historyLimit,
    );

    const recentMessages = messages
      .filter((message) => message.id !== input.currentMessageId)
      .filter((message) => this.isMemoryEligibleMessage(message))
      .filter((message) => !message.isRecalled)
      .map((message) => {
        const role: AiChatMemoryRole =
          message.senderId === BOT_USER_ID ? 'assistant' : 'user';

        return {
          role,
          content: this.toMemoryContent(message),
          createdAt: message.createdAt.toISOString(),
          eventType:
            message.type === 'reel'
              ? ('REEL_SHARE' as const)
              : ('TEXT' as const),
        };
      })
      .filter((message) => message.content.length > 0)
      .slice(-this.finalLimit);

    return {
      recentMessages,
    };
  }

  private isMemoryEligibleMessage(message: Message): boolean {
    return message.type === 'text' || message.type === 'reel';
  }

  private toMemoryContent(message: Message): string {
    if (message.type !== 'reel') {
      return message.content?.trim() ?? '';
    }

    const title =
      message.media?.reelTitle?.trim() || message.content?.trim() || 'Untitled';

    return `[Shared reel] ${title}`;
  }
}
