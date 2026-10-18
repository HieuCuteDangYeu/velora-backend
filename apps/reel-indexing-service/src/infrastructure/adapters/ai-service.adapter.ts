import { IndexQualityReviewSchema } from '@common/ai/dtos/index-quality-review.dto';
import type {
  CountDocumentTokensRequest,
  CountDocumentTokensResult,
} from '@common/ai/interfaces/count-document-tokens.interface';
import type {
  GenerateEmbeddingBatchRequest,
  GenerateEmbeddingBatchResult,
} from '@common/ai/interfaces/generate-embedding.interface';
import type { IndexQualityReviewResult as IndexQualityReviewTransportResult } from '@common/ai/interfaces/index-quality-review.interface';
import type { ExtractedReelMetadata } from '@common/ai/interfaces/reel-metadata-extraction.interface';
import type { TranscriptionResult } from '@common/ai/interfaces/transcription-result.interface';
import type {
  AnalyzeVisualFrameRequest,
  VisualFrameAnalysis,
} from '@common/ai/interfaces/visual-analysis.interface';
import { isRpcError } from '@common/constants/rpc-error.types';
import type {
  IIndexingAiService,
  IndexingVisualFrameInput,
  IndexQualityReviewInput,
  IndexQualityReviewResult,
} from '@indexing/domain/interfaces/ai-service.interface';
import { Inject, Injectable } from '@nestjs/common';
import type { ClientProxy } from '@nestjs/microservices';
import { catchError, firstValueFrom, throwError, timeout } from 'rxjs';

@Injectable()
export class AiServiceAdapter implements IIndexingAiService {
  constructor(@Inject('AI_SERVICE_RMQ') private readonly client: ClientProxy) {}

  async transcribeAudioKey(input: {
    audioKey: string;
    initialPrompt?: string;
  }): Promise<TranscriptionResult> {
    const response = await firstValueFrom(
      this.client
        .send<{
          transcript: string;
          transcription?: TranscriptionResult;
        }>('ai.transcribe_audio', input)
        .pipe(timeout(10 * 60_000)),
    );
    return response.transcription ?? { text: response.transcript };
  }

  async analyzeVisualFrame(
    input: IndexingVisualFrameInput,
  ): Promise<VisualFrameAnalysis> {
    const request: AnalyzeVisualFrameRequest = {
      imageBase64: Buffer.from(input.imageBytes).toString('base64'),
      mimeType: input.mimeType,
      timestampMs: input.timestampMs,
    };

    return await firstValueFrom(
      this.client
        .send<VisualFrameAnalysis>('ai.analyze_visual_frame', request)
        .pipe(
          timeout(120_000),
          catchError((error: unknown) => {
            if (isRpcError(error)) {
              const message = Array.isArray(error.message)
                ? error.message.join(', ')
                : error.message;
              return throwError(() => new Error(message));
            }
            return throwError(() =>
              error instanceof Error
                ? error
                : new Error('Visual frame analysis failed'),
            );
          }),
        ),
    );
  }

  async extractReelMetadata(input: {
    title?: string;
    description?: string;
    tags?: string[];
    transcript?: string;
    maxTags?: number;
  }): Promise<ExtractedReelMetadata> {
    const response = await firstValueFrom(
      this.client
        .send<{
          metadata: ExtractedReelMetadata;
        }>('ai.extract_reel_metadata', input)
        .pipe(timeout(120_000)),
    );
    return response.metadata;
  }

  async reviewIndexQuality(
    input: IndexQualityReviewInput,
  ): Promise<IndexQualityReviewResult> {
    const payload = IndexQualityReviewSchema.parse(input);

    return await firstValueFrom(
      this.client
        .send<IndexQualityReviewTransportResult>(
          'ai.review_index_quality',
          payload,
        )
        .pipe(
          timeout(120_000),
          catchError((error: unknown) => {
            if (isRpcError(error)) {
              const message = Array.isArray(error.message)
                ? error.message.join(', ')
                : error.message;
              return throwError(() => new Error(message));
            }
            return throwError(() =>
              error instanceof Error
                ? error
                : new Error('AI index quality review failed'),
            );
          }),
        ),
    );
  }

  async generateEmbeddingBatch(
    input: GenerateEmbeddingBatchRequest,
  ): Promise<GenerateEmbeddingBatchResult> {
    return await firstValueFrom(
      this.client
        .send<GenerateEmbeddingBatchResult>(
          'ai.generate_embedding_batch',
          input,
        )
        .pipe(timeout(120_000)),
    );
  }

  async countDocumentTokens(
    input: CountDocumentTokensRequest,
  ): Promise<CountDocumentTokensResult> {
    return await firstValueFrom(
      this.client
        .send<CountDocumentTokensResult>('ai.count_document_tokens', input)
        .pipe(timeout(120_000)),
    );
  }
}
