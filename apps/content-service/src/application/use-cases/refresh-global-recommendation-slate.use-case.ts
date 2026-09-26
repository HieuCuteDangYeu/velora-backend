import type { Reel } from '@content/domain/entities/reel.entity';
import type {
  IRecommendationFeedCacheRepository,
  RecommendationGlobalSlate,
} from '@content/domain/interfaces/recommendation-feed-cache.repository.interface';
import type {
  RecommendationCandidateEvidence,
  RecommendationCandidateQuery,
  RecommendationCandidateSource,
} from '@content/domain/interfaces/recommendation.interface';
import type { IRecommendationRepository } from '@content/domain/interfaces/recommendation.repository.interface';
import { Inject, Injectable } from '@nestjs/common';

const GLOBAL_SLATE_SIZE = 100;
const GLOBAL_SLATE_TTL_SECONDS = 10 * 60;
const REEL_ENTITY_TTL_SECONDS = 3 * 60 * 60;

@Injectable()
export class RefreshGlobalRecommendationSlateUseCase {
  constructor(
    @Inject('IRecommendationRepository')
    private readonly recommendationRepository: IRecommendationRepository,
    @Inject('IRecommendationFeedCacheRepository')
    private readonly feedCacheRepository: IRecommendationFeedCacheRepository,
  ) {}

  async execute(): Promise<RecommendationGlobalSlate> {
    const query: RecommendationCandidateQuery = {
      viewerId: '__global_recommendation_slate__',
      limit: GLOBAL_SLATE_SIZE,
      excludedUserIds: [],
      friendUserIds: [],
    };
    const settled = await Promise.allSettled([
      this.recommendationRepository.findRecentQualityCandidates(query),
      this.recommendationRepository.findTrendingCandidates(query),
    ]);
    const fulfilled = settled.filter(
      (
        result,
      ): result is PromiseFulfilledResult<RecommendationCandidateEvidence[]> =>
        result.status === 'fulfilled',
    );

    if (fulfilled.length === 0) {
      throw new Error('Unable to build global recommendation slate');
    }

    const merged = this.mergeCandidates(
      fulfilled.flatMap((result) => result.value),
    );
    const reels = await this.recommendationRepository.findEligibleReelsByIds(
      merged.map((item) => item.reelId),
      [],
    );
    const reelById = new Map(reels.map((reel) => [reel.id, reel]));
    const eligibleIds = new Set(reels.map((reel) => reel.id));
    const slate: RecommendationGlobalSlate = {
      generatedAt: new Date().toISOString(),
      items: this.diversifyBySeries(
        merged.filter((item) => eligibleIds.has(item.reelId)),
        reelById,
      )
        .slice(0, GLOBAL_SLATE_SIZE)
        .map(({ reelId, primarySource, sources }) => ({
          reelId,
          primarySource,
          sources,
        })),
    };

    await Promise.all([
      this.feedCacheRepository.saveReels(reels, REEL_ENTITY_TTL_SECONDS),
      this.feedCacheRepository.saveGlobalSlate(slate, GLOBAL_SLATE_TTL_SECONDS),
    ]);

    return slate;
  }

  private mergeCandidates(candidates: RecommendationCandidateEvidence[]) {
    const byReelId = new Map<
      string,
      Partial<Record<RecommendationCandidateSource, number>>
    >();

    for (const candidate of candidates) {
      const scores = byReelId.get(candidate.reelId) ?? {};
      scores[candidate.source] = Math.max(
        scores[candidate.source] ?? 0,
        this.clamp(candidate.sourceScore),
      );
      byReelId.set(candidate.reelId, scores);
    }

    return [...byReelId.entries()]
      .map(([reelId, scores]) => {
        const rankedSources = Object.entries(scores) as Array<
          [RecommendationCandidateSource, number]
        >;
        rankedSources.sort((left, right) => right[1] - left[1]);
        const sources = rankedSources.map(([source]) => source);
        const score =
          (rankedSources[0]?.[1] ?? 0) +
          rankedSources
            .slice(1)
            .reduce((sum, [, supporting]) => sum + supporting * 0.04, 0);

        return {
          reelId,
          primarySource: sources[0] ?? ('RECENT_QUALITY' as const),
          sources,
          score,
        };
      })
      .sort(
        (left, right) =>
          right.score - left.score || left.reelId.localeCompare(right.reelId),
      );
  }

  private diversifyBySeries<T extends { reelId: string }>(
    items: T[],
    reelById: Map<string, Reel>,
  ): T[] {
    const queues = new Map<string, T[]>();

    for (const item of items) {
      const seriesId = reelById.get(item.reelId)?.series?.id;
      const key = seriesId ?? item.reelId;
      const queue = queues.get(key) ?? [];
      queue.push(item);
      queues.set(key, queue);
    }

    const diversified: T[] = [];
    for (let round = 0; diversified.length < items.length; round += 1) {
      let added = false;
      for (const queue of queues.values()) {
        if (round < queue.length) {
          diversified.push(queue[round]);
          added = true;
        }
      }
      if (!added) break;
    }

    return diversified;
  }

  private clamp(value: number): number {
    if (!Number.isFinite(value)) return 0;
    return Math.min(1, Math.max(0, value));
  }
}
