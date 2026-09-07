import { PrismaIndexQualityReviewRepository } from './prisma-index-quality-review.repository';

const input = {
  reelId: 'reel-1',
  indexAttemptId: 'attempt-1',
  indexVersion: 'index-v1',
  embeddingProvider: 'tei',
  embeddingModel: 'BAAI/bge-m3',
  embeddingDimensions: 1024,
  embeddingVersion: 'embedding-v1',
  reviewProvider: 'groq',
  reviewModel: 'openai/gpt-oss-20b',
  reviewVersion: 'index-quality-review-v1',
  review: {
    acceptable: true,
    confidence: 0.94,
    summary: 'The persisted index is coherent.',
    issues: [],
  },
};

const existing = {
  id: 'review-1',
  reelId: input.reelId,
  indexAttemptId: input.indexAttemptId,
  indexVersion: input.indexVersion,
  embeddingProvider: input.embeddingProvider,
  embeddingModel: input.embeddingModel,
  embeddingDimensions: input.embeddingDimensions,
  embeddingVersion: input.embeddingVersion,
  acceptable: input.review.acceptable,
  confidence: input.review.confidence,
  summary: input.review.summary,
  issues: input.review.issues,
  reviewProvider: input.reviewProvider,
  reviewModel: input.reviewModel,
  reviewVersion: input.reviewVersion,
};

describe('PrismaIndexQualityReviewRepository', () => {
  it('creates a review with embedding and reviewer provenance', async () => {
    const prisma = {
      reelIndexQualityReview: {
        findUnique: jest.fn().mockResolvedValue(null),
        create: jest.fn().mockResolvedValue(existing),
      },
    };
    const repository = new PrismaIndexQualityReviewRepository(prisma as never);

    await repository.persist(input);

    expect(prisma.reelIndexQualityReview.create).toHaveBeenCalledWith({
      data: {
        reelId: input.reelId,
        indexAttemptId: input.indexAttemptId,
        indexVersion: input.indexVersion,
        embeddingProvider: input.embeddingProvider,
        embeddingModel: input.embeddingModel,
        embeddingDimensions: input.embeddingDimensions,
        embeddingVersion: input.embeddingVersion,
        acceptable: input.review.acceptable,
        confidence: input.review.confidence,
        summary: input.review.summary,
        issues: input.review.issues,
        reviewProvider: input.reviewProvider,
        reviewModel: input.reviewModel,
        reviewVersion: input.reviewVersion,
      },
    });
  });

  it('treats an exact replay as an idempotent no-op', async () => {
    const prisma = {
      reelIndexQualityReview: {
        findUnique: jest.fn().mockResolvedValue(existing),
        create: jest.fn(),
      },
    };
    const repository = new PrismaIndexQualityReviewRepository(prisma as never);

    await repository.persist(input);

    expect(prisma.reelIndexQualityReview.create).not.toHaveBeenCalled();
  });

  it('rejects a conflicting review for the same reel and indexing attempt', async () => {
    const prisma = {
      reelIndexQualityReview: {
        findUnique: jest.fn().mockResolvedValue({
          ...existing,
          acceptable: false,
        }),
        create: jest.fn(),
      },
    };
    const repository = new PrismaIndexQualityReviewRepository(prisma as never);

    await expect(repository.persist(input)).rejects.toThrow(
      'Conflicting index quality review already exists',
    );
    expect(prisma.reelIndexQualityReview.create).not.toHaveBeenCalled();
  });
});
