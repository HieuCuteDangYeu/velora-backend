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
  persist(input: IndexQualityReviewPersistenceInput): Promise<void>;
}
