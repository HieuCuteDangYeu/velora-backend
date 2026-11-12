import type { ITextRelevanceScorer } from '@ai/domain/interfaces/text-relevance-scorer.interface';
import type {
  RerankTextsRequest,
  RerankTextsResult,
} from '@common/ai/interfaces/rerank-texts.interface';
import { Inject, Injectable } from '@nestjs/common';

@Injectable()
export class ScoreTextRelevanceUseCase {
  constructor(
    @Inject('ITextRelevanceScorer')
    private readonly scorer: ITextRelevanceScorer,
  ) {}

  async execute(input: RerankTextsRequest): Promise<RerankTextsResult> {
    return { scores: await this.scorer.scoreTexts(input) };
  }
}
