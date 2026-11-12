export interface RecommendationRerankSettings {
  enabled: boolean;
  /** Only the top-K ranked reels are sent to the cross-encoder. */
  topK: number;
  /** Maximum score shift (peak to peak) the rerank can apply. */
  weight: number;
  timeoutMs: number;
  /**
   * When on, each feed session is assigned an arm from its id: treatment
   * applies the rerank, control scores the same reels but keeps the feature
   * order. Both log a ReelRerankExposure row per scored reel.
   */
  experimentEnabled: boolean;
  /** Share of feed sessions (0-100) assigned to treatment. */
  treatmentPercent: number;
}

export interface IRecommendationRerankerService {
  getSettings(): RecommendationRerankSettings;

  /**
   * Scores each document against the query with the cross-encoder. Resolves
   * with one probability per document, or null when the reranker is
   * unavailable, so the caller can keep the order it already has.
   */
  scoreDocuments(input: {
    queryText: string;
    documents: string[];
  }): Promise<number[] | null>;
}
