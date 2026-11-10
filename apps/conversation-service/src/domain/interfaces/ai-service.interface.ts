import type {
  AiRagCitation,
  AiRecommendedReel,
} from '@common/ai/dtos/ask-question-response.dto';
import type { AiChatMemoryContext } from '@common/ai/interfaces/chat-memory-context.interface';
import { ConversationTurnCompletedPayload } from '@common/ai/interfaces/user-memory.interface';

export interface BotError {
  code:
    | 'AI_UNAVAILABLE'
    | 'AI_BUSY'
    | 'NO_CONTENT'
    | 'RATE_LIMITED'
    | 'UNKNOWN';
  message: string;
  /** RATE_LIMITED: seconds until the user may ask again. AI_BUSY: seconds until a retry is likely to fit. */
  retryAfterSeconds?: number;
}

export interface AskQuestionResult {
  answer: string | null;
  citations?: AiRagCitation[];
  recommendedReels?: AiRecommendedReel[];
  suggestedQueries?: string[];
  error?: BotError;
}

export interface AskQuestionStreamInput {
  message: string;
  userId: string;
  conversationId: string;
  memory?: AiChatMemoryContext;
}

export interface IAiService {
  askQuestionStream(input: AskQuestionStreamInput): Promise<AskQuestionResult>;
  emitConversationTurnCompleted(input: ConversationTurnCompletedPayload): void;
}
