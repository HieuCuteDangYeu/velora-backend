import type { IRerankerService } from '@ai/domain/interfaces/reranker.service.interface';
import type { ReelContextSearchResult } from '@common/content/interfaces/reel-context-search-result.interface';
import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { EvidenceDiversitySelector } from './evidence-diversity-selector';
import type { ScoredRerankCandidate } from './hybrid-retrieval-scorer';
import { SimpleRerankerAdapter } from './simple-reranker.adapter';

interface TeiScore {
  index?: unknown;
  score?: unknown;
}

@Injectable()
export class TeiRerankerAdapter implements IRerankerService {
  private readonly logger = new Logger(TeiRerankerAdapter.name);

  constructor(
    private readonly config: ConfigService,
    private readonly fallback: SimpleRerankerAdapter,
    private readonly diversitySelector: EvidenceDiversitySelector = new EvidenceDiversitySelector(
      config,
    ),
  ) {}

  async rerank(input: {
    queryText: string;
    candidates: ReelContextSearchResult[];
    limit: number;
  }): Promise<ReelContextSearchResult[]> {
    if (
      !this.boolean('AI_RAG_NEURAL_RERANK_ENABLED', true) ||
      input.candidates.length <= 1 ||
      !input.queryText.trim()
    ) {
      return await this.fallback.rerank(input);
    }

    try {
      const limit = Math.min(
        Math.max(Math.round(input.limit), 1),
        this.number('AI_RAG_RERANK_MAX_LIMIT', 8, 1, 20),
      );
      const candidates = input.candidates.slice(
        0,
        this.number('AI_RAG_NEURAL_RERANK_CANDIDATE_LIMIT', 20, 2, 50),
      );
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
          )
            return null;
          seen.add(index);
          return {
            candidate: candidates[index],
            relevanceScore: score,
          } satisfies ScoredRerankCandidate;
        })
        .filter((item): item is ScoredRerankCandidate => Boolean(item));
      if (!scored.length)
        throw new Error('TEI reranker returned no usable candidates');
      return this.diversitySelector.select(scored, limit);
    } catch (error: unknown) {
      this.logger.warn(
        `TEI reranker unavailable; using deterministic fallback: ${error instanceof Error ? error.message : String(error)}`,
      );
      return await this.fallback.rerank(input);
    }
  }

  private async request(
    queryText: string,
    candidates: ReelContextSearchResult[],
  ): Promise<TeiScore[]> {
    const controller = new AbortController();
    const timeoutMs = this.number(
      'AI_RAG_NEURAL_RERANK_TIMEOUT_MS',
      5_000,
      500,
      30_000,
    );
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    timer.unref();
    try {
      const response = await fetch(`${this.baseUrl()}/rerank`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          query: this.truncate(queryText, 128),
          texts: candidates.map((candidate) =>
            this.truncate(
              this.context(candidate),
              this.number('AI_RERANKER_MAX_INPUT_TOKENS', 512, 64, 512),
            ),
          ),
          return_text: false,
        }),
        signal: controller.signal,
      });
      const raw = await response.text();
      if (!response.ok)
        throw new Error(
          `TEI reranker failed with status ${response.status}: ${raw.slice(0, 500)}`,
        );
      const payload = JSON.parse(raw) as unknown;
      if (!Array.isArray(payload))
        throw new Error('TEI reranker returned an invalid response');
      return payload as TeiScore[];
    } finally {
      clearTimeout(timer);
    }
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
    if (!value)
      throw new Error(
        'Missing required AI configuration: TEI_RERANKER_BASE_URL',
      );
    return value.replace(/\/+$/, '');
  }

  private boolean(key: string, fallback: boolean): boolean {
    const value = this.config.get<string>(key)?.trim().toLowerCase();
    return value === 'true' ? true : value === 'false' ? false : fallback;
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
