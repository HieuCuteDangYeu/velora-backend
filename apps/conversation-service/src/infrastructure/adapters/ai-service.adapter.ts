import { AskQuestionResponse } from '@common/ai/dtos/ask-question-response.dto';
import { ConversationTurnCompletedPayload } from '@common/ai/interfaces/user-memory.interface';
import { isRpcError } from '@common/constants/rpc-error.types';
import { Inject, Injectable, Logger } from '@nestjs/common';
import { ClientProxy } from '@nestjs/microservices';
import { catchError, lastValueFrom } from 'rxjs';
import {
  AskQuestionResult,
  AskQuestionStreamInput,
  IAiService,
} from '../../domain/interfaces/ai-service.interface';

@Injectable()
export class AiServiceAdapter implements IAiService {
  private readonly logger = new Logger(AiServiceAdapter.name);

  constructor(
    @Inject('AI_SERVICE_RMQ')
    private readonly aiClient: ClientProxy,
  ) {}

  async askQuestionStream(
    input: AskQuestionStreamInput,
  ): Promise<AskQuestionResult> {
    try {
      const response = await lastValueFrom(
        this.aiClient
          .send<AskQuestionResponse>('ai.stream_question', input)
          .pipe(
            catchError((error) => {
              this.handleMicroserviceError(error);
            }),
          ),
      );

      if (response.error) {
        return { answer: null, error: response.error };
      }

      return {
        answer: response.answer ?? null,
        citations: response.citations ?? [],
        recommendedReels: response.recommendedReels ?? [],
        suggestedQueries: response.suggestedQueries ?? [],
        ...(response.imageDescription
          ? { imageDescription: response.imageDescription }
          : {}),
      };
    } catch (error: unknown) {
      if (isRpcError(error)) {
        return {
          answer: null,
          error: {
            code: 'AI_UNAVAILABLE' as const,
            message: Array.isArray(error.message)
              ? error.message.join(', ')
              : error.message,
          },
        };
      }

      const msg = error instanceof Error ? error.message : String(error);
      this.logger.error(`Failed to reach AI service for streaming: ${msg}`);

      return {
        answer: null,
        error: {
          code: 'AI_UNAVAILABLE',
          message: 'AI service is temporarily unavailable',
        },
      };
    }
  }

  emitConversationTurnCompleted(input: ConversationTurnCompletedPayload): void {
    try {
      this.aiClient.emit('ai.conversation_turn_completed', input);
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);

      this.logger.warn(
        `Failed to emit ai.conversation_turn_completed for conversation ${input.conversationId}: ${message}`,
      );
    }
  }

  private handleMicroserviceError(error: unknown): never {
    if (isRpcError(error)) {
      const message = Array.isArray(error.message)
        ? error.message.join(', ')
        : error.message;
      throw new Error(`AI service error [${error.statusCode}]: ${message}`);
    }

    const msg = error instanceof Error ? error.message : String(error);
    throw new Error(`AI service unreachable: ${msg}`);
  }
}
