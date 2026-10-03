import { GetConversationMemoryUseCase } from '@ai/application/use-cases/get-conversation-memory.use-case';
import { GetRelevantUserMemoriesUseCase } from '@ai/application/use-cases/get-relevant-user-memories.use-case';
import type {
  RagChatRouteDecision,
  RagMemorySelection,
} from '@ai/domain/interfaces/rag-chat-workflow.interface';
import type { AiChatMemoryContext } from '@common/ai/interfaces/chat-memory-context.interface';
import type { ConversationMemoryContext } from '@common/ai/interfaces/conversation-memory.interface';
import type { RelevantUserMemoriesContext } from '@common/ai/interfaces/user-memory.interface';
import { Injectable } from '@nestjs/common';

@Injectable()
export class MemoryAgentUseCase {
  constructor(
    private readonly getRelevantUserMemoriesUseCase: GetRelevantUserMemoriesUseCase,
    private readonly getConversationMemoryUseCase: GetConversationMemoryUseCase,
  ) {}

  async execute(input: {
    userId: string;
    conversationId: string;
    message: string;
    route: RagChatRouteDecision;
    memory?: AiChatMemoryContext;
  }): Promise<{
    selection: RagMemorySelection;
    conversationMemory?: ConversationMemoryContext;
    userMemories?: RelevantUserMemoriesContext;
  }> {
    const selection = this.selectMemoryFast(input.route);

    const [conversationMemory, userMemories] = await Promise.all([
      selection.includeConversationSummary
        ? this.getConversationMemoryUseCase.execute({
            conversationId: input.conversationId,
          })
        : Promise.resolve(undefined),

      selection.includeUserMemory
        ? this.getRelevantUserMemoriesUseCase.execute({
            userId: input.userId,
            queryText: input.message,
            limit: 8,
          })
        : Promise.resolve(undefined),
    ]);

    return {
      selection,
      conversationMemory,
      userMemories,
    };
  }

  private selectMemoryFast(route: RagChatRouteDecision): RagMemorySelection {
    switch (route.intent) {
      case 'NORMAL_CHAT':
        return {
          includeRecentHistory: true,
          includeConversationSummary: true,
          includeUserMemory: true,
          includeRetrievedChunks: false,
          reason: 'Fast memory selection for normal chat.',
        };

      case 'REEL_VIDEO_QUESTION':
        return {
          includeRecentHistory: true,
          includeConversationSummary: route.needsConversationSummary,
          includeUserMemory: route.needsUserMemory,
          includeRetrievedChunks: true,
          reason:
            'Reel/video question uses retrieved chunks plus memory context.',
        };

      case 'CONVERSATION_MEMORY_QUESTION':
        return {
          includeRecentHistory: true,
          includeConversationSummary: true,
          includeUserMemory: false,
          includeRetrievedChunks: false,
          reason:
            'Conversation memory question uses recent history and conversation summary.',
        };

      case 'USER_MEMORY_QUESTION':
        return {
          includeRecentHistory: true,
          includeConversationSummary: false,
          includeUserMemory: true,
          includeRetrievedChunks: false,
          reason: 'User memory question uses long-term user memory.',
        };

      case 'TASK_ACTION_REQUEST':
        return {
          includeRecentHistory: true,
          includeConversationSummary: true,
          includeUserMemory: true,
          includeRetrievedChunks: false,
          reason:
            'Task/action request uses recent history, conversation summary, and user memory.',
        };

      default:
        return {
          includeRecentHistory: true,
          includeConversationSummary: true,
          includeUserMemory: true,
          includeRetrievedChunks: false,
          reason: 'Fallback memory selection.',
        };
    }
  }
}
