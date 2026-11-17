import type { GenerateEmbeddingResult } from '@common/ai/interfaces/generate-embedding.interface';
import { TtlPromiseCache } from '@content/application/services/ttl-promise-cache';
import type { IAiEmbeddingService } from '@content/application/use-cases/ai-embedding.service.interface';
import type {
  ISemanticRecommendationService,
  SemanticRecommendationInput,
} from '@content/domain/interfaces/semantic-recommendation.service.interface';
import {
  SEMANTIC_INDEX_PATTERNS,
  type SemanticIndexSearchRequest,
  type SemanticIndexSearchResult,
} from '@common/processing/interfaces/semantic-index.interface';
import { Inject, Injectable, Logger } from '@nestjs/common';
import { ClientProxy } from '@nestjs/microservices';
import { firstValueFrom, timeout } from 'rxjs';

// A viewer's interest tags change slowly, but every new feed session (every app open, and each
// session of a burst) embeds the same text again on the CPU embedding server it shares with
// indexing. Reusing the vector for a few minutes takes that load off it and the wait out of the refill.
const QUERY_EMBEDDING_TTL_MS = 10 * 60_000;
// The semantic source only enriches the feed. When the embedder is overloaded the AI service
// retries with backoff for up to ~8 s; the refill stops waiting after this and carries on
// without the source (the embedding still lands in the cache for the next session).
const QUERY_EMBEDDING_WAIT_MS = 2_500;

@Injectable()
export class SemanticRecommendationServiceAdapter implements ISemanticRecommendationService {
  private readonly logger = new Logger(
    SemanticRecommendationServiceAdapter.name,
  );

  private readonly queryEmbeddings =
    new TtlPromiseCache<GenerateEmbeddingResult>(QUERY_EMBEDDING_TTL_MS, 500);

  constructor(
    @Inject('IAiEmbeddingService')
    private readonly embeddingService: IAiEmbeddingService,
    @Inject('INDEX_SERVICE_RMQ')
    private readonly indexClient: ClientProxy,
  ) {}

  async findCandidates(input: SemanticRecommendationInput) {
    const interestTags = this.uniqueStrings(input.interestTags).slice(0, 20);

    if (interestTags.length === 0) {
      return [];
    }

    try {
      const interestText = interestTags.join(' ');
      const embedding = await this.withinWait(
        this.queryEmbeddings.get(interestText, () =>
          this.embeddingService.generateEmbedding({
            text: interestText,
            taskType: 'RETRIEVAL_QUERY',
          }),
        ),
        QUERY_EMBEDDING_WAIT_MS,
      );
      const searchLimit = Math.min(Math.max(Math.floor(input.limit), 1), 100);
      const hasEmbeddingIdentity = Boolean(
        embedding.model?.trim() && embedding.version?.trim(),
      );
      const request: SemanticIndexSearchRequest = {
        queryText: interestText,
        queryTags: interestTags,
        limit: searchLimit,
        candidateLimit: Math.min(Math.max(searchLimit * 4, 100), 1_000),
        ...(hasEmbeddingIdentity
          ? {
              queryEmbedding: embedding.values,
              queryEmbeddingModel: embedding.model,
              queryEmbeddingVersion: embedding.version,
            }
          : {}),
      };

      if (!hasEmbeddingIdentity) {
        this.logger.warn(
          'AI embedding response did not include model/version identity; semantic recommendation is falling back to keyword/tag hybrid retrieval.',
        );
      }

      const results = await firstValueFrom(
        this.indexClient
          .send<
            SemanticIndexSearchResult[]
          >(SEMANTIC_INDEX_PATTERNS.SEARCH_REELS, request)
          .pipe(timeout(4_000)),
      );

      return (Array.isArray(results) ? results : []).map((result, index) => {
        const vectorScore =
          result.vectorDistance === undefined
            ? 0
            : this.clamp(1 - result.vectorDistance);
        const rankScore = 1 / (index + 1);
        const hybridScore =
          result.vectorDistance === undefined
            ? rankScore
            : vectorScore * 0.8 + rankScore * 0.2;

        return {
          reelId: result.reelId,
          source: 'SEMANTIC' as const,
          sourceScore: this.clamp(hybridScore),
          reasons: [
            result.vectorDistance === undefined
              ? 'hybrid keyword and interest-tag match'
              : 'semantic match to viewer interest vector',
          ],
        };
      });
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.warn(
        `Semantic recommendation source unavailable: ${message}. Continuing without semantic candidates.`,
      );
      return [];
    }
  }

  private async withinWait<T>(work: Promise<T>, waitMs: number): Promise<T> {
    let timer: NodeJS.Timeout | undefined;
    try {
      return await Promise.race([
        work,
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () =>
              reject(new Error(`query embedding not ready within ${waitMs}ms`)),
            waitMs,
          );
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  }

  private uniqueStrings(values: string[]): string[] {
    return [
      ...new Set(
        values
          .map((value) => value.normalize('NFKC').trim().toLowerCase())
          .filter(Boolean),
      ),
    ];
  }

  private clamp(value: number): number {
    if (!Number.isFinite(value)) return 0;
    return Math.min(Math.max(value, 0), 1);
  }
}
