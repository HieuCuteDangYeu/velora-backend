import type {
  IRecommendationRerankExperimentRepository,
  RecommendationRerankExposure,
} from '@content/domain/interfaces/recommendation-rerank-experiment.repository.interface';
import { PrismaService } from '@content/infrastructure/prisma/prisma.service';
import { Injectable } from '@nestjs/common';

@Injectable()
export class RecommendationRerankExperimentRepository implements IRecommendationRerankExperimentRepository {
  constructor(private readonly prisma: PrismaService) {}

  async record(exposures: RecommendationRerankExposure[]): Promise<void> {
    if (exposures.length === 0) {
      return;
    }

    // A refill retry for the same session must not overwrite or duplicate rows.
    await this.prisma.reelRerankExposure.createMany({
      data: exposures,
      skipDuplicates: true,
    });
  }
}
