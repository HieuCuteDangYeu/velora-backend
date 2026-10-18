import {
  SEMANTIC_INDEX_PATTERNS,
  type AdjacentChunkRequest,
  type SemanticIndexDeleteResult,
  type SemanticIndexReindexResult,
  type SemanticIndexReindexRequest,
  type SemanticIndexSearchRequest,
  type SemanticIndexSearchResult,
  type SemanticReelDocument,
} from '@common/processing/interfaces/semantic-index.interface';
import type { IIndexingContentService } from '@indexing/domain/interfaces/content-service.interface';
import type { IIndexingApplicationConfig } from '@indexing/domain/interfaces/indexing-application-config.interface';
import type { ISemanticIndexRepository } from '@indexing/domain/interfaces/semantic-index.repository.interface';
import { Controller, Inject } from '@nestjs/common';
import { MessagePattern, Payload } from '@nestjs/microservices';

@Controller()
export class SemanticIndexController {
  constructor(
    @Inject('ISemanticIndexRepository')
    private readonly semanticIndex: ISemanticIndexRepository,
    @Inject('IIndexingContentService')
    private readonly content: IIndexingContentService,
    @Inject('IIndexingApplicationConfig')
    private readonly config: IIndexingApplicationConfig,
  ) {}

  @MessagePattern(SEMANTIC_INDEX_PATTERNS.SEARCH_REELS)
  async searchReels(
    @Payload() input: SemanticIndexSearchRequest,
  ): Promise<SemanticIndexSearchResult[]> {
    return await this.semanticIndex.searchReels(input ?? {});
  }

  @MessagePattern(SEMANTIC_INDEX_PATTERNS.SEARCH_SECTIONS)
  async searchSections(
    @Payload() input: SemanticIndexSearchRequest,
  ): Promise<SemanticIndexSearchResult[]> {
    return await this.semanticIndex.searchSections(input ?? {});
  }

  @MessagePattern(SEMANTIC_INDEX_PATTERNS.SEARCH_CHUNKS)
  async searchChunks(
    @Payload() input: SemanticIndexSearchRequest,
  ): Promise<SemanticIndexSearchResult[]> {
    return await this.semanticIndex.searchChunks(input ?? {});
  }

  @MessagePattern(SEMANTIC_INDEX_PATTERNS.SEARCH_VISUAL_SCENES)
  async searchVisualScenes(
    @Payload() input: SemanticIndexSearchRequest,
  ): Promise<SemanticIndexSearchResult[]> {
    return await this.semanticIndex.searchVisualScenes(input ?? {});
  }

  @MessagePattern(SEMANTIC_INDEX_PATTERNS.GET_ADJACENT_CHUNKS)
  async getAdjacentChunks(
    @Payload() input: AdjacentChunkRequest,
  ): Promise<SemanticIndexSearchResult[]> {
    return await this.semanticIndex.getAdjacentChunks(input);
  }

  @MessagePattern(SEMANTIC_INDEX_PATTERNS.GET_REEL_DOCUMENT)
  async getReelDocument(
    @Payload() input: { reelId?: string },
  ): Promise<SemanticReelDocument | null> {
    return await this.semanticIndex.getReelDocument(
      this.requiredReelId(input?.reelId),
    );
  }

  @MessagePattern(SEMANTIC_INDEX_PATTERNS.DELETE_REEL)
  async deleteReel(
    @Payload() input: { reelId?: string },
  ): Promise<SemanticIndexDeleteResult> {
    return {
      deleted: await this.semanticIndex.deleteReel(
        this.requiredReelId(input?.reelId),
      ),
    };
  }

  @MessagePattern(SEMANTIC_INDEX_PATTERNS.REINDEX_REEL)
  async reindexReel(
    @Payload() input: SemanticIndexReindexRequest,
  ): Promise<SemanticIndexReindexResult> {
    const actual = this.config.embeddingIdentity();
    const expected = input?.expectedEmbeddingIdentity;
    if (
      !expected ||
      expected.model !== actual.model ||
      expected.version !== actual.version ||
      expected.dimensions !== actual.dimensions
    ) {
      throw new Error('Reindex embedding identity does not match this worker');
    }
    const options =
      input?.requireVisualAnalysis === undefined
        ? undefined
        : { requireVisualAnalysis: input.requireVisualAnalysis };
    const queued = options
      ? await this.content.reindexReel(
          this.requiredReelId(input?.reelId),
          options,
        )
      : await this.content.reindexReel(this.requiredReelId(input?.reelId));
    return {
      ...queued,
      embeddingIdentity: actual,
    };
  }

  private requiredReelId(reelId: string | undefined): string {
    if (!reelId?.trim()) throw new Error('reelId is required');
    return reelId.trim();
  }
}
