import type { IRerankerService } from '@ai/domain/interfaces/reranker.service.interface';
import type { ReelContextSearchResult } from '@common/content/interfaces/reel-context-search-result.interface';
import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { EvidenceDiversitySelector } from './evidence-diversity-selector';
import type { ScoredRerankCandidate } from './hybrid-retrieval-scorer';
import { SimpleRerankerAdapter } from './simple-reranker.adapter';

interface CloudflareRerankItem {
  id?: unknown;
  index?: unknown;
  score?: unknown;
}

interface CloudflareRerankEnvelope {
  success?: boolean;
  result?: {
    response?: CloudflareRerankItem[];
  };
  response?: CloudflareRerankItem[];
  errors?: Array<{ message?: string } | string>;
}

@Injectable()
export class CloudflareCrossEncoderRerankerAdapter implements IRerankerService {
  private readonly logger = new Logger(
    CloudflareCrossEncoderRerankerAdapter.name,
  );

  constructor(
    private readonly configService: ConfigService,
    private readonly fallbackReranker: SimpleRerankerAdapter,
    private readonly diversitySelector: EvidenceDiversitySelector = new EvidenceDiversitySelector(
      configService,
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
      return await this.fallbackReranker.rerank(input);
    }

    const candidateLimit = Math.round(
      this.number('AI_RAG_NEURAL_RERANK_CANDIDATE_LIMIT', 20, 2, 50),
    );
    const candidates = input.candidates.slice(0, candidateLimit);

    try {
      const scores = await this.fetchScores(input.queryText, candidates);
      const ranked = this.diversitySelector.select(scores, input.limit);

      if (ranked.length === 0) {
        throw new Error('Cloudflare reranker returned no usable candidates');
      }

      return ranked;
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.warn(
        `[NeuralReranker] falling back to deterministic reranker: ${message}`,
      );
      return await this.fallbackReranker.rerank(input);
    }
  }

  private async fetchScores(
    queryText: string,
    candidates: ReelContextSearchResult[],
  ): Promise<ScoredRerankCandidate[]> {
    const accountId = this.configService.getOrThrow<string>(
      'CLOUDFLARE_ACCOUNT_ID',
    );
    const apiToken = this.configService.getOrThrow<string>(
      'CLOUDFLARE_API_TOKEN',
    );
    const model = this.configService.getOrThrow<string>('AI_RERANKER_MODEL');
    const timeoutMs = Math.round(
      this.number('AI_RAG_NEURAL_RERANK_TIMEOUT_MS', 5_000, 500, 30_000),
    );
    const maxInputTokens = Math.round(
      this.number('AI_RERANKER_MAX_INPUT_TOKENS', 512, 64, 512),
    );
    const query = this.truncateTokens(queryText.trim(), 128);
    const maxContextTokens = Math.max(32, maxInputTokens - 128);
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    timeout.unref();

    try {
      const response = await fetch(
        `https://api.cloudflare.com/client/v4/accounts/${accountId}/ai/run/${model}`,
        {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${apiToken}`,
            'Content-Type': 'application/json',
            'cf-aig-skip-cache': 'true',
            ...this.gatewayHeaders(),
          },
          body: JSON.stringify({
            query,
            contexts: candidates.map((candidate) => ({
              text: this.truncateTokens(
                this.buildContext(candidate),
                maxContextTokens,
              ),
            })),
            top_k: candidates.length,
          }),
          signal: controller.signal,
        },
      );

      const raw = await response.text();
      let payload: CloudflareRerankEnvelope = {};
      try {
        payload = JSON.parse(raw) as CloudflareRerankEnvelope;
      } catch {
        throw new Error('Cloudflare reranker returned invalid JSON');
      }

      if (!response.ok || payload.success === false) {
        throw new Error(
          `Cloudflare reranker request failed with status ${response.status}: ${this.errorMessage(payload, raw)}`,
        );
      }

      const items = payload.result?.response ?? payload.response ?? [];
      const scored: ScoredRerankCandidate[] = [];
      const seen = new Set<number>();

      for (const item of items) {
        const rawIndex = item.id ?? item.index;
        const index = Number(rawIndex);
        const rawScore = Number(item.score);
        if (
          !Number.isInteger(index) ||
          index < 0 ||
          index >= candidates.length ||
          seen.has(index) ||
          !Number.isFinite(rawScore)
        ) {
          continue;
        }

        seen.add(index);
        const candidate = candidates[index];
        scored.push({
          candidate,
          relevanceScore: this.sigmoid(rawScore),
        });
      }

      return scored;
    } finally {
      clearTimeout(timeout);
    }
  }

  private buildContext(candidate: ReelContextSearchResult): string {
    return [
      candidate.title,
      candidate.description,
      candidate.tags.length ? candidate.tags.join(' ') : '',
      candidate.evidenceText?.trim() ||
        candidate.retrievalText?.trim() ||
        candidate.chunkText.trim(),
    ]
      .filter(Boolean)
      .join('\n');
  }

  private truncateTokens(value: string, maxTokens: number): string {
    const tokens = value.normalize('NFKC').match(/[\p{L}\p{N}]+|[^\s]/gu) ?? [];
    return tokens.slice(0, maxTokens).join(' ');
  }

  private gatewayHeaders(): Record<string, string> {
    return this.boolean('CLOUDFLARE_AI_GATEWAY_ENABLED', true)
      ? {
          'cf-aig-gateway-id': this.configService.getOrThrow<string>(
            'CLOUDFLARE_AI_GATEWAY_ID',
          ),
        }
      : {};
  }

  private sigmoid(value: number): number {
    if (value >= 0) {
      const z = Math.exp(-value);
      return 1 / (1 + z);
    }
    const z = Math.exp(value);
    return z / (1 + z);
  }

  private errorMessage(payload: CloudflareRerankEnvelope, raw: string): string {
    const messages = (payload.errors ?? [])
      .map((error) =>
        typeof error === 'string' ? error : error.message?.trim() || '',
      )
      .filter(Boolean);
    return messages.length ? messages.join('; ') : raw.trim().slice(0, 500);
  }

  private boolean(key: string, fallback: boolean): boolean {
    const value = this.configService.get<string>(key)?.trim().toLowerCase();
    if (value === 'true') return true;
    if (value === 'false') return false;
    return fallback;
  }

  private number(
    key: string,
    fallback: number,
    min: number,
    max: number,
  ): number {
    const parsed = Number(this.configService.get<string>(key) ?? fallback);
    return Number.isFinite(parsed)
      ? Math.min(max, Math.max(min, parsed))
      : fallback;
  }
}
