import { MessageEmbeddingCache } from '@ai/application/services/message-embedding-cache';
import { GenerateEmbeddingBatchUseCase } from '@ai/application/use-cases/generate-embedding-batch.use-case';
import { GetRelevantUserMemoriesUseCase } from '@ai/application/use-cases/get-relevant-user-memories.use-case';
import { ScreenRagMemoryUseCase } from '@ai/application/use-cases/screen-rag-memory.use-case';
import type { IAiApplicationConfig } from '@ai/domain/interfaces/ai-application-config.interface';
import type {
  RagChatWorkflowState,
  RagMemorySelection,
} from '@ai/domain/interfaces/rag-chat-workflow.interface';
import {
  cosineSimilarity,
  recallTokens,
  rankRecalledMessages,
  selectEmbeddingCandidates,
} from '@ai/domain/services/rank-recalled-messages';
import { isCannedAssistantReply } from '@ai/domain/services/canned-replies';
import {
  boundPromptText,
  readRagPromptBounds,
} from '@ai/domain/services/rag-prompt-bounds';
import type { AiChatMessageContext } from '@common/ai/interfaces/chat-memory-context.interface';
import type { RelevantUserMemoriesContext } from '@common/ai/interfaces/user-memory.interface';
import { Inject, Injectable, Logger, Optional } from '@nestjs/common';

/** Most earlier messages scored per question; the newest of the older ones win. */
const MAX_RECALL_CANDIDATES = 60;
/** Most of those that get an embedding call (about a second each on the shared service). */
const MAX_EMBEDDED_CANDIDATES = 20;
const QUERY_ID = 'question';
/** conversation-service cuts each earlier message to this many characters. */
const OLDER_MESSAGE_CHARS = 300;

/**
 * For a question about the conversation ("do you remember the pasta I mentioned?"),
 * finds what the live window cannot show: the few earlier messages that match the
 * question, and the user's saved facts. Both are best effort. A failure here leaves
 * the answer to the recent history, as before, and never fails the turn.
 */
@Injectable()
export class RecallConversationContextUseCase {
  private readonly logger = new Logger(RecallConversationContextUseCase.name);
  private readonly cache: MessageEmbeddingCache;

  constructor(
    @Inject('IAiApplicationConfig')
    private readonly config: IAiApplicationConfig,
    private readonly generateEmbeddingBatchUseCase: GenerateEmbeddingBatchUseCase,
    private readonly getRelevantUserMemoriesUseCase: GetRelevantUserMemoriesUseCase,
    @Optional()
    private readonly screenRagMemoryUseCase?: ScreenRagMemoryUseCase,
    @Optional()
    messageEmbeddingCache?: MessageEmbeddingCache,
  ) {
    this.cache = messageEmbeddingCache ?? new MessageEmbeddingCache();
  }

  async execute(
    state: RagChatWorkflowState,
  ): Promise<Partial<RagChatWorkflowState>> {
    if (!this.isRecallTurn(state)) return {};

    const startedAt = Date.now();
    const question = boundPromptText(
      state.userMessage,
      readRagPromptBounds(this.config).maxUserMessageChars,
    );
    const [recall, userMemories] = await Promise.all([
      this.recallMessages(question, state.memory?.olderMessages ?? []),
      state.userMemories
        ? Promise.resolve(state.userMemories)
        : this.relevantUserMemories(state.userId, question),
    ]);

    this.logger.log(
      `[Recall] candidates=${recall.candidateCount} semantic=${recall.semantic} recalled=${recall.messages.length} userMemories=${userMemories?.memories?.length ?? 0} ms=${Date.now() - startedAt}`,
    );

    const selection: RagMemorySelection = {
      includeRecentHistory: true,
      includeConversationSummary: true,
      includeRetrievedChunks: false,
      ...state.memorySelection,
      includeUserMemory: userMemories !== undefined,
      reason:
        'Conversation recall: recent history, matching earlier messages and saved facts.',
    };
    return {
      recalledMessages: recall.messages,
      ...(userMemories ? { userMemories } : {}),
      memorySelection: selection,
    };
  }

  /**
   * Embeds a user message as its turn completes, in the background, so a later recall question
   * finds it in the cache. Best effort: a failure only means the message is embedded on demand.
   */
  warm(text: string): void {
    const content = text.trim();
    if (recallTokens(content).length < 2 || this.cache.get(content)) return;
    // Cut like conversation-service cuts the earlier messages it sends, so the texts match.
    const clipped =
      content.length <= OLDER_MESSAGE_CHARS
        ? content
        : `${content.slice(0, OLDER_MESSAGE_CHARS - 1).trimEnd()}…`;
    this.generateEmbeddingBatchUseCase
      .execute({
        items: [{ id: 'm0', text: clipped, taskType: 'RETRIEVAL_DOCUMENT' }],
      })
      .then((done) => {
        const vector = done.embeddings[0]?.values;
        if (vector) this.cache.set(clipped, vector);
      })
      .catch(() => undefined);
  }

  /** The router names recall questions, including ones the model called chat but whose wording is an explicit recall. */
  isRecallTurn(state: RagChatWorkflowState): boolean {
    return state.route?.intent === 'CONVERSATION_MEMORY_QUESTION';
  }

  private async recallMessages(
    question: string,
    older: readonly AiChatMessageContext[],
  ): Promise<{
    messages: AiChatMessageContext[];
    candidateCount: number;
    semantic: boolean;
  }> {
    const candidates = older
      .filter((message) => message.content.trim().length > 0)
      .filter((message) => !isCannedAssistantReply(message))
      .filter(
        (message) =>
          !this.screenRagMemoryUseCase?.blocks([message.content], 'memory'),
      )
      .slice(-MAX_RECALL_CANDIDATES);
    if (candidates.length === 0 || !question.trim()) {
      return {
        messages: [],
        candidateCount: candidates.length,
        semantic: false,
      };
    }

    const semantic = await this.semanticScores(question, candidates);
    return {
      messages: rankRecalledMessages({ question, candidates, semantic }),
      candidateCount: candidates.length,
      semantic: semantic !== undefined,
    };
  }

  /** Cosine similarity of every candidate to the question, or undefined when embeddings are unavailable. */
  private async semanticScores(
    question: string,
    candidates: readonly AiChatMessageContext[],
  ): Promise<Array<number | undefined> | undefined> {
    const timeoutMs = this.timeoutMs();
    const embedded = selectEmbeddingCandidates(
      candidates,
      MAX_EMBEDDED_CANDIDATES,
    );
    if (embedded.length === 0) return undefined;
    try {
      // Only what the cache does not hold is embedded; the question is always new.
      const missing = embedded.filter(
        (index) => !this.cache.get(candidates[index].content),
      );
      const batch = this.generateEmbeddingBatchUseCase.execute({
        items: [
          { id: QUERY_ID, text: question, taskType: 'RETRIEVAL_QUERY' },
          ...missing.map((index) => ({
            id: `m${index}`,
            text: candidates[index].content,
            taskType: 'RETRIEVAL_DOCUMENT' as const,
          })),
        ],
      });
      // A batch that outlives the timeout still fills the cache, so the next question is fast.
      void batch
        .then((done) => {
          for (const item of done.embeddings) {
            if (item.id === QUERY_ID) continue;
            const index = Number(item.id.slice(1));
            if (candidates[index]) {
              this.cache.set(candidates[index].content, item.values);
            }
          }
        })
        .catch(() => undefined);
      let timer: NodeJS.Timeout | undefined;
      const result = await Promise.race([
        batch,
        new Promise<undefined>((resolve) => {
          timer = setTimeout(() => resolve(undefined), timeoutMs);
        }),
      ]).finally(() => clearTimeout(timer));
      const query = result?.embeddings.find((item) => item.id === QUERY_ID);
      if (!result || !query) return undefined;
      return candidates.map((message) => {
        const vector = this.cache.get(message.content);
        return vector && vector.length === query.values.length
          ? cosineSimilarity(query.values, vector)
          : undefined;
      });
    } catch (error: unknown) {
      this.logger.warn(
        `[Recall] embedding failed, using word match only: ${error instanceof Error ? error.message : String(error)}`,
      );
      return undefined;
    }
  }

  private async relevantUserMemories(
    userId: string,
    question: string,
  ): Promise<RelevantUserMemoriesContext | undefined> {
    try {
      return await this.getRelevantUserMemoriesUseCase.execute({
        userId,
        queryText: question,
        limit: 4,
      });
    } catch (error: unknown) {
      this.logger.warn(
        `[Recall] user memory lookup failed: ${error instanceof Error ? error.message : String(error)}`,
      );
      return undefined;
    }
  }

  private timeoutMs(): number {
    const parsed = Number(
      this.config.get<string>('AI_RECALL_EMBEDDING_TIMEOUT_MS'),
    );
    return Number.isFinite(parsed) && parsed >= 500 && parsed <= 30_000
      ? parsed
      : 6_000;
  }
}
