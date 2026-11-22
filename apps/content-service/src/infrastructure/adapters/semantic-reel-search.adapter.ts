import type { IAiEmbeddingService } from '@content/application/use-cases/ai-embedding.service.interface';
import type {
  ISemanticReelSearchService,
  SemanticReelSearchCandidate,
} from '@content/domain/interfaces/semantic-reel-search.service.interface';
import {
  SEMANTIC_INDEX_PATTERNS,
  type SemanticIndexSearchRequest,
  type SemanticIndexSearchResult,
} from '@common/processing/interfaces/semantic-index.interface';
import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ClientProxy } from '@nestjs/microservices';
import { firstValueFrom, timeout } from 'rxjs';

// Search must not wait long for the embedder (it is shared with indexing); past this it runs on keywords only.
const QUERY_EMBEDDING_WAIT_MS = 2_500;
// Measured on bge-m3 reel documents (2026-11-22): matching queries sit at 0.41-0.48 cosine distance and
// unrelated ones at 0.58 or more. A reel that only matched by vector must be closer than this.
const DEFAULT_MAX_VECTOR_DISTANCE = 0.55;

@Injectable()
export class SemanticReelSearchAdapter implements ISemanticReelSearchService {
  private readonly logger = new Logger(SemanticReelSearchAdapter.name);

  constructor(
    @Inject('INDEX_SERVICE_RMQ') private readonly indexClient: ClientProxy,
    @Optional()
    @Inject('IAiEmbeddingService')
    private readonly embeddingService?: IAiEmbeddingService,
    @Optional() private readonly config?: ConfigService,
  ) {}

  async searchPublicReels(input: {
    query: string;
    limit: number;
  }): Promise<SemanticReelSearchCandidate[]> {
    try {
      const embedding = await this.embed(input.query);
      const request: SemanticIndexSearchRequest = {
        queryText: input.query,
        limit: input.limit,
        candidateLimit: Math.min(Math.max(input.limit * 4, 24), 120),
        ...(embedding
          ? {
              queryEmbedding: embedding.values,
              queryEmbeddingModel: embedding.model,
              queryEmbeddingVersion: embedding.version,
            }
          : {}),
      };
      const results = await firstValueFrom(
        this.indexClient
          .send<
            SemanticIndexSearchResult[]
          >(SEMANTIC_INDEX_PATTERNS.SEARCH_REELS, request)
          .pipe(timeout(4_000)),
      );
      const maxDistance = this.maxVectorDistance();
      return (Array.isArray(results) ? results : [])
        .filter(
          (result) =>
            // Keyword and tag matches always count; a vector-only match must be close enough.
            result.vectorDistance === undefined ||
            result.vectorDistance === null ||
            result.keywordRank !== undefined ||
            result.metadataRank !== undefined ||
            result.vectorDistance <= maxDistance,
        )
        .map((result) => ({
          reelId: result.reelId,
          score: result.rrfScore,
        }));
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.warn(`Indexing public search unavailable: ${message}`);
      return [];
    }
  }

  /** The query vector, or null when the embedder is missing, slow or fails (search then uses keywords). */
  private async embed(query: string) {
    if (!this.embeddingService) return null;
    try {
      const embedding = await Promise.race([
        this.embeddingService.generateEmbedding({
          text: query,
          taskType: 'RETRIEVAL_QUERY',
        }),
        new Promise<never>((_resolve, reject) =>
          setTimeout(
            () => reject(new Error('query embedding timed out')),
            QUERY_EMBEDDING_WAIT_MS,
          ).unref(),
        ),
      ]);
      return embedding.model?.trim() && embedding.version?.trim()
        ? embedding
        : null;
    } catch (error: unknown) {
      this.logger.warn(
        `Reel search without a query vector: ${error instanceof Error ? error.message : String(error)}`,
      );
      return null;
    }
  }

  private maxVectorDistance(): number {
    const value = Number(
      this.config?.get<string>('REEL_SEARCH_MAX_VECTOR_DISTANCE') ??
        DEFAULT_MAX_VECTOR_DISTANCE,
    );
    return Number.isFinite(value) && value > 0 && value <= 2
      ? value
      : DEFAULT_MAX_VECTOR_DISTANCE;
  }
}
