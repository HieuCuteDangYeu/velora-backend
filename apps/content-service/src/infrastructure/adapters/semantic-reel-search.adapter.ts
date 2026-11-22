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
// Transcript chunks are tighter: a chunk that is about the query sits at 0.30-0.37, unrelated text at 0.50+.
const DEFAULT_MAX_CHUNK_DISTANCE = 0.45;
// Sampled-frame descriptions: relevant 0.34-0.39, a merely plausible off-topic query 0.41-0.46, unrelated 0.57.
const DEFAULT_MAX_VISUAL_DISTANCE = 0.4;
// Hydration drops private reels after the search, so ask for more than the caller wants.
const MAX_CANDIDATES = 40;
const RRF_K = 60;

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
      const wanted = Math.min(
        Math.max(input.limit * 3, input.limit),
        MAX_CANDIDATES,
      );
      const base: SemanticIndexSearchRequest = {
        queryText: input.query,
        limit: wanted,
        candidateLimit: Math.min(Math.max(wanted * 4, 24), 120),
        ...(embedding
          ? {
              queryEmbedding: embedding.values,
              queryEmbeddingModel: embedding.model,
              queryEmbeddingVersion: embedding.version,
            }
          : {}),
      };
      // Reel documents (title, summary, tags) and, with a query vector, the transcript chunks: a frame
      // or a paraphrase names the topic the speaker talks about, which a title rarely does.
      const optional = (pattern: string, label: string) =>
        embedding
          ? this.search(pattern, base).catch((error: unknown) => {
              this.logger.warn(
                `${label} search for reel lookup failed: ${error instanceof Error ? error.message : String(error)}`,
              );
              return [] as SemanticIndexSearchResult[];
            })
          : Promise.resolve([] as SemanticIndexSearchResult[]);
      const [reelHits, chunkHits, sceneHits] = await Promise.all([
        this.search(SEMANTIC_INDEX_PATTERNS.SEARCH_REELS, base),
        optional(SEMANTIC_INDEX_PATTERNS.SEARCH_CHUNKS, 'Chunk'),
        optional(SEMANTIC_INDEX_PATTERNS.SEARCH_VISUAL_SCENES, 'Visual scene'),
      ]);
      const maxDistance = this.maxVectorDistance();
      const maxChunkDistance = this.maxChunkDistance();
      const reelRanked = reelHits.filter(
        (result) =>
          // Keyword and tag matches always count; a vector-only match must be close enough.
          result.vectorDistance === undefined ||
          result.vectorDistance === null ||
          result.keywordRank !== undefined ||
          result.metadataRank !== undefined ||
          result.vectorDistance <= maxDistance,
      );
      const chunkRanked = chunkHits.filter(
        (result) =>
          result.keywordRank !== undefined ||
          (typeof result.vectorDistance === 'number' &&
            result.vectorDistance <= maxChunkDistance),
      );
      const maxVisualDistance = this.maxVisualDistance();
      const sceneRanked = sceneHits.filter(
        (result) =>
          typeof result.vectorDistance === 'number' &&
          result.vectorDistance <= maxVisualDistance,
      );
      const scores = new Map<string, number>();
      const add = (list: SemanticIndexSearchResult[]) => {
        const seen = new Set<string>();
        for (const result of list) {
          if (seen.has(result.reelId)) continue;
          seen.add(result.reelId);
          scores.set(
            result.reelId,
            (scores.get(result.reelId) ?? 0) + 1 / (RRF_K + seen.size),
          );
        }
      };
      add(reelRanked);
      add(chunkRanked);
      add(sceneRanked);
      return [...scores.entries()]
        .sort((left, right) => right[1] - left[1])
        .slice(0, wanted)
        .map(([reelId, score]) => ({ reelId, score }));
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.warn(`Indexing public search unavailable: ${message}`);
      return [];
    }
  }

  private async search(
    pattern: string,
    request: SemanticIndexSearchRequest,
  ): Promise<SemanticIndexSearchResult[]> {
    const results = await firstValueFrom(
      this.indexClient
        .send<SemanticIndexSearchResult[]>(pattern, request)
        .pipe(timeout(4_000)),
    );
    return Array.isArray(results) ? results : [];
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

  private maxVisualDistance(): number {
    const value = Number(
      this.config?.get<string>('REEL_SEARCH_MAX_VISUAL_DISTANCE') ??
        DEFAULT_MAX_VISUAL_DISTANCE,
    );
    return Number.isFinite(value) && value > 0 && value <= 2
      ? value
      : DEFAULT_MAX_VISUAL_DISTANCE;
  }

  private maxChunkDistance(): number {
    const value = Number(
      this.config?.get<string>('REEL_SEARCH_MAX_CHUNK_DISTANCE') ??
        DEFAULT_MAX_CHUNK_DISTANCE,
    );
    return Number.isFinite(value) && value > 0 && value <= 2
      ? value
      : DEFAULT_MAX_CHUNK_DISTANCE;
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
