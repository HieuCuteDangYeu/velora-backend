export interface ITextRelevanceScorer {
  /** Scores every text against the query; the result is aligned with `texts`. */
  scoreTexts(input: {
    queryText: string;
    texts: string[];
    budgetMs?: number;
  }): Promise<number[]>;
}
