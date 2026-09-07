import type { ReelContextSearchResult } from '@common/content/interfaces/reel-context-search-result.interface';
import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

export interface ScoredRerankCandidate {
  candidate: ReelContextSearchResult;
  relevanceScore: number;
}

@Injectable()
export class HybridRetrievalScorer {
  constructor(private readonly configService: ConfigService) {}

  score(
    queryText: string,
    candidates: ReelContextSearchResult[],
  ): ScoredRerankCandidate[] {
    const query = this.normalize(queryText);
    const queryTerms = this.tokenize(query);
    const idf = this.buildIdfWeights(candidates, queryTerms);

    return candidates.map((candidate) => {
      const retrievalText =
        candidate.retrievalText?.trim() || candidate.chunkText.trim();
      const text = this.normalize(
        [
          candidate.title,
          candidate.description,
          candidate.tags.join(' '),
          retrievalText,
        ]
          .filter(Boolean)
          .join(' '),
      );
      const evidence = this.normalize(
        candidate.evidenceText?.trim() || candidate.chunkText,
      );
      const titleAndTags = this.normalize(
        [candidate.title, candidate.tags.join(' ')].filter(Boolean).join(' '),
      );
      const candidateTokens = this.tokenize(text);
      const exactPhraseScore =
        query.length > 0 && (text.includes(query) || evidence.includes(query))
          ? 1
          : 0;
      const weightedCoverage = this.calculateWeightedQueryCoverage(
        queryTerms,
        candidateTokens,
        idf,
      );
      const titleTagCoverage = this.calculateWeightedQueryCoverage(
        queryTerms,
        this.tokenize(titleAndTags),
        idf,
      );
      const retrievalSignal = this.calculateRetrievalSignal(candidate);

      return {
        candidate,
        relevanceScore: this.clamp(
          retrievalSignal * 0.58 +
            weightedCoverage * 0.22 +
            exactPhraseScore * 0.12 +
            titleTagCoverage * 0.08,
          0,
          1,
        ),
      };
    });
  }

  private calculateRetrievalSignal(candidate: ReelContextSearchResult): number {
    const rrf = this.normalizeRrf(candidate.score ?? 0);
    const vector = this.clamp(candidate.vectorScore ?? 0, 0, 1);
    const lexical = this.clamp(
      Math.max(candidate.keywordScore ?? 0, candidate.metadataScore ?? 0),
      0,
      1,
    );
    const hasVector = (candidate.vectorScore ?? 0) > 0;
    const hasLexical =
      (candidate.keywordScore ?? 0) > 0 || (candidate.metadataScore ?? 0) > 0;

    if (hasVector && hasLexical) {
      return this.clamp(rrf * 0.45 + vector * 0.35 + lexical * 0.2, 0, 1);
    }
    if (hasVector) {
      return this.clamp(vector * 0.78 + rrf * 0.22, 0, 1);
    }
    return this.clamp(lexical * 0.78 + rrf * 0.22, 0, 1);
  }

  private normalizeRrf(score: number): number {
    if (!Number.isFinite(score) || score <= 0) return 0;
    return this.clamp(1 - Math.exp(-30 * score), 0, 1);
  }

  private buildIdfWeights(
    candidates: ReelContextSearchResult[],
    queryTerms: Set<string>,
  ): Map<string, number> {
    const documentCount = Math.max(1, candidates.length);
    const documentFrequency = new Map<string, number>();

    for (const candidate of candidates) {
      const tokens = this.tokenize(
        [
          candidate.title,
          candidate.description,
          candidate.tags.join(' '),
          candidate.retrievalText,
          candidate.chunkText,
        ]
          .filter(Boolean)
          .join(' '),
      );
      for (const term of queryTerms) {
        if (tokens.has(term)) {
          documentFrequency.set(term, (documentFrequency.get(term) ?? 0) + 1);
        }
      }
    }

    return new Map(
      [...queryTerms].map((term) => {
        const df = documentFrequency.get(term) ?? 0;
        return [term, Math.log((documentCount + 1) / (df + 1)) + 1] as const;
      }),
    );
  }

  private calculateWeightedQueryCoverage(
    queryTerms: Set<string>,
    candidateTokens: Set<string>,
    idf: Map<string, number>,
  ): number {
    if (queryTerms.size === 0 || candidateTokens.size === 0) return 0;

    let matchedWeight = 0;
    let totalWeight = 0;
    for (const term of queryTerms) {
      const weight = idf.get(term) ?? 1;
      totalWeight += weight;
      if (candidateTokens.has(term)) matchedWeight += weight;
    }
    return totalWeight > 0 ? matchedWeight / totalWeight : 0;
  }

  private normalize(value: string): string {
    return value
      .toLowerCase()
      .replace(/[^\p{L}\p{N}\s.#_-]/gu, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  }

  private tokenize(value: string): Set<string> {
    return new Set(
      this.normalize(value)
        .split(' ')
        .map((term) => term.replace(/^#/, '').trim())
        .filter((term) => term.length >= 2),
    );
  }

  private clamp(value: number, min: number, max: number): number {
    return Math.min(Math.max(value, min), max);
  }
}
