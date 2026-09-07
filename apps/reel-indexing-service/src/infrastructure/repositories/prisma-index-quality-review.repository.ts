import type { Prisma } from '@prisma/reel-indexing-client';
import { Injectable } from '@nestjs/common';
import { PrismaService } from '@indexing/infrastructure/prisma/prisma.service';
import type {
  IIndexQualityReviewRepository,
  IndexQualityReviewPersistenceInput,
} from '@indexing/domain/interfaces/index-quality-review.repository.interface';

@Injectable()
export class PrismaIndexQualityReviewRepository implements IIndexQualityReviewRepository {
  constructor(private readonly prisma: PrismaService) {}

  async persist(input: IndexQualityReviewPersistenceInput): Promise<void> {
    const existing = await this.prisma.reelIndexQualityReview.findUnique({
      where: {
        reelId_indexAttemptId: {
          reelId: input.reelId,
          indexAttemptId: input.indexAttemptId,
        },
      },
    });

    const issues = input.review.issues as Prisma.InputJsonValue;
    if (existing) {
      const same =
        existing.indexVersion === input.indexVersion &&
        existing.embeddingProvider === input.embeddingProvider &&
        existing.embeddingModel === input.embeddingModel &&
        existing.embeddingDimensions === input.embeddingDimensions &&
        existing.embeddingVersion === input.embeddingVersion &&
        existing.acceptable === input.review.acceptable &&
        existing.confidence === input.review.confidence &&
        existing.summary === input.review.summary &&
        existing.reviewProvider === input.reviewProvider &&
        existing.reviewModel === input.reviewModel &&
        existing.reviewVersion === input.reviewVersion &&
        JSON.stringify(existing.issues) === JSON.stringify(issues);
      if (same) return;
      throw new Error(
        `Conflicting index quality review already exists for ${input.indexAttemptId}`,
      );
    }

    await this.prisma.reelIndexQualityReview.create({
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
        issues,
        reviewProvider: input.reviewProvider,
        reviewModel: input.reviewModel,
        reviewVersion: input.reviewVersion,
      },
    });
  }
}
