import type {
  RerankTextsRequest,
  RerankTextsResult,
} from '@common/ai/interfaces/rerank-texts.interface';
import type {
  IRecommendationRerankerService,
  RecommendationRerankSettings,
} from '@content/domain/interfaces/recommendation-reranker.service.interface';
import { Inject, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ClientProxy } from '@nestjs/microservices';
import { firstValueFrom, timeout } from 'rxjs';

@Injectable()
export class AiRecommendationRerankerAdapter implements IRecommendationRerankerService {
  private readonly logger = new Logger(AiRecommendationRerankerAdapter.name);
  private readonly settings: RecommendationRerankSettings;

  constructor(
    @Inject('AI_SERVICE_RMQ')
    private readonly aiClient: ClientProxy,
    configService: ConfigService,
  ) {
    this.settings = {
      enabled: this.readBoolean(configService, 'REEL_NEURAL_RERANK_ENABLED'),
      topK: this.readNumber(
        configService,
        'REEL_NEURAL_RERANK_TOP_K',
        20,
        2,
        50,
      ),
      weight: this.readNumber(
        configService,
        'REEL_NEURAL_RERANK_WEIGHT',
        0.15,
        0,
        0.5,
      ),
      timeoutMs: this.readNumber(
        configService,
        'REEL_NEURAL_RERANK_TIMEOUT_MS',
        3_000,
        500,
        10_000,
      ),
      experimentEnabled: this.readBoolean(
        configService,
        'REEL_NEURAL_RERANK_EXPERIMENT_ENABLED',
      ),
      treatmentPercent: this.readNumber(
        configService,
        'REEL_NEURAL_RERANK_EXPERIMENT_TREATMENT_PERCENT',
        50,
        0,
        100,
      ),
    };
  }

  getSettings(): RecommendationRerankSettings {
    return this.settings;
  }

  async scoreDocuments(input: {
    queryText: string;
    documents: string[];
  }): Promise<number[] | null> {
    const request: RerankTextsRequest = {
      queryText: input.queryText,
      texts: input.documents,
      // Leaves room for the in-flight TEI call to finish inside the RPC timeout.
      budgetMs: Math.floor(this.settings.timeoutMs * 0.8),
    };

    try {
      const result = await firstValueFrom(
        this.aiClient
          .send<RerankTextsResult>('ai.rerank_texts', request)
          .pipe(timeout(this.settings.timeoutMs)),
      );
      const scores = result?.scores;

      if (
        !Array.isArray(scores) ||
        scores.length !== input.documents.length ||
        scores.some((score) => !Number.isFinite(score))
      ) {
        throw new Error('rerank response did not match the request');
      }

      return scores;
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.warn(
        `Neural rerank unavailable: ${message}. Keeping the feature-ranked order.`,
      );
      return null;
    }
  }

  private readBoolean(config: ConfigService, key: string): boolean {
    const value = config.get<string>(key)?.trim().toLowerCase();

    return value === 'true' || value === '1';
  }

  private readNumber(
    config: ConfigService,
    key: string,
    fallback: number,
    min: number,
    max: number,
  ): number {
    const value = Number(config.get<string>(key) ?? fallback);

    return Number.isFinite(value)
      ? Math.min(max, Math.max(min, value))
      : fallback;
  }
}
