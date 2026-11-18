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
import { DEFAULT_IMAGE_ONLY_QUESTION } from '@common/ai/chat-image';
import type { AskQuestionImage } from '@common/ai/dtos/ask-question.dto';
import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { DescribeChatImagesUseCase } from './describe-chat-images.use-case';

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
    @Optional()
    private readonly describeChatImagesUseCase?: DescribeChatImagesUseCase,
  ) {}

  async execute(input: {
    message: string;
    userId: string;
    conversationId: string;
    memory?: AiChatMemoryContext;
    replyToReelId?: string;
    images?: AskQuestionImage[];
  }): Promise<StreamChatResult> {
    const hasImages = (input.images?.length ?? 0) > 0;
    // A photo sent without words asks the one thing the bot is scoped to answer about photos.
    const message =
      input.message.trim() || (hasImages ? DEFAULT_IMAGE_ONLY_QUESTION : '');

    // Checked before admission: a refused message needs neither a model slot nor a place in the queue.
    const refusal = this.refuseRagInputUseCase.execute({ message });
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

    // Reading a photo is a cloud vision call, not a local-model turn, so it runs before the
    // slot is taken: the scarce model slot is never held while a provider answers.
    if (hasImages && !this.describeChatImagesUseCase) {
      throw new Error('Image understanding is not configured');
    }
    const images = hasImages
      ? await this.describeChatImagesUseCase!.execute({
          userId: input.userId,
          images: input.images!,
        })
      : undefined;

    // The model server answers one request at a time, so a burst of turns would only queue
    // behind it until a model timeout. Admission turns the overflow away quickly instead.
    const result = await this.chatAdmission.run(() =>
      this.ragChatWorkflow.execute({
        message,
        userId: input.userId,
        conversationId: input.conversationId,
        memory: input.memory,
        ...(input.replyToReelId ? { replyToReelId: input.replyToReelId } : {}),
        ...(images ? { images } : {}),
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
