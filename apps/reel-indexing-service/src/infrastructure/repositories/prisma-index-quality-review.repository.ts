import { Prisma } from '@prisma/reel-indexing-client';
import { Injectable } from '@nestjs/common';
import { PrismaService } from '@indexing/infrastructure/prisma/prisma.service';
import type {
  IIndexQualityReviewRepository,
  IndexQualityReviewPersistenceInput,
} from '@indexing/domain/interfaces/index-quality-review.repository.interface';

@Injectable()
export class PrismaIndexQualityReviewRepository implements IIndexQualityReviewRepository {
  constructor(private readonly prisma: PrismaService) {}

  async findByAttempt(input: {
    reelId: string;
    indexAttemptId: string;
  }): Promise<IndexQualityReviewPersistenceInput['review'] | null> {
    const existing = await this.findExisting(input);
    return existing ? this.toReview(existing) : null;
  }

  async persist(
    input: IndexQualityReviewPersistenceInput,
  ): Promise<IndexQualityReviewPersistenceInput['review']> {
    const existing = await this.findExisting(input);
    if (existing) return this.toReview(existing);

    try {
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
          issues: input.review.issues as Prisma.InputJsonValue,
          reviewProvider: input.reviewProvider,
          reviewModel: input.reviewModel,
          reviewVersion: input.reviewVersion,
        },
      });
      return input.review;
    } catch (error: unknown) {
      if (
        !(error instanceof Prisma.PrismaClientKnownRequestError) ||
        error.code !== 'P2002'
      ) {
        throw error;
      }
      const raced = await this.findExisting(input);
      if (!raced) throw error;
      return this.toReview(raced);
    }
  }

  private async findExisting(input: {
    reelId: string;
    indexAttemptId: string;
  }) {
    return await this.prisma.reelIndexQualityReview.findUnique({
      where: {
        reelId_indexAttemptId: {
          reelId: input.reelId,
          indexAttemptId: input.indexAttemptId,
        },
      },
    });
  }

  private toReview(existing: {
    acceptable: boolean;
    confidence: number;
    summary: string;
    issues: unknown;
  }): IndexQualityReviewPersistenceInput['review'] {
    return {
      acceptable: existing.acceptable,
      confidence: existing.confidence,
      summary: existing.summary,
      issues:
        existing.issues as IndexQualityReviewPersistenceInput['review']['issues'],
    };
  }
}
