export type ReelEvidenceType = 'TRANSCRIPT' | 'VISUAL' | 'METADATA';

export interface ReelContextSearchResult {
  chunkId: string;
  parentId?: string;
  ordinal?: number;
  indexVersion?: string;
  reelId: string;
  title?: string;
  description?: string;
  tags: string[];
  /** Grounded evidence that may be quoted or shown to the answer model. */
  chunkText: string;
  /** Enriched text used for search/reranking. Never quote this as source evidence. */
  retrievalText?: string;
  /** Exact normalized source evidence used for citations when available. */
  evidenceText?: string;
  evidenceType?: ReelEvidenceType;
  startTime?: number | null;
  endTime?: number | null;
  distance: number | null;
  score?: number; // final retrieval score from the semantic index
  rerankScore?: number; // reranker score from ai-service
  vectorScore?: number;
  keywordScore?: number;
  metadataScore?: number;
  matchedBy?: 'VECTOR' | 'KEYWORD' | 'HYBRID';
}
