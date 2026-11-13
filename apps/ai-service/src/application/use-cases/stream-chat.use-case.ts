import {
  RAG_INPUT_REFUSAL_MESSAGE,
  RefuseRagInputUseCase,
} from '@ai/application/use-cases/refuse-rag-input.use-case';
import type { IChatAdmission } from '@ai/domain/interfaces/chat-admission.interface';
import type {
  IRagChatWorkflow,
  RagChatWorkflowInput,
  RagCitation,
} from '@ai/domain/interfaces/rag-chat-workflow.interface';
import type { AiRecommendedReel } from '@common/ai/dtos/ask-question-response.dto';
import type { AiChatMemoryContext } from '@common/ai/interfaces/chat-memory-context.interface';
import { Inject, Injectable, Logger } from '@nestjs/common';

export interface StreamChatResult {
  answer: string;
  citations?: RagCitation[];
  recommendedReels?: AiRecommendedReel[];
  suggestedQueries?: string[];
}

@Injectable()
export class StreamChatUseCase {
  private readonly logger = new Logger(StreamChatUseCase.name);

  constructor(
    @Inject('IRagChatWorkflow')
    private readonly ragChatWorkflow: IRagChatWorkflow,
    @Inject('IChatAdmission')
    private readonly chatAdmission: IChatAdmission,
    private readonly refuseRagInputUseCase: RefuseRagInputUseCase,
  ) {}

  async execute(input: {
    message: string;
    userId: string;
    conversationId: string;
    memory?: AiChatMemoryContext;
  }): Promise<StreamChatResult> {
    // Checked before admission: a refused message needs neither a model slot nor a place in the queue.
    const refusal = this.refuseRagInputUseCase.execute({
      message: input.message,
    });
    if (refusal.refuse) {
      this.logger.warn(
        `[Guardrail] mode=enforce blocked=true input=${refusal.codes.join(',') || '-'}`,
      );
      return {
        answer: RAG_INPUT_REFUSAL_MESSAGE,
        citations: [],
        recommendedReels: [],
        suggestedQueries: [],
      };
    }

    // The model server answers one request at a time, so a burst of turns would only queue
    // behind it until a model timeout. Admission turns the overflow away quickly instead.
    const result = await this.chatAdmission.run(() =>
      this.ragChatWorkflow.execute({
        message: input.message,
        userId: input.userId,
        conversationId: input.conversationId,
        memory: input.memory,
      } satisfies RagChatWorkflowInput),
    );

    return {
      answer: result.answer,
      citations: result.citations ?? [],
      recommendedReels: result.recommendedReels ?? [],
      suggestedQueries: result.suggestedQueries ?? [],
    };
  }
}
