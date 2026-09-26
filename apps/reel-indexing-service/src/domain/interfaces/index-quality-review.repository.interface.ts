import type { IndexQualityReviewResult } from '@indexing/domain/interfaces/ai-service.interface';

export interface IndexQualityReviewPersistenceInput {
  reelId: string;
  indexAttemptId: string;
  indexVersion: string;
  embeddingProvider: string;
  embeddingModel: string;
  embeddingDimensions: number;
  embeddingVersion: string;
  reviewProvider: string;
  reviewModel: string;
  reviewVersion: string;
  review: IndexQualityReviewResult;
}

export interface IIndexQualityReviewRepository {
  findByAttempt(input: {
    reelId: string;
    indexAttemptId: string;
  }): Promise<IndexQualityReviewPersistenceInput['review'] | null>;
  persist(
    input: IndexQualityReviewPersistenceInput,
  ): Promise<IndexQualityReviewPersistenceInput['review']>;
}
