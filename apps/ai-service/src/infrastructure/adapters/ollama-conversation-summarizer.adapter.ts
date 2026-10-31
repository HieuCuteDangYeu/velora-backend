import { Inject, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { IAiApplicationConfig } from '@ai/domain/interfaces/ai-application-config.interface';
import type {
  IConversationSummarizerService,
  SummarizeConversationTurnInput,
  SummarizeConversationTurnResult,
} from '@ai/domain/interfaces/conversation-summarizer.service.interface';
import {
  getStructuredConversationSummaryShape,
  hasUsefulStructuredConversationSummary,
  parseConversationSummaryResult,
} from './llm/conversation-summary.parser';
import { buildConversationSummaryPrompt } from './llm/conversation-summary.prompt';
import { renderConversationSummary } from './llm/conversation-summary.renderer';
import { OllamaTextClient } from './ollama-text.client';

@Injectable()
export class OllamaConversationSummarizerAdapter implements IConversationSummarizerService {
  private readonly logger = new Logger(
    OllamaConversationSummarizerAdapter.name,
  );

  constructor(
    private readonly config: ConfigService,
    private readonly textClient: OllamaTextClient,
    @Inject('IAiApplicationConfig')
    private readonly applicationConfig: IAiApplicationConfig,
  ) {}

  async summarizeTurn(
    input: SummarizeConversationTurnInput,
  ): Promise<SummarizeConversationTurnResult> {
    try {
      const prompt = buildConversationSummaryPrompt(input);
      const response = await this.textClient.generateChatText({
        model: this.config.getOrThrow<string>('AI_CONVERSATION_SUMMARY_MODEL'),
        messages: [
          { role: 'system', content: prompt.systemPrompt },
          { role: 'user', content: prompt.userPrompt },
        ],
        maxTokens: this.applicationConfig.maxCompletionTokens(
          'CONVERSATION_SUMMARY',
        ),
        temperature: this.number('OLLAMA_MEMORY_TEMPERATURE', 0.1),
      });
      const structured = parseConversationSummaryResult(response, input);
      const shape = getStructuredConversationSummaryShape(structured);
      if (shape)
        this.logger.debug(
          `[ConversationSummary] groundedShape=${JSON.stringify(shape)}`,
        );
      if (!structured || !hasUsefulStructuredConversationSummary(structured))
        return this.keepExisting(input);
      const rendered = renderConversationSummary(structured);
      return rendered
        ? { summary: rendered.slice(0, 1200), shouldUpdate: true }
        : this.keepExisting(input);
    } catch (error: unknown) {
      this.logger.warn(
        `Ollama conversation summarization failed: ${error instanceof Error ? error.message : String(error)}`,
      );
      return this.keepExisting(input);
    }
  }

  private keepExisting(
    input: SummarizeConversationTurnInput,
  ): SummarizeConversationTurnResult {
    return {
      summary: input.existingSummary?.trim() || '',
      shouldUpdate: false,
    };
  }

  private number(key: string, fallback: number): number {
    const value = Number(this.config.get<string>(key) ?? fallback);
    return Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : fallback;
  }
}
