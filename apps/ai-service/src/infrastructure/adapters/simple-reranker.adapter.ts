import type { IRerankerService } from '@ai/domain/interfaces/reranker.service.interface';
import type { ReelContextSearchResult } from '@common/content/interfaces/reel-context-search-result.interface';
import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { EvidenceDiversitySelector } from './evidence-diversity-selector';
import { HybridRetrievalScorer } from './hybrid-retrieval-scorer';

@Injectable()
export class SimpleRerankerAdapter implements IRerankerService {
  constructor(
    configService: ConfigService,
    private readonly scorer: HybridRetrievalScorer = new HybridRetrievalScorer(
      configService,
    ),
    private readonly diversitySelector: EvidenceDiversitySelector = new EvidenceDiversitySelector(
      configService,
    ),
  ) {}

  rerank(input: {
    queryText: string;
    candidates: ReelContextSearchResult[];
    limit: number;
  }): Promise<ReelContextSearchResult[]> {
    const scored = this.scorer.score(input.queryText, input.candidates);
    return Promise.resolve(this.diversitySelector.select(scored, input.limit));
  }
}
