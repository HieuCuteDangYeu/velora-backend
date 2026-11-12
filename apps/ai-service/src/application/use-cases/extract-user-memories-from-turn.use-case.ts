import type { AiChatMemoryContext } from '@common/ai/interfaces/chat-memory-context.interface';
import type {
  ExtractUserMemoriesRequest,
  ExtractUserMemoriesResult,
} from '@common/ai/interfaces/extract-user-memory.interface';
import { Inject, Injectable } from '@nestjs/common';
import type { IMemoryExtractorService } from '../../domain/interfaces/memory-extractor.service.interface';

export interface ExtractUserMemoriesFromTurnInput extends ExtractUserMemoriesRequest {
  memory?: AiChatMemoryContext;
}

export interface ExtractUserMemoriesFromTurnResult extends ExtractUserMemoriesResult {
  sourceText: string;
}

@Injectable()
export class ExtractUserMemoriesFromTurnUseCase {
  private readonly userMemorySourceLimit = 8;

  constructor(
    @Inject('IMemoryExtractorService')
    private readonly memoryExtractorService: IMemoryExtractorService,
  ) {}

  async execute(
    input: ExtractUserMemoriesFromTurnInput,
  ): Promise<ExtractUserMemoriesFromTurnResult> {
    const sourceText = this.buildUserMemorySource(input);

    const extracted = await this.memoryExtractorService.extract({
      userId: input.userId,
      conversationId: input.conversationId,
      userMessage: sourceText,
      assistantMessage: input.assistantMessage,
    });

    return {
      ...extracted,
      sourceText,
    };
  }

  private buildUserMemorySource(
    input: ExtractUserMemoriesFromTurnInput,
  ): string {
    const recentUserMessages =
      input.memory?.recentMessages
        ?.filter(
          (message) =>
            message.role === 'user' && message.authorIsRequester !== false,
        )
        .map((message) => message.content?.trim() ?? '')
        .filter((content) => content.length > 0) ?? [];

    return [...recentUserMessages, input.userMessage.trim()]
      .filter((message) => message.length > 0)
      .filter((message, index, messages) => messages.indexOf(message) === index)
      .slice(-this.userMemorySourceLimit)
      .join('\n');
  }
}
