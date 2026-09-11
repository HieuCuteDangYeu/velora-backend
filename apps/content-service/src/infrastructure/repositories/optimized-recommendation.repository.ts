import type {
  RecommendationCandidateEvidence,
  RecommendationCandidateQuery,
  RecommendationRankingRequest,
  RecommendationRankingSnapshot,
  RecommendationReelEngagement,
} from '@content/domain/interfaces/recommendation.interface';
import { PrismaService } from '@content/infrastructure/prisma/prisma.service';
import { RecommendationRepository } from '@content/infrastructure/repositories/recommendation.repository';
import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/content-client';

type EngagementAggregateRow = {
  reelId: string;
  impressionCount: number | bigint;
  completionCount: number | bigint;
  replayCount: number | bigint;
  skipCount: number | bigint;
  averagePercentageWatched: number;
};

type TrendingAggregateRow = {
  reelId: string;
  score: number;
};

@Injectable()
export class OptimizedRecommendationRepository extends RecommendationRepository {
  constructor(private readonly recommendationPrisma: PrismaService) {
    super(recommendationPrisma);
  }

  override async findTrendingCandidates(
    query: RecommendationCandidateQuery,
  ): Promise<RecommendationCandidateEvidence[]> {
    const since = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
    const excludedUsers = query.excludedUserIds;
    const excludedUsersFilter = excludedUsers.length
      ? Prisma.sql`AND r."userId" NOT IN (${Prisma.join(excludedUsers)})`
      : Prisma.empty;
    const cursorFilter = query.cursor
      ? Prisma.sql`AND (
          r."createdAt" < ${query.cursor.createdAt}
          OR (r."createdAt" = ${query.cursor.createdAt} AND r."id" > ${query.cursor.id})
        )`
      : Prisma.empty;

    const rows = await this.recommendationPrisma.$queryRaw<
      TrendingAggregateRow[]
    >(Prisma.sql`
      WITH scored AS (
        SELECT
          e."reelId",
          SUM(
            CASE e."eventType"::text
              WHEN 'IMPRESSION' THEN 0.03
              WHEN 'WATCH_START' THEN 0.08
              WHEN 'WATCH_PROGRESS' THEN LEAST(COALESCE(e."percentageWatched", 0) / 250.0, 0.4)
              WHEN 'WATCH_END' THEN LEAST(COALESCE(e."percentageWatched", 0) / 100.0, 1.0)
              WHEN 'COMPLETE' THEN 1.5
              WHEN 'REPLAY' THEN 2.0
              WHEN 'SKIP' THEN -1.1
              ELSE 0
            END
            + CASE WHEN e."completed" THEN 1.0 ELSE 0 END
            + CASE WHEN e."replayed" THEN 1.2 ELSE 0 END
            - CASE WHEN e."skipped" THEN 0.8 ELSE 0 END
            + LEAST(e."watchMs" / 120000.0, 0.5)
          )::double precision AS score
        FROM "ReelViewEvent" e
        WHERE e."occurredAt" >= ${since}
          AND (
            e."eventType"::text IN (
              'IMPRESSION', 'WATCH_START', 'WATCH_PROGRESS', 'WATCH_END',
              'SKIP', 'COMPLETE', 'REPLAY'
            )
            OR e."completed" = true
            OR e."replayed" = true
            OR e."skipped" = true
          )
        GROUP BY e."reelId"
      )
      SELECT scored."reelId", scored.score
      FROM scored
      INNER JOIN "Reel" r ON r."id" = scored."reelId"
      WHERE scored.score > 0
        AND r."mediaStatus"::text = 'COMPLETED'
        AND r."visibility"::text = 'public'
        ${excludedUsersFilter}
        ${cursorFilter}
      ORDER BY scored.score DESC, scored."reelId" ASC
      LIMIT ${Math.max(1, query.limit)}
    `);

    if (rows.length === 0) {
      return [];
    }

    const maximum = Math.max(
      1,
      ...rows.map((row) => this.toFiniteNumber(row.score)),
    );

    return rows.map((row) => ({
      reelId: row.reelId,
      source: 'TRENDING' as const,
      sourceScore: this.clampValue(this.toFiniteNumber(row.score) / maximum),
      reasons: ['strong recent watch and completion signals'],
    }));
  }

  override async loadRankingSnapshot(
    request: RecommendationRankingRequest,
  ): Promise<RecommendationRankingSnapshot> {
    if (request.reelIds.length === 0) {
      return this.emptyRankingSnapshot();
    }

    const now = Date.now();
    const longTermSince = new Date(now - 60 * 24 * 60 * 60 * 1000);
    const engagementSince = new Date(now - 7 * 24 * 60 * 60 * 1000);
    const fatigueSince = new Date(now - 3 * 24 * 60 * 60 * 1000);

    const [
      positiveEvents,
      sessionEvents,
      engagementByReelId,
      fatigueEvents,
      recentlySeenEvents,
    ] = await Promise.all([
      this.recommendationPrisma.reelViewEvent.findMany({
        where: {
          userId: request.viewerId,
          occurredAt: { gte: longTermSince },
          OR: [
            { eventType: { in: ['WATCH_END', 'COMPLETE', 'REPLAY'] } },
            { completed: true },
            { replayed: true },
            { percentageWatched: { gte: 70 } },
          ],
        },
        orderBy: { occurredAt: 'desc' },
        take: 1_000,
        select: {
          eventType: true,
          percentageWatched: true,
          completed: true,
          replayed: true,
          skipped: true,
          reel: { select: { userId: true, tags: true } },
        },
      }),
      this.recommendationPrisma.reelViewEvent.findMany({
        where: {
          userId: request.viewerId,
          feedSessionId: request.feedSessionId,
        },
        orderBy: { occurredAt: 'asc' },
        take: 1_000,
        select: {
          eventType: true,
          percentageWatched: true,
          completed: true,
          replayed: true,
          skipped: true,
          reel: { select: { userId: true, tags: true } },
        },
      }),
      this.loadEngagementAggregates(request.reelIds, engagementSince),
      this.recommendationPrisma.reelViewEvent.findMany({
        where: {
          userId: request.viewerId,
          occurredAt: { gte: fatigueSince },
          eventType: { in: ['IMPRESSION', 'WATCH_START'] },
        },
        orderBy: { occurredAt: 'desc' },
        take: 1_000,
        select: { reel: { select: { userId: true, tags: true } } },
      }),
      this.recommendationPrisma.reelViewEvent.findMany({
        where: {
          userId: request.viewerId,
          reelId: { in: request.reelIds },
          occurredAt: { gte: fatigueSince },
          eventType: {
            in: [
              'IMPRESSION',
              'WATCH_START',
              'WATCH_PROGRESS',
              'WATCH_END',
              'COMPLETE',
              'REPLAY',
              'SKIP',
            ],
          },
        },
        distinct: ['reelId'],
        select: { reelId: true },
      }),
    ]);

    const tagAffinity = new Map<string, number>();
    const creatorAffinity = new Map<string, number>();

    for (const event of positiveEvents) {
      const reel = event.reel;
      if (!reel) continue;

      const weight = this.positiveSignalWeight(event);
      if (weight <= 0) continue;

      creatorAffinity.set(
        reel.userId,
        (creatorAffinity.get(reel.userId) ?? 0) + weight,
      );
      for (const rawTag of reel.tags) {
        const tag = this.normalizeSignalTag(rawTag);
        if (tag) {
          tagAffinity.set(tag, (tagAffinity.get(tag) ?? 0) + weight);
        }
      }
    }

    const sessionTagIntent = new Map<string, number>();
    const sessionCreatorIntent = new Map<string, number>();

    for (const event of sessionEvents) {
      const reel = event.reel;
      if (!reel) continue;

      const weight = this.sessionSignalWeight(event);
      if (weight === 0) continue;

      sessionCreatorIntent.set(
        reel.userId,
        (sessionCreatorIntent.get(reel.userId) ?? 0) + weight,
      );
      for (const rawTag of reel.tags) {
        const tag = this.normalizeSignalTag(rawTag);
        if (tag) {
          sessionTagIntent.set(tag, (sessionTagIntent.get(tag) ?? 0) + weight);
        }
      }
    }

    const creatorImpressions = new Map<string, number>();
    const tagImpressions = new Map<string, number>();

    for (const event of fatigueEvents) {
      const reel = event.reel;
      if (!reel) continue;

      creatorImpressions.set(
        reel.userId,
        (creatorImpressions.get(reel.userId) ?? 0) + 1,
      );
      for (const rawTag of reel.tags) {
        const tag = this.normalizeSignalTag(rawTag);
        if (tag) {
          tagImpressions.set(tag, (tagImpressions.get(tag) ?? 0) + 1);
        }
      }
    }

    return {
      tagAffinityByTag: this.normalizePositiveMap(tagAffinity),
      creatorAffinityByCreatorId: this.normalizePositiveMap(creatorAffinity),
      sessionTagIntentByTag: this.normalizeIntentMap(sessionTagIntent),
      sessionCreatorIntentByCreatorId:
        this.normalizeIntentMap(sessionCreatorIntent),
      recentCreatorImpressionsByCreatorId:
        Object.fromEntries(creatorImpressions),
      recentTagImpressionsByTag: Object.fromEntries(tagImpressions),
      recentlySeenReelIds: recentlySeenEvents.map((event) => event.reelId),
      engagementByReelId,
    };
  }

  private async loadEngagementAggregates(
    reelIds: string[],
    since: Date,
  ): Promise<Record<string, RecommendationReelEngagement>> {
    const uniqueReelIds = [...new Set(reelIds)];
    const rows = await this.recommendationPrisma.$queryRaw<
      EngagementAggregateRow[]
    >(Prisma.sql`
      SELECT
        e."reelId",
        COUNT(*) FILTER (
          WHERE e."eventType"::text IN ('IMPRESSION', 'WATCH_START')
        )::int AS "impressionCount",
        COUNT(*) FILTER (
          WHERE e."eventType"::text = 'COMPLETE' OR e."completed" = true
        )::int AS "completionCount",
        COUNT(*) FILTER (
          WHERE e."eventType"::text = 'REPLAY' OR e."replayed" = true
        )::int AS "replayCount",
        COUNT(*) FILTER (
          WHERE e."eventType"::text = 'SKIP' OR e."skipped" = true
        )::int AS "skipCount",
        COALESCE(AVG(e."percentageWatched") FILTER (
          WHERE e."percentageWatched" IS NOT NULL
        ), 0)::double precision AS "averagePercentageWatched"
      FROM "ReelViewEvent" e
      WHERE e."reelId" IN (${Prisma.join(uniqueReelIds)})
        AND e."occurredAt" >= ${since}
      GROUP BY e."reelId"
    `);

    const aggregateByReelId = new Map(rows.map((row) => [row.reelId, row]));
    const result: Record<string, RecommendationReelEngagement> = {};

    for (const reelId of uniqueReelIds) {
      const aggregate = aggregateByReelId.get(reelId);
      const impressionCount = this.toFiniteNumber(
        aggregate?.impressionCount ?? 0,
      );
      const completionCount = this.toFiniteNumber(
        aggregate?.completionCount ?? 0,
      );
      const replayCount = this.toFiniteNumber(aggregate?.replayCount ?? 0);
      const skipCount = this.toFiniteNumber(aggregate?.skipCount ?? 0);
      const averagePercentageWatched = this.toFiniteNumber(
        aggregate?.averagePercentageWatched ?? 0,
      );
      const denominator = Math.max(1, impressionCount);
      const completionRate = this.clampValue(completionCount / denominator);
      const replayRate = this.clampValue(replayCount / denominator);
      const skipRate = this.clampValue(skipCount / denominator);

      result[reelId] = {
        impressionCount,
        completionCount,
        replayCount,
        skipCount,
        averagePercentageWatched,
        completionRate,
        replayRate,
        skipRate,
        trendingScore: this.clampValue(
          completionRate * 0.45 +
            replayRate * 0.3 +
            this.clampValue(averagePercentageWatched / 100) * 0.25 -
            skipRate * 0.35,
        ),
      };
    }

    return result;
  }

  private positiveSignalWeight(event: {
    eventType: string;
    percentageWatched: number | null;
    completed: boolean;
    replayed: boolean;
    skipped: boolean;
  }): number {
    if (event.skipped) return 0;
    if (event.replayed || event.eventType === 'REPLAY') return 1.6;
    if (event.completed || event.eventType === 'COMPLETE') return 1.3;
    if ((event.percentageWatched ?? 0) >= 90) return 1.1;
    if ((event.percentageWatched ?? 0) >= 70) return 0.8;
    return event.eventType === 'WATCH_END' ? 0.5 : 0;
  }

  private sessionSignalWeight(event: {
    eventType: string;
    percentageWatched: number | null;
    completed: boolean;
    replayed: boolean;
    skipped: boolean;
  }): number {
    if (event.skipped || event.eventType === 'SKIP') return -1.2;
    if (event.replayed || event.eventType === 'REPLAY') return 1.5;
    if (event.completed || event.eventType === 'COMPLETE') return 1.2;
    if ((event.percentageWatched ?? 0) >= 80) return 0.8;
    if ((event.percentageWatched ?? 0) >= 50) return 0.35;
    return 0;
  }

  private normalizePositiveMap(
    values: Map<string, number>,
  ): Record<string, number> {
    const maximum = Math.max(1, ...values.values());
    return Object.fromEntries(
      [...values.entries()].map(([key, value]) => [
        key,
        this.clampValue(value / maximum),
      ]),
    );
  }

  private normalizeIntentMap(
    values: Map<string, number>,
  ): Record<string, number> {
    const maximum = Math.max(
      1,
      ...[...values.values()].map((value) => Math.abs(value)),
    );
    return Object.fromEntries(
      [...values.entries()].map(([key, value]) => [
        key,
        Math.min(Math.max(value / maximum, -1), 1),
      ]),
    );
  }

  private normalizeSignalTag(rawTag: string): string {
    return rawTag.normalize('NFKC').trim().replace(/^#+/, '').toLowerCase();
  }

  private emptyRankingSnapshot(): RecommendationRankingSnapshot {
    return {
      tagAffinityByTag: {},
      creatorAffinityByCreatorId: {},
      sessionTagIntentByTag: {},
      sessionCreatorIntentByCreatorId: {},
      recentCreatorImpressionsByCreatorId: {},
      recentTagImpressionsByTag: {},
      recentlySeenReelIds: [],
      engagementByReelId: {},
    };
  }

  private clampValue(value: number): number {
    if (!Number.isFinite(value)) return 0;
    return Math.min(Math.max(value, 0), 1);
  }

  private toFiniteNumber(value: number | bigint): number {
    const numberValue = Number(value);
    return Number.isFinite(numberValue) ? numberValue : 0;
  }
}
