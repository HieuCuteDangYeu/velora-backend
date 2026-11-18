import { AnalyzeVisualFrameUseCase } from '@ai/application/use-cases/analyze-visual-frame.use-case';
import { BackfillUserMemoryEmbeddingsUseCase } from '@ai/application/use-cases/backfill-user-memory-embeddings.use-case';
import { CountDocumentTokensUseCase } from '@ai/application/use-cases/count-document-tokens.use-case';
import { ExtractReelMetadataUseCase } from '@ai/application/use-cases/extract-reel-metadata.use-case';
import { ScoreTextRelevanceUseCase } from '@ai/application/use-cases/score-text-relevance.use-case';
import { HandleConversationTurnCompletedUseCase } from '@ai/application/use-cases/handle-conversation-turn-completed.use-case';
import { StreamChatUseCase } from '@ai/application/use-cases/stream-chat.use-case';
import {
  InvalidSubtitleTranslationRequestError,
  TranslateSubtitleCuesUseCase,
} from '@ai/application/use-cases/translate-subtitle-cues.use-case';
import { TranscribeAudioBufferUseCase } from '@ai/application/use-cases/transcribe-audio-buffer.use-case';
import { TranscribeAudioUseCase } from '@ai/application/use-cases/transcribe-audio.use-case';
import { ChatBusyError } from '@ai/domain/errors/chat-busy.error';
import { ChatImageUnreadableError } from '@ai/domain/errors/chat-image-unreadable.error';
import { AskQuestionResponse } from '@common/ai/dtos/ask-question-response.dto';
import { AskQuestionPayload } from '@common/ai/dtos/ask-question.dto';
import type { CountDocumentTokensRequest } from '@common/ai/interfaces/count-document-tokens.interface';
import type {
  GenerateEmbeddingBatchRequest,
  GenerateEmbeddingRequest,
} from '@common/ai/interfaces/generate-embedding.interface';
import {
  RERANK_TEXTS_MAX_ITEMS,
  RERANK_TEXTS_MAX_TEXT_LENGTH,
  type RerankTextsRequest,
} from '@common/ai/interfaces/rerank-texts.interface';
import type { ReelMetadataExtractionInput } from '@common/ai/interfaces/reel-metadata-extraction.interface';
import type { TranslateSubtitleCuesRequest } from '@common/ai/interfaces/subtitle-translation.interface';
import type { ConversationTurnCompletedPayload } from '@common/ai/interfaces/user-memory.interface';
import type { AnalyzeVisualFrameRequest } from '@common/ai/interfaces/visual-analysis.interface';
import {
  isChatImageMimeType,
  MAX_CHAT_IMAGES_PER_AI_TURN,
} from '@common/ai/chat-image';
import { Controller, Optional } from '@nestjs/common';
import {
  EventPattern,
  MessagePattern,
  Payload,
  RpcException,
} from '@nestjs/microservices';
import { RecallConversationContextUseCase } from '../../application/use-cases/recall-conversation-context.use-case';
import { GenerateEmbeddingUseCase } from '../../application/use-cases/generate-embedding.use-case';
import { GenerateEmbeddingBatchUseCase } from '../../application/use-cases/generate-embedding-batch.use-case';

@Controller()
export class AiController {
  constructor(
    private readonly generateEmbeddingUseCase: GenerateEmbeddingUseCase,
    private readonly generateEmbeddingBatchUseCase: GenerateEmbeddingBatchUseCase,
    private readonly countDocumentTokensUseCase: CountDocumentTokensUseCase,
    private readonly transcribeAudioUseCase: TranscribeAudioUseCase,
    private readonly transcribeAudioBufferUseCase: TranscribeAudioBufferUseCase,
    private readonly analyzeVisualFrameUseCase: AnalyzeVisualFrameUseCase,
    private readonly streamChatUseCase: StreamChatUseCase,
    private readonly handleConversationTurnCompletedUseCase: HandleConversationTurnCompletedUseCase,
    private readonly extractReelMetadataUseCase: ExtractReelMetadataUseCase,
    private readonly backfillUserMemoryEmbeddingsUseCase: BackfillUserMemoryEmbeddingsUseCase,
    private readonly scoreTextRelevanceUseCase: ScoreTextRelevanceUseCase,
    private readonly translateSubtitleCuesUseCase: TranslateSubtitleCuesUseCase,
    @Optional()
    private readonly recallConversationContextUseCase?: RecallConversationContextUseCase,
  ) {}

  @MessagePattern('ai.generate_embedding')
  async handleGenerateEmbedding(@Payload() data: GenerateEmbeddingRequest) {
    if (!data || typeof data.text !== 'string' || data.text.trim() === '') {
      throw new RpcException({
        statusCode: 400,
        message: 'Invalid embedding request payload',
      });
    }

    try {
      const embedding = await this.generateEmbeddingUseCase.execute(data);

      return { embedding };
    } catch (err: unknown) {
      if (err instanceof RpcException) {
        throw err;
      }

      const error = err as Error;
      console.error(`[GenerateEmbedding] ${error.message}`);

      const statusCode = error.message.includes('not initialized') ? 503 : 500;

      throw new RpcException({
        statusCode,
        message: error.message,
      });
    }
  }

  @MessagePattern('ai.generate_embedding_batch')
  async handleGenerateEmbeddingBatch(
    @Payload() data: GenerateEmbeddingBatchRequest,
  ) {
    const ids = data?.items?.map((item) => item.id) ?? [];
    if (
      !data ||
      !Array.isArray(data.items) ||
      data.items.length === 0 ||
      data.items.length > 100 ||
      new Set(ids).size !== ids.length ||
      data.items.some(
        (item) =>
          typeof item !== 'object' ||
          item === null ||
          typeof item.id !== 'string' ||
          !item.id.trim() ||
          typeof item.text !== 'string' ||
          !item.text.trim() ||
          item.text.length > 20_000,
      )
    ) {
      throw new RpcException({
        statusCode: 400,
        message: 'Invalid batch embedding request payload',
      });
    }

    return await this.generateEmbeddingBatchUseCase.execute(data);
  }

  @MessagePattern('ai.rerank_texts')
  async handleRerankTexts(@Payload() data: RerankTextsRequest) {
    if (
      !data ||
      typeof data.queryText !== 'string' ||
      !data.queryText.trim() ||
      data.queryText.length > RERANK_TEXTS_MAX_TEXT_LENGTH ||
      !Array.isArray(data.texts) ||
      data.texts.length === 0 ||
      data.texts.length > RERANK_TEXTS_MAX_ITEMS ||
      data.texts.some(
        (text) =>
          typeof text !== 'string' ||
          !text.trim() ||
          text.length > RERANK_TEXTS_MAX_TEXT_LENGTH,
      ) ||
      (data.budgetMs !== undefined &&
        (!Number.isFinite(data.budgetMs) || data.budgetMs <= 0))
    ) {
      throw new RpcException({
        statusCode: 400,
        message: 'Invalid rerank texts request payload',
      });
    }

    try {
      return await this.scoreTextRelevanceUseCase.execute(data);
    } catch (err: unknown) {
      const error = err as Error;
      console.error(`[RerankTexts] ${error.message}`);
      throw new RpcException({ statusCode: 503, message: error.message });
    }
  }

  @MessagePattern('ai.count_document_tokens')
  async handleCountDocumentTokens(@Payload() data: CountDocumentTokensRequest) {
    const ids = data?.items?.map((item) => item.id) ?? [];
    if (
      !data ||
      typeof data.model !== 'string' ||
      !data.model.trim() ||
      !Array.isArray(data.items) ||
      data.items.length === 0 ||
      data.items.length > 100 ||
      new Set(ids).size !== ids.length ||
      data.items.some(
        (item) =>
          typeof item?.id !== 'string' ||
          !item.id.trim() ||
          typeof item.text !== 'string' ||
          !item.text.trim() ||
          item.text.length > 20_000,
      )
    ) {
      throw new RpcException({
        statusCode: 400,
        message: 'Invalid document token count request payload',
      });
    }
    return await this.countDocumentTokensUseCase.execute(data);
  }

  @MessagePattern('ai.transcribe_audio_buffer')
  async handleTranscribeAudioBuffer(
    @Payload() payload: { audioBase64: string; initialPrompt?: string },
  ) {
    if (!payload || typeof payload.audioBase64 !== 'string') {
      throw new RpcException({
        statusCode: 400,
        message: 'Invalid audio buffer payload received from RabbitMQ',
      });
    }

    try {
      const transcription = await this.transcribeAudioBufferUseCase.execute(
        payload.audioBase64,
        { initialPrompt: payload.initialPrompt },
      );
      return {
        transcript: transcription.text,
        transcription,
      };
    } catch (err: unknown) {
      const error = err as Error;
      console.error(`[TranscribeAudioBuffer] ${error.message}`);
      throw new RpcException({
        statusCode: 500,
        message: error.message,
      });
    }
  }

  @MessagePattern('ai.transcribe_audio')
  async handleTranscribeAudio(
    @Payload() payload: { audioKey: string; initialPrompt?: string },
  ) {
    try {
      if (!payload || typeof payload.audioKey !== 'string') {
        throw new Error('Invalid audio key payload received from RabbitMQ');
      }

      const transcription = await this.transcribeAudioUseCase.execute(
        payload.audioKey,
        { initialPrompt: payload.initialPrompt },
      );
      return {
        transcript: transcription.text,
        transcription,
      };
    } catch (err: unknown) {
      const error = err as Error;
      console.error(`[TranscribeAudio] ${error.message}`);
      throw new RpcException({
        statusCode: 500,
        message: error.message,
      });
    }
  }

  @MessagePattern('ai.analyze_visual_frame')
  async handleAnalyzeVisualFrame(
    @Payload() payload: AnalyzeVisualFrameRequest,
  ) {
    if (!payload || typeof payload.imageBase64 !== 'string') {
      throw new RpcException({
        statusCode: 400,
        message: 'Invalid visual frame payload received from RabbitMQ',
      });
    }

    try {
      return await this.analyzeVisualFrameUseCase.execute(payload);
    } catch (err: unknown) {
      const error = err as Error;
      console.error(`[AnalyzeVisualFrame] ${error.message}`);
      throw new RpcException({
        statusCode: 500,
        message: error.message,
      });
    }
  }

  private isValidImages(images: unknown): boolean {
    return (
      Array.isArray(images) &&
      images.length <= MAX_CHAT_IMAGES_PER_AI_TURN &&
      images.every(
        (image: unknown) =>
          typeof image === 'object' &&
          image !== null &&
          typeof (image as { fileKey?: unknown }).fileKey === 'string' &&
          isChatImageMimeType((image as { mimeType?: unknown }).mimeType),
      )
    );
  }

  @MessagePattern('ai.stream_question')
  async handleStreamQuestion(
    @Payload() data: AskQuestionPayload,
  ): Promise<AskQuestionResponse> {
    if (
      !data ||
      typeof data.message !== 'string' ||
      typeof data.userId !== 'string' ||
      typeof data.conversationId !== 'string' ||
      (data.images !== undefined && !this.isValidImages(data.images)) ||
      // The words may only be missing when a photo carries the turn.
      (!data.message.trim() && !data.images?.length)
    ) {
      throw new RpcException({
        statusCode: 400,
        message: 'Invalid stream payload structure',
      });
    }

    try {
      const result = await this.streamChatUseCase.execute({
        message: data.message,
        userId: data.userId,
        conversationId: data.conversationId,
        memory: data.memory,
        ...(data.replyToReelId ? { replyToReelId: data.replyToReelId } : {}),
        ...(data.images?.length ? { images: data.images } : {}),
      });

      if (!result.answer || result.answer.trim() === '') {
        return {
          error: {
            code: 'NO_CONTENT',
            message: 'No relevant video content found for this query.',
          },
        };
      }

      return {
        answer: result.answer,
        citations: result.citations ?? [],
        recommendedReels: result.recommendedReels ?? [],
        suggestedQueries: result.suggestedQueries ?? [],
        ...(result.imageDescription
          ? { imageDescription: result.imageDescription }
          : {}),
      };
    } catch (err: unknown) {
      if (err instanceof ChatBusyError) {
        // Not a failure of the AI: a fast, typed "try again shortly" the client can show.
        return {
          error: {
            code: 'AI_BUSY',
            message:
              'Velora AI is busy right now. Please try again in a moment.',
            retryAfterSeconds: err.retryAfterSeconds,
          },
        };
      }
      if (err instanceof ChatImageUnreadableError) {
        // The photo is what the user asked about, so say so instead of answering without it.
        return {
          error: {
            code: 'IMAGE_UNREADABLE',
            message: 'Velora AI could not read that image. Try another photo.',
          },
        };
      }
      const error = err as Error;
      console.error(`[StreamQuestion] ${error.message}`);

      throw new RpcException({
        statusCode: 500,
        message: error.message,
      });
    }
  }

  @EventPattern('ai.conversation_turn_completed')
  async handleConversationTurnCompleted(
    @Payload() payload: ConversationTurnCompletedPayload,
  ): Promise<void> {
    try {
      await this.handleConversationTurnCompletedUseCase.execute(payload);
      // Embed what the user just said now, so a later recall question finds it already done.
      this.recallConversationContextUseCase?.warm(payload.userMessage);
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`[ConversationTurnCompleted] ${message}`);
    }
  }

  @MessagePattern('ai.extract_reel_metadata')
  async handleExtractReelMetadata(
    @Payload() data: ReelMetadataExtractionInput,
  ) {
    if (!data || typeof data !== 'object') {
      throw new RpcException({
        statusCode: 400,
        message: 'Invalid reel metadata extraction payload',
      });
    }

    try {
      const metadata = await this.extractReelMetadataUseCase.execute(data);

      return { metadata };
    } catch (err: unknown) {
      if (err instanceof RpcException) {
        throw err;
      }

      const error = err as Error;
      console.error(`[ExtractReelMetadata] ${error.message}`);

      throw new RpcException({
        statusCode: 500,
        message: error.message,
      });
    }
  }

  @MessagePattern('ai.translate_subtitle_cues')
  async handleTranslateSubtitleCues(
    @Payload() data: TranslateSubtitleCuesRequest,
  ) {
    try {
      return await this.translateSubtitleCuesUseCase.execute(data);
    } catch (err: unknown) {
      if (err instanceof InvalidSubtitleTranslationRequestError) {
        throw new RpcException({ statusCode: 400, message: err.message });
      }
      const error = err as Error;
      console.error(`[TranslateSubtitleCues] ${error.message}`);
      throw new RpcException({ statusCode: 500, message: error.message });
    }
  }

  @MessagePattern('ai.backfill_user_memory_embeddings')
  async handleBackfillUserMemoryEmbeddings(
    @Payload() payload?: { limit?: number },
  ) {
    try {
      const result = await this.backfillUserMemoryEmbeddingsUseCase.execute({
        limit: payload?.limit,
      });

      return result;
    } catch (err: unknown) {
      const error = err as Error;

      console.error(`[BackfillUserMemoryEmbeddings] ${error.message}`);

      throw new RpcException({
        statusCode: 500,
        message: error.message,
      });
    }
  }
}
