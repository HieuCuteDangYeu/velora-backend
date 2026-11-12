import type {
  AiChatMemoryContext,
  AiChatMemoryRole,
} from '@common/ai/interfaces/chat-memory-context.interface';
import { Injectable } from '@nestjs/common';
import { Message } from '../../domain/entities/message.entity';

@Injectable()
export class BuildCompletedTurnMemoryContextUseCase {
  private readonly finalLimit = 12;

  execute(input: {
    previousMemory?: AiChatMemoryContext;
    userMessage: Message;
    assistantMessage: Message;
  }): AiChatMemoryContext {
    const userRole: AiChatMemoryRole = 'user';
    const assistantRole: AiChatMemoryRole = 'assistant';

    const recentMessages = [
      ...(input.previousMemory?.recentMessages ?? []),
      {
        role: userRole,
        content: input.userMessage.content?.trim() ?? '',
        createdAt: input.userMessage.createdAt.toISOString(),
        eventType: 'TEXT' as const,
        authorIsRequester: true,
      },
      {
        role: assistantRole,
        content: input.assistantMessage.content?.trim() ?? '',
        createdAt: input.assistantMessage.createdAt.toISOString(),
        eventType: 'TEXT' as const,
      },
    ]
      .filter((message) => message.content.length > 0)
      .slice(-this.finalLimit);

    return {
      recentMessages,
    };
  }
}
