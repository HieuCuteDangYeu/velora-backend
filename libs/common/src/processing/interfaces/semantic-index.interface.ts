import type {
  ReelSourceLengthClass,
  ReelSourceOrientation,
} from '@common/content/interfaces/reel-state.interface';

export const SEMANTIC_INDEX_PATTERNS = {
  SEARCH_REELS: 'index.search_reels',
  SEARCH_SECTIONS: 'index.search_sections',
  SEARCH_CHUNKS: 'index.search_chunks',
  SEARCH_VISUAL_SCENES: 'index.search_visual_scenes',
  GET_ADJACENT_CHUNKS: 'index.get_adjacent_chunks',
  GET_REEL_DOCUMENT: 'index.get_reel_document',
  DELETE_REEL: 'index.delete_reel',
  REINDEX_REEL: 'index.reindex_reel',
} as const;

export const REEL_INDEX_QUERY_QUEUE = 'reel_index_query';
export const SEMANTIC_INDEX_EMBEDDING_DIMENSIONS = 1024;

export type SemanticIndexEvidenceType = 'TRANSCRIPT' | 'VISUAL' | 'METADATA';

export interface SemanticIndexSearchFilters {
  reelIds?: string[];
  userIds?: string[];
  parentIds?: string[];
  tags?: string[];
  sourceLengthClasses?: ReelSourceLengthClass[];
}

export interface SemanticIndexSearchRequest {
  /** Read the beginning of a scoped transcript, rather than rank by similarity. */
  sourceOrder?: 'ASC';
  queryText?: string;
  queryEmbedding?: number[];
  queryEmbeddingModel?: string;
  queryEmbeddingVersion?: string;
  queryTags?: string[];
  filters?: SemanticIndexSearchFilters;
  excludedIds?: string[];
  requiredIndexVersion?: string;
  limit?: number;
  candidateLimit?: number;
}

export interface SemanticIndexSearchResult {
  id: string;
  indexVersion?: string;
  reelId: string;
  parentId?: string;
  ordinal: number;
  userId: string;
  /** Backward-compatible alias of retrievalText. */
  text: string;
  retrievalText: string;
  evidenceText?: string;
  evidenceType: SemanticIndexEvidenceType;
  tags: string[];
  startTime?: number;
  endTime?: number;
  sourceDurationMs: number;
  sourceOrientation: ReelSourceOrientation;
  sourceLengthClass: ReelSourceLengthClass;
  rrfScore: number;
  vectorDistance?: number;
  vectorRank?: number;
  keywordRank?: number;
  metadataRank?: number;
}

export interface AdjacentChunkRequest {
  chunkId: string;
  reelId: string;
  parentId: string;
  eligibleReelIds: string[];
  requiredIndexVersion?: string;
  limit?: number;
}

export interface SemanticReelDocument {
  id: string;
  reelId: string;
  userId: string;
  title?: string;
  description?: string;
  text: string;
  tags: string[];
  sourceDurationMs: number;
  sourceOrientation: ReelSourceOrientation;
  sourceLengthClass: ReelSourceLengthClass;
  indexAttemptId: string;
  indexVersion: string;
  embeddingProvider: string;
  embeddingModel: string;
  embeddingDimensions: number;
  embeddingVersion: string;
  chunkingVersion: string;
  summaryVersion: string;
  createdAt: string;
  updatedAt: string;
}

export interface SemanticIndexDeleteResult {
  deleted: boolean;
}

export interface SemanticIndexReindexResult {
  queued: boolean;
  indexAttemptId?: string;
  embeddingIdentity?: {
    model: string;
    dimensions: number;
    version: string;
  };
}

export interface SemanticIndexReindexRequest {
  reelId?: string;
  expectedEmbeddingIdentity?: {
    model: string;
    dimensions: number;
    version: string;
  };
}
