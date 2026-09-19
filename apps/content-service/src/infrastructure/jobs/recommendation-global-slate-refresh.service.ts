import { RefreshGlobalRecommendationSlateUseCase } from '@content/application/use-cases/refresh-global-recommendation-slate.use-case';
import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { Interval } from '@nestjs/schedule';

const REFRESH_INTERVAL_MS = 5 * 60 * 1000;

@Injectable()
export class RecommendationGlobalSlateRefreshService implements OnModuleInit {
  private readonly logger = new Logger(
    RecommendationGlobalSlateRefreshService.name,
  );
  private refreshing = false;

  constructor(
    private readonly refreshGlobalRecommendationSlate: RefreshGlobalRecommendationSlateUseCase,
  ) {}

  async onModuleInit(): Promise<void> {
    await this.refresh();
  }

  @Interval(REFRESH_INTERVAL_MS)
  async refresh(): Promise<void> {
    if (this.refreshing) return;
    this.refreshing = true;

    try {
      await this.refreshGlobalRecommendationSlate.execute();
    } catch (error: unknown) {
      this.logger.warn(
        `Unable to refresh recommendation global slate: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    } finally {
      this.refreshing = false;
    }
  }
}
