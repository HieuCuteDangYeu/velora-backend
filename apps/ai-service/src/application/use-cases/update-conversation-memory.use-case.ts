import type { IAiApplicationConfig } from '@ai/domain/interfaces/ai-application-config.interface';
import type { ConversationTurnCompletedPayload } from '@common/ai/interfaces/user-memory.interface';
import { ScreenRagMemoryUseCase } from '@ai/application/use-cases/screen-rag-memory.use-case';
import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import type { IConversationMemoryRepository } from '../../domain/interfaces/conversation-memory.repository.interface';
import type { IConversationSummarizerService } from '../../domain/interfaces/conversation-summarizer.service.interface';

export interface UpdateConversationMemoryResult {
  messageCount: number;
  summaryUpdated: boolean;
}

@Injectable()
export class UpdateConversationMemoryUseCase {
  private readonly logger = new Logger(UpdateConversationMemoryUseCase.name);

  constructor(
    @Inject('IAiApplicationConfig')
    private readonly configService: IAiApplicationConfig,

    @Inject('IConversationMemoryRepository')
    private readonly conversationMemoryRepository: IConversationMemoryRepository,

    @Inject('IConversationSummarizerService')
    private readonly conversationSummarizerService: IConversationSummarizerService,

    @Optional()
    private readonly screenRagMemoryUseCase?: ScreenRagMemoryUseCase,
  ) {}

  async execute(
    payload: ConversationTurnCompletedPayload,
  ): Promise<UpdateConversationMemoryResult> {
    if (
      !payload.userId ||
      !payload.conversationId ||
      !payload.userMessage?.trim() ||
      !payload.assistantMessage?.trim()
    ) {
      return {
        messageCount: 0,
        summaryUpdated: false,
      };
    }

    const existing =
      await this.conversationMemoryRepository.findByConversationId(
        payload.conversationId,
      );

    const nextMessageCount = (existing?.messageCount ?? 0) + 2;

    const everyNTurns = this.getPositiveNumber(
      'AI_CONVERSATION_MEMORY_EVERY_N_TURNS',
      4,
    );

    const shouldSummarize =
      Math.floor(nextMessageCount / 2) % everyNTurns === 0;

    let nextSummary = existing?.summary ?? '';
    let summaryUpdated = false;

    if (shouldSummarize) {
      const summarized = await this.conversationSummarizerService.summarizeTurn(
        {
          existingSummary: existing?.summary,
          recentMessages: payload.memory?.recentMessages,
          userMessage: payload.userMessage,
          assistantMessage: payload.assistantMessage,
        },
      );

      if (!summarized.shouldUpdate) {
        this.logger.warn(
          `[ConversationMemory] summarizer skipped update conversationId=${payload.conversationId}`,
        );
      } else {
        const summary = this.sanitizeSummary(summarized.summary);

        if (!summary) {
          this.logger.warn(
            `[ConversationMemory] skipped empty summary conversationId=${payload.conversationId}`,
          );
        } else if (
          this.screenRagMemoryUseCase?.blocks(
            [payload.userMessage, summary],
            'summary',
          )
        ) {
          // Keep the previous summary: the new one would carry the attack into later prompts.
          this.logger.warn(
            `[ConversationMemory] skipped guardrail-blocked summary conversationId=${payload.conversationId}`,
          );
        } else {
          nextSummary = summary;
          summaryUpdated = true;
        }
      }
    }

    const saved = await this.conversationMemoryRepository.upsert({
      conversationId: payload.conversationId,
      userId: payload.userId,
      summary: nextSummary,
      messageCount: nextMessageCount,
      lastMessageAt: new Date(),
    });

    this.logger.log(
      `[ConversationMemory] conversationId=${saved.conversationId} messageCount=${saved.messageCount} summaryUpdated=${summaryUpdated} recentMessages=${payload.memory?.recentMessages?.length ?? 0}`,
    );

    return {
      messageCount: saved.messageCount,
      summaryUpdated,
    };
  }

  private sanitizeSummary(value: string): string {
    return value
      .trim()
      .replace(/^#+\s*summary\s*:?\s*/i, '')
      .replace(/^\*\*summary\*\*\s*:?\s*/i, '')
      .replace(/^summary\s*:?\s*/i, '')
      .trim();
  }

  private getPositiveNumber(key: string, fallback: number): number {
    const value = Number(this.configService.get<string>(key) ?? fallback);

    return Number.isFinite(value) && value > 0 ? value : fallback;
  }
}
