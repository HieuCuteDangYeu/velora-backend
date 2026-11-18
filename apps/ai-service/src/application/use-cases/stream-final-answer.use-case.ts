import type { IChatPromptBuilder } from '@ai/domain/interfaces/chat-prompt-builder.interface';
import type { IChatTokenPublisher } from '@ai/domain/interfaces/chat-token-publisher.interface';
import type { ILlmService } from '@ai/domain/interfaces/llm.service.interface';
import type { RagChatWorkflowState } from '@ai/domain/interfaces/rag-chat-workflow.interface';
import {
  RAG_OUTPUT_REFUSAL_MESSAGE,
  ScreenRagResultUseCase,
} from '@ai/application/use-cases/screen-rag-result.use-case';
import { Inject, Injectable, Logger, Optional } from '@nestjs/common';

/**
 * While the output check enforces, live text is released only once this many
 * characters sit behind it, so a secret, an ID or an image link is screened
 * (it is complete within this window) before any part of it is published.
 */
const OUTPUT_HOLD_BACK_CHARS = 160;

@Injectable()
export class StreamFinalAnswerUseCase {
  private readonly logger = new Logger(StreamFinalAnswerUseCase.name);

  constructor(
    @Inject('ILlmService')
    private readonly llmService: ILlmService,

    @Inject('IChatTokenPublisher')
    private readonly chatTokenPublisher: IChatTokenPublisher,

    @Inject('IChatPromptBuilder')
    private readonly chatPromptBuilder: IChatPromptBuilder,

    @Optional()
    private readonly screenRagResultUseCase?: ScreenRagResultUseCase,
  ) {}

  async execute(state: RagChatWorkflowState): Promise<string> {
    const existingVerifiedAnswer = state.answer?.trim();

    if (existingVerifiedAnswer) {
      // The whole answer is known here, so it is screened before the first chunk goes out.
      const blocked = this.blockingCodes(state, existingVerifiedAnswer);
      if (blocked.length > 0) {
        this.logBlocked(blocked);
        this.publishExistingAnswer(state, RAG_OUTPUT_REFUSAL_MESSAGE);
        return RAG_OUTPUT_REFUSAL_MESSAGE;
      }

      this.logger.debug(
        `[FinalAnswer] publishing existing verified answer length=${existingVerifiedAnswer.length}`,
      );

      this.publishExistingAnswer(state, existingVerifiedAnswer);
      return existingVerifiedAnswer;
    }

    const systemPrompt = this.chatPromptBuilder.build(state);
    const publish = (token: string) => {
      this.logger.debug(
        `[FinalAnswer] publishing token length=${token.length}`,
      );
      this.chatTokenPublisher.publishToken({
        conversationId: state.conversationId,
        userId: state.userId,
        token,
      });
    };

    if (!this.screenRagResultUseCase?.enforcesOutput()) {
      const answer = await this.llmService.generateResponseStream(
        state.userMessage,
        systemPrompt,
        state.userId,
        publish,
        state.conversationId,
      );
      this.logger.debug(
        `[FinalAnswer] generated answer length=${answer.length}`,
      );
      return answer;
    }

    // Output enforcement: hold the tail of the text back, screen as it grows, and stop publishing on a hit.
    let seen = '';
    let published = 0;
    let blocked: string[] = [];
    const answer = await this.llmService.generateResponseStream(
      state.userMessage,
      systemPrompt,
      state.userId,
      (token: string) => {
        if (blocked.length > 0) return;
        seen += token;
        blocked = this.blockingCodes(state, seen);
        if (blocked.length > 0) return;
        const releasable = seen.length - OUTPUT_HOLD_BACK_CHARS;
        if (releasable > published) {
          publish(seen.slice(published, releasable));
          published = releasable;
        }
      },
      state.conversationId,
    );

    if (blocked.length === 0) blocked = this.blockingCodes(state, answer);
    if (blocked.length > 0) {
      this.logBlocked(blocked);
      return RAG_OUTPUT_REFUSAL_MESSAGE;
    }

    if (seen.length > published) publish(seen.slice(published));
    this.logger.debug(`[FinalAnswer] generated answer length=${answer.length}`);
    return answer;
  }

  private blockingCodes(state: RagChatWorkflowState, answer: string): string[] {
    try {
      return (
        this.screenRagResultUseCase?.blockingAnswerCodes({
          answer,
          userMessage: state.userMessage,
          accessibleReelIds: state.accessibleReelIds ?? [],
        }) ?? []
      );
    } catch (error: unknown) {
      // The guardrail must never take chat down.
      this.logger.warn(
        `Guardrail answer screening failed: ${error instanceof Error ? error.message : String(error)}`,
      );
      return [];
    }
  }

  private logBlocked(codes: string[]): void {
    this.logger.warn(
      `[Guardrail] mode=enforce blockedOutput=true stage=publish output=${codes.join(',')}`,
    );
  }

  private publishExistingAnswer(
    state: RagChatWorkflowState,
    answer: string,
  ): void {
    for (const token of this.chunkAnswer(answer)) {
      this.chatTokenPublisher.publishToken({
        conversationId: state.conversationId,
        userId: state.userId,
        token,
      });
    }
  }

  private chunkAnswer(answer: string): string[] {
    const maxLength = 80;
    const chunks: string[] = [];

    for (let index = 0; index < answer.length; index += maxLength) {
      chunks.push(answer.slice(index, index + maxLength));
    }

    return chunks;
  }
}
