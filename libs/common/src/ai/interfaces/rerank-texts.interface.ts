export const RERANK_TEXTS_MAX_ITEMS = 50;
export const RERANK_TEXTS_MAX_TEXT_LENGTH = 4_000;

export interface RerankTextsRequest {
  queryText: string;
  texts: string[];
  /** Wall-clock budget; the scorer stops between batches once it is spent. */
  budgetMs?: number;
}

export interface RerankTextsResult {
  /** One relevance probability in [0, 1] per input text, same order. */
  scores: number[];
}
