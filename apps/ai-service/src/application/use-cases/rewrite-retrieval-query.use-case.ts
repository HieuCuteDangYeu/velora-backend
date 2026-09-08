import type { RagChatWorkflowState } from '@ai/domain/interfaces/rag-chat-workflow.interface';
import type { IStructuredLlmService } from '@ai/domain/interfaces/structured-llm.service.interface';
import { Inject, Injectable, Logger } from '@nestjs/common';
import {
  boundPromptText,
  boundTextItems,
  readRagPromptBounds,
} from '@ai/domain/services/rag-prompt-bounds';

interface RawRewriteResult {
  query?: unknown;
}

@Injectable()
export class RewriteRetrievalQueryUseCase {
  private readonly logger = new Logger(RewriteRetrievalQueryUseCase.name);

  constructor(
    @Inject('IStructuredLlmService')
    private readonly structuredLlmService: IStructuredLlmService,
    @Inject('IAiApplicationConfig')
    private readonly config: IAiApplicationConfig,
  ) {}

  async execute(state: RagChatWorkflowState): Promise<string> {
    const bounds = readRagPromptBounds(this.config);
    const previousQueries = boundTextItems(
      (
        state.retrievalPlan?.queries ?? [
          state.retrievalPlan?.rewrittenQuery,
          state.retrievalPlan?.query,
        ]
      ).filter((value): value is string => Boolean(value)),
      (value) => value,
      (_value, text) => text,
      3,
      bounds.maxUserMessageChars,
      bounds.maxClaimsTotalChars,
    );
    try {
      const result =
        await this.structuredLlmService.generateObject<RawRewriteResult>({
          systemPrompt: [
            'You rewrite a failed reel-RAG retrieval query.',
            'Return one concise search query only through the requested JSON schema.',
            'Preserve all entities, names, numbers, quoted text, and modality constraints from the user question.',
            'Use the failure reason to make the query more explicit, but never invent new facts.',
            'Do not answer the user.',
          ].join(' '),
          userPrompt: [
            `USER QUESTION:\n${boundPromptText(state.userMessage, bounds.maxUserMessageChars)}`,
            `REQUIRED EVIDENCE:\n${state.route?.requiredEvidence.join(', ') || 'UNKNOWN'}`,
            `PREVIOUS QUERIES:\n${previousQueries.join(' | ')}`,
            `SUFFICIENCY FAILURE:\n${boundPromptText(state.contextSufficiency?.reason ?? 'Retrieved evidence was insufficient.', bounds.maxClaimChars)}`,
            `MISSING EVIDENCE:\n${state.contextSufficiency?.missingEvidence.join(', ') || 'NONE'}`,
          ].join('\n\n'),
          jsonSchema: {
            type: 'object',
            properties: {
              query: { type: 'string', maxLength: 500 },
            },
            required: ['query'],
            additionalProperties: false,
          },
          maxTokens: this.config.maxCompletionTokens('RETRIEVAL_PLANNER'),
          modelRole: 'RETRIEVAL_PLANNER',
          temperature: 0,
          model: this.config.model('RETRIEVAL_PLANNER'),
          timeoutMs: this.config.timeoutMs('RETRIEVAL_PLANNER'),
        });

      if (typeof result.query === 'string' && result.query.trim()) {
        return result.query.replace(/\s+/g, ' ').trim().slice(0, 500);
      }
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.warn(`[RetrievalRepair] query rewrite failed: ${message}`);
    }

    return boundPromptText(
      state.userMessage,
      bounds.maxUserMessageChars,
    ).trim();
  }
}
import type { IAiApplicationConfig } from '@ai/domain/interfaces/ai-application-config.interface';
