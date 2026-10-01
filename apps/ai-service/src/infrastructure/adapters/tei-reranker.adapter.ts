import type { IRerankerService } from '@ai/domain/interfaces/reranker.service.interface';
import type { ReelContextSearchResult } from '@common/content/interfaces/reel-context-search-result.interface';
import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  EvidenceDiversitySelector,
  type ScoredRerankCandidate,
} from './evidence-diversity-selector';

interface TeiScore {
  index?: unknown;
  score?: unknown;
}

@Injectable()
export class TeiRerankerAdapter implements IRerankerService {
  constructor(
    private readonly config: ConfigService,
    private readonly diversitySelector: EvidenceDiversitySelector = new EvidenceDiversitySelector(
      config,
    ),
  ) {}

  async rerank(input: {
    queryText: string;
    candidates: ReelContextSearchResult[];
    limit: number;
  }): Promise<ReelContextSearchResult[]> {
    if (input.candidates.length <= 1 || !input.queryText.trim()) {
      return input.candidates.slice(0, Math.max(Math.round(input.limit), 1));
    }

    const limit = Math.min(
      Math.max(Math.round(input.limit), 1),
      this.number('AI_RAG_RERANK_MAX_LIMIT', 8, 1, 20),
    );
    const candidates = this.boundCandidates(input.candidates);
    const response = await this.request(input.queryText, candidates);
    const seen = new Set<number>();
    const scored = response
      .map((item) => {
        const index = Number(item.index);
        const score = Number(item.score);
        if (
          !Number.isInteger(index) ||
          index < 0 ||
          index >= candidates.length ||
          seen.has(index) ||
          !Number.isFinite(score)
        ) {
          return null;
        }
        seen.add(index);
        return {
          candidate: candidates[index],
          relevanceScore: score,
        } satisfies ScoredRerankCandidate;
      })
      .filter((item): item is ScoredRerankCandidate => Boolean(item));

    if (!scored.length) {
      throw new Error('TEI reranker returned no usable candidates');
    }
    return this.diversitySelector.select(scored, limit);
  }

  private async request(
    queryText: string,
    candidates: ReelContextSearchResult[],
  ): Promise<TeiScore[]> {
    const timeoutMs = this.number(
      'AI_RAG_NEURAL_RERANK_TIMEOUT_MS',
      5_000,
      500,
      30_000,
    );
    const maxRetries = this.number('AI_RAG_NEURAL_RERANK_MAX_RETRIES', 2, 0, 5);

    for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
      if (attempt > 0) {
        await new Promise((resolve) => setTimeout(resolve, attempt * 150));
      }
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      timer.unref();
      try {
        const requestBody = this.payload(queryText, candidates);
        const response = await fetch(`${this.baseUrl()}/rerank`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(requestBody),
          signal: controller.signal,
        });
        const raw = await response.text();
        if (!response.ok) {
          const isTransientOverload =
            response.status === 429 || response.status === 503;
          if (isTransientOverload && attempt < maxRetries) {
            continue;
          }
          throw new Error(
            `TEI reranker failed with status ${response.status}: ${raw.slice(0, 500)}`,
          );
        }
        const responsePayload = JSON.parse(raw) as unknown;
        if (!Array.isArray(responsePayload)) {
          throw new Error('TEI reranker returned an invalid response');
        }
        return responsePayload as TeiScore[];
      } finally {
        clearTimeout(timer);
      }
    }
    throw new Error('TEI reranker request failed');
  }

  private boundCandidates(
    candidates: ReelContextSearchResult[],
  ): ReelContextSearchResult[] {
    const configuredLimit = this.number(
      'AI_RAG_NEURAL_RERANK_CANDIDATE_LIMIT',
      8,
      2,
      50,
    );
    const safeBatchTokens = this.safeBatchTokens();
    const queryTokens = this.queryTokenBudget(safeBatchTokens);
    const maxCandidatesByBudget = Math.max(
      2,
      Math.floor((safeBatchTokens - queryTokens) / 128),
    );
    return candidates.slice(
      0,
      Math.min(configuredLimit, maxCandidatesByBudget),
    );
  }

  private payload(
    queryText: string,
    candidates: ReelContextSearchResult[],
  ): { query: string; texts: string[]; return_text: false } {
    const safeBatchTokens = this.safeBatchTokens();
    const queryTokens = this.queryTokenBudget(safeBatchTokens);
    const candidateTokens = Math.max(
      64,
      Math.floor(
        (safeBatchTokens - queryTokens) / Math.max(candidates.length, 1),
      ),
    );
    const maxInputTokens = Math.min(
      this.number('AI_RERANKER_MAX_INPUT_TOKENS', 512, 64, 512),
      candidateTokens,
    );
    return {
      query: this.truncate(queryText, queryTokens),
      texts: candidates.map((candidate) =>
        this.truncate(this.context(candidate), maxInputTokens),
      ),
      return_text: false,
    };
  }

  private safeBatchTokens(): number {
    // Keep tokenizer/special-token headroom; TEI reports over-budget requests as 429 overloaded.
    return Math.max(
      256,
      Math.floor(
        this.number('TEI_RERANKER_MAX_BATCH_TOKENS', 1024, 512, 131_072) * 0.8,
      ),
    );
  }

  private queryTokenBudget(safeBatchTokens: number): number {
    return Math.max(64, Math.min(128, Math.floor(safeBatchTokens / 4)));
  }

  private context(candidate: ReelContextSearchResult): string {
    return [
      candidate.title,
      candidate.description,
      candidate.tags.join(' '),
      candidate.evidenceText?.trim() ||
        candidate.retrievalText?.trim() ||
        candidate.chunkText.trim(),
    ]
      .filter(Boolean)
      .join('\n');
  }

  private truncate(value: string, maxTokens: number): string {
    const tokens = value.normalize('NFKC').match(/[\p{L}\p{N}]+|[^\s]/gu) ?? [];
    return tokens.slice(0, maxTokens).join(' ');
  }

  private baseUrl(): string {
    const value = this.config.get<string>('TEI_RERANKER_BASE_URL')?.trim();
    if (!value) {
      throw new Error(
        'Missing required AI configuration: TEI_RERANKER_BASE_URL',
      );
    }
    return value.replace(/\/+$/, '');
  }

  private number(
    key: string,
    fallback: number,
    min: number,
    max: number,
  ): number {
    const value = Number(this.config.get<string>(key) ?? fallback);
    return Number.isFinite(value)
      ? Math.min(max, Math.max(min, value))
      : fallback;
  }
}
