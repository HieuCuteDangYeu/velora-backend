import type { IRerankerService } from '@ai/domain/interfaces/reranker.service.interface';
import type { ReelContextSearchResult } from '@common/content/interfaces/reel-context-search-result.interface';
import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { EvidenceDiversitySelector } from './evidence-diversity-selector';
import type { ScoredRerankCandidate } from './hybrid-retrieval-scorer';

interface JevNoulAnswer {
  type?: unknown;
  noul?: unknown;
}

interface JevResponse {
  answers?: Record<string, JevNoulAnswer>;
}

@Injectable()
export class JevRerankerAdapter implements IRerankerService {
  private readonly logger = new Logger(JevRerankerAdapter.name);

  constructor(
    private readonly config: ConfigService,
    private readonly fallback: IRerankerService,
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
        this.number('JEV_RERANKER_CANDIDATE_LIMIT', 20, 2, 50),
      );
      const response = await this.request(input.queryText, candidates);
      const scored = candidates.map((candidate, index) => {
        const answer = response.answers?.[`candidate_${index}`];
        const score = Number(answer?.noul);
        if (answer?.type !== 'noul' || !Number.isFinite(score)) {
          throw new Error(`Jev returned no score for candidate ${index}`);
        }
        return {
          candidate,
          relevanceScore: Math.min(Math.max(score, 0), 1),
        } satisfies ScoredRerankCandidate;
      });

      return this.diversitySelector.select(scored, limit);
    } catch (error: unknown) {
      this.logger.warn(
        `Jev reranker unavailable; using deterministic fallback: ${error instanceof Error ? error.message : String(error)}`,
      );
      return await this.fallback.rerank(input);
    }
  }

  private async request(
    queryText: string,
    candidates: ReelContextSearchResult[],
  ): Promise<JevResponse> {
    const controller = new AbortController();
    const timeoutMs = this.number(
      'JEV_RERANKER_TIMEOUT_MS',
      5_000,
      500,
      30_000,
    );
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    timer.unref();
    try {
      const response = await fetch(`${this.baseUrl()}/v1/systemone`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model:
            this.config.get<string>('JEV_RERANKER_MODEL')?.trim() ||
            'jev-latest',
          state: {
            query: this.truncate(queryText, 128),
            candidates: candidates.map((candidate, index) => ({
              index,
              text: this.truncate(
                this.context(candidate),
                this.number('JEV_RERANKER_MAX_INPUT_TOKENS', 256, 64, 512),
              ),
            })),
          },
          questions: Object.fromEntries(
            candidates.map((_candidate, index) => [
              `candidate_${index}`,
              {
                type: 'noul',
                instructions: `Does candidate ${index} directly help answer the query?`,
                criteria: {
                  true: 'The candidate directly supports the answer with relevant evidence.',
                  false:
                    'The candidate is unrelated, too general, or does not support the answer.',
                },
              },
            ]),
          ),
        }),
        signal: controller.signal,
      });
      const raw = await response.text();
      if (!response.ok) {
        throw new Error(
          `Jev reranker failed with status ${response.status}: ${raw.slice(0, 500)}`,
        );
      }
      const payload = JSON.parse(raw) as unknown;
      if (!payload || typeof payload !== 'object') {
        throw new Error('Jev reranker returned an invalid response');
      }
      return payload;
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
    const value = this.config.get<string>('JEV_RERANKER_BASE_URL')?.trim();
    if (!value) {
      throw new Error(
        'Missing required AI configuration: JEV_RERANKER_BASE_URL',
      );
    }
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
