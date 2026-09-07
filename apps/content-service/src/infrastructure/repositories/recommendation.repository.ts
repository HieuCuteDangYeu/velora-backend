import type { Reel } from '@content/domain/entities/reel.entity';
import type { ReelMediaEdit } from '@common/content/schemas/reel-edit.schema';
import type {
  RecommendationCandidateEvidence,
  RecommendationCandidateQuery,
  RecommendationRankingRequest,
  RecommendationRankingSnapshot,
  RecommendationReelEngagement,
} from '@content/domain/interfaces/recommendation.interface';
import type { IRecommendationRepository } from '@content/domain/interfaces/recommendation.repository.interface';
import { mapReelLegacyStatus } from '@content/domain/reel-status-compatibility.mapper';
import { PrismaService } from '@content/infrastructure/prisma/prisma.service';
import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/content-client';

const REEL_SELECT = {
  id: true,
  userId: true,
  mediaKey: true,
  title: true,
  description: true,
  tags: true,
  status: true,
  mediaStatus: true,
  indexStatus: true,
  visibility: true,
  viewCount: true,
  thumbnailKey: true,
  processingStage: true,
  processingMessage: true,
  processingProgress: true,
  processingAttemptId: true,
  processingStartedAt: true,
  processingFailedAt: true,
  processingCompletedAt: true,
  processingErrorCode: true,
  processingErrorDetail: true,
  mediaAttemptId: true,
  indexAttemptId: true,
  mediaEdit: true,
  outputDurationMs: true,
  sourceDurationMs: true,
  sourceWidth: true,
  sourceHeight: true,
  sourceFps: true,
  sourceBitrateKbps: true,
  sourceHasAudio: true,
  sourceRotation: true,
  sourceOrientation: true,
  sourceLengthClass: true,
  sourceAspectRatio: true,
  sourceEffectiveWidth: true,
  sourceEffectiveHeight: true,
  encodedVariantCount: true,
  encodedMaxHeight: true,
  encodedFps: true,
  createdAt: true,
  updatedAt: true,
} as const satisfies Prisma.ReelSelect;

type ReelRecord = Prisma.ReelGetPayload<{
  select: typeof REEL_SELECT;
}>;

interface PositiveProfile {
  tagWeights: Map<string, number>;
  rawTagByNormalizedTag: Map<string, string>;
  creatorWeights: Map<string, number>;
}

@Injectable()
export class RecommendationRepository implements IRecommendationRepository {
  constructor(private readonly prisma: PrismaService) {}

  async findRecentQualityCandidates(
    query: RecommendationCandidateQuery,
  ): Promise<RecommendationCandidateEvidence[]> {
    const records = await this.prisma.reel.findMany({
      where: {
        AND: [
          this.baseReelWhere(query),
          {
            createdAt: {
              gte: new Date(Date.now() - 14 * 24 * 60 * 60 * 1000),
            },
          },
          {
            OR: [
              {
                encodedVariantCount: {
                  gte: 1,
                },
              },
              {
                thumbnailKey: {
                  not: null,
                },
              },
            ],
          },
        ],
      },
      orderBy: [{ createdAt: 'desc' }, { viewCount: 'desc' }, { id: 'asc' }],
      take: query.limit,
      select: REEL_SELECT,
    });

    return records.map((record) => ({
      reelId: record.id,
      source: 'RECENT_QUALITY',
      sourceScore: this.clamp(
        this.freshnessScore(record.createdAt) * 0.6 +
          this.mediaQualityScore(record) * 0.3 +
          this.popularityScore(record.viewCount) * 0.1,
      ),
      reasons: ['recent completed public reel'],
    }));
  }

  async findTrendingCandidates(
    query: RecommendationCandidateQuery,
  ): Promise<RecommendationCandidateEvidence[]> {
    const events = await this.prisma.reelViewEvent.findMany({
      where: {
        occurredAt: {
          gte: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000),
        },
        OR: [
          {
            eventType: {
              in: [
                'IMPRESSION',
                'WATCH_START',
                'WATCH_PROGRESS',
                'WATCH_END',
                'SKIP',
                'COMPLETE',
                'REPLAY',
              ],
            },
          },
          { completed: true },
          { replayed: true },
          { skipped: true },
        ],
      },
      orderBy: {
        occurredAt: 'desc',
      },
      take: 10_000,
      select: {
        reelId: true,
        eventType: true,
        watchMs: true,
        percentageWatched: true,
        completed: true,
        replayed: true,
        skipped: true,
      },
    });

    const scoreByReelId = new Map<string, number>();

    for (const event of events) {
      scoreByReelId.set(
        event.reelId,
        (scoreByReelId.get(event.reelId) ?? 0) +
          this.trendingEventWeight(event),
      );
    }

    const rankedIds = [...scoreByReelId.entries()]
      .filter(([, score]) => score > 0)
      .sort((left, right) => right[1] - left[1])
      .slice(0, query.limit * 3)
      .map(([reelId]) => reelId);

    if (rankedIds.length === 0) {
      return [];
    }

    const records = await this.prisma.reel.findMany({
      where: {
        AND: [
          this.baseReelWhere(query),
          {
            id: {
              in: rankedIds,
            },
          },
        ],
      },
      select: {
        id: true,
      },
    });

    const maxScore = Math.max(
      1,
      ...records.map((record) => scoreByReelId.get(record.id) ?? 0),
    );

    return records
      .map((record) => ({
        reelId: record.id,
        source: 'TRENDING' as const,
        sourceScore: this.clamp((scoreByReelId.get(record.id) ?? 0) / maxScore),
        reasons: ['strong recent watch and completion signals'],
      }))
      .sort((left, right) => right.sourceScore - left.sourceScore)
      .slice(0, query.limit);
  }

  async findTagAffinityCandidates(
    query: RecommendationCandidateQuery,
  ): Promise<RecommendationCandidateEvidence[]> {
    const profile = await this.loadPositiveProfile(query.viewerId, 60);

    const topTags = this.topWeightedKeys(profile.tagWeights, 12);

    const queryTags = topTags
      .map((tag) => profile.rawTagByNormalizedTag.get(tag))
      .filter((tag): tag is string => Boolean(tag));

    if (queryTags.length === 0) {
      return [];
    }

    const records = await this.prisma.reel.findMany({
      where: {
        AND: [
          this.baseReelWhere(query),
          {
            tags: {
              hasSome: queryTags,
            },
          },
        ],
      },
      orderBy: [{ createdAt: 'desc' }, { viewCount: 'desc' }, { id: 'asc' }],
      take: query.limit * 2,
      select: {
        id: true,
        tags: true,
      },
    });

    const maximum = Math.max(
      1,
      ...topTags.map((tag) => profile.tagWeights.get(tag) ?? 0),
    );

    return records
      .map((record) => {
        const matchingTags = record.tags
          .map((tag) => this.normalizeTag(tag))
          .filter((tag) => profile.tagWeights.has(tag));

        const score = matchingTags.reduce(
          (sum, tag) => sum + (profile.tagWeights.get(tag) ?? 0),
          0,
        );

        return {
          reelId: record.id,
          source: 'TAG_AFFINITY' as const,
          sourceScore: this.clamp(
            score / (maximum * Math.max(1, matchingTags.length)),
          ),
          reasons: ['matches positively watched tags'],
        };
      })
      .sort((left, right) => right.sourceScore - left.sourceScore)
      .slice(0, query.limit);
  }

  async findViewerInterestTags(
    viewerId: string,
    limit: number,
  ): Promise<string[]> {
    const profile = await this.loadPositiveProfile(viewerId, 60);

    return this.topWeightedKeys(profile.tagWeights, limit)
      .map((tag) => profile.rawTagByNormalizedTag.get(tag))
      .filter((tag): tag is string => Boolean(tag));
  }

  async findCreatorAffinityCandidates(
    query: RecommendationCandidateQuery,
  ): Promise<RecommendationCandidateEvidence[]> {
    const profile = await this.loadPositiveProfile(query.viewerId, 60);

    const creatorIds = this.topWeightedKeys(profile.creatorWeights, 20);

    if (creatorIds.length === 0) {
      return [];
    }

    const records = await this.prisma.reel.findMany({
      where: {
        AND: [
          this.baseReelWhere(query),
          {
            userId: {
              in: creatorIds,
            },
          },
        ],
      },
      orderBy: [{ createdAt: 'desc' }, { viewCount: 'desc' }, { id: 'asc' }],
      take: query.limit * 2,
      select: {
        id: true,
        userId: true,
      },
    });

    const maximum = Math.max(
      1,
      ...creatorIds.map(
        (creatorId) => profile.creatorWeights.get(creatorId) ?? 0,
      ),
    );

    return records
      .map((record) => ({
        reelId: record.id,
        source: 'CREATOR_AFFINITY' as const,
        sourceScore: this.clamp(
          (profile.creatorWeights.get(record.userId) ?? 0) / maximum,
        ),
        reasons: ['creator previously produced positively watched reels'],
      }))
      .sort((left, right) => right.sourceScore - left.sourceScore)
      .slice(0, query.limit);
  }

  async findContentSimilarityCandidates(
    query: RecommendationCandidateQuery,
  ): Promise<RecommendationCandidateEvidence[]> {
    const seedEvents = await this.prisma.reelViewEvent.findMany({
      where: {
        userId: query.viewerId,
        occurredAt: {
          gte: new Date(Date.now() - 45 * 24 * 60 * 60 * 1000),
        },
        OR: [
          {
            eventType: {
              in: ['COMPLETE', 'REPLAY'],
            },
          },
          { completed: true },
          { replayed: true },
          {
            percentageWatched: {
              gte: 80,
            },
          },
        ],
      },
      orderBy: {
        occurredAt: 'desc',
      },
      take: 40,
      select: {
        reel: {
          select: {
            id: true,
            tags: true,
          },
        },
      },
    });

    const seedReelIds = new Set<string>();
    const tagWeights = new Map<string, number>();
    const rawTagByNormalizedTag = new Map<string, string>();

    for (let index = 0; index < seedEvents.length; index += 1) {
      const reel = seedEvents[index].reel;

      if (!reel) {
        continue;
      }

      seedReelIds.add(reel.id);
      const weight = 1 / (1 + index / 8);

      for (const rawTag of reel.tags) {
        const tag = this.normalizeTag(rawTag);

        if (!tag) {
          continue;
        }

        rawTagByNormalizedTag.set(tag, rawTag);
        tagWeights.set(tag, (tagWeights.get(tag) ?? 0) + weight);
      }
    }

    const topTags = this.topWeightedKeys(tagWeights, 15);
    const queryTags = topTags
      .map((tag) => rawTagByNormalizedTag.get(tag))
      .filter((tag): tag is string => Boolean(tag));

    if (queryTags.length === 0) {
      return [];
    }

    const records = await this.prisma.reel.findMany({
      where: {
        AND: [
          this.baseReelWhere(query),
          {
            id: {
              notIn: [...seedReelIds],
            },
          },
          {
            tags: {
              hasSome: queryTags,
            },
          },
        ],
      },
      orderBy: [{ createdAt: 'desc' }, { viewCount: 'desc' }, { id: 'asc' }],
      take: query.limit * 2,
      select: {
        id: true,
        tags: true,
      },
    });

    const maximum = Math.max(
      1,
      ...topTags.map((tag) => tagWeights.get(tag) ?? 0),
    );

    return records
      .map((record) => {
        const matchingTags = record.tags
          .map((tag) => this.normalizeTag(tag))
          .filter((tag) => tagWeights.has(tag));

        const score = matchingTags.reduce(
          (sum, tag) => sum + (tagWeights.get(tag) ?? 0),
          0,
        );

        return {
          reelId: record.id,
          source: 'CONTENT_SIMILARITY' as const,
          sourceScore: this.clamp(
            score / (maximum * Math.max(1, matchingTags.length)),
          ),
          reasons: ['metadata similarity to completed or replayed reels'],
        };
      })
      .sort((left, right) => right.sourceScore - left.sourceScore)
      .slice(0, query.limit);
  }

  async findSocialCandidates(
    query: RecommendationCandidateQuery,
  ): Promise<RecommendationCandidateEvidence[]> {
    const excluded = new Set(query.excludedUserIds);
    const friendUserIds = [
      ...new Set(
        query.friendUserIds.filter(
          (friendUserId) => !excluded.has(friendUserId),
        ),
      ),
    ];

    if (friendUserIds.length === 0) {
      return [];
    }

    const records = await this.prisma.reel.findMany({
      where: {
        AND: [
          this.baseReelWhere(query),
          {
            userId: {
              in: friendUserIds,
            },
          },
        ],
      },
      orderBy: [{ createdAt: 'desc' }, { viewCount: 'desc' }, { id: 'asc' }],
      take: query.limit,
      select: {
        id: true,
        createdAt: true,
        viewCount: true,
      },
    });

    return records.map((record) => ({
      reelId: record.id,
      source: 'SOCIAL',
      sourceScore: this.clamp(
        this.freshnessScore(record.createdAt) * 0.65 +
          this.popularityScore(record.viewCount) * 0.35,
      ),
      reasons: ['public reel from an accepted friend'],
    }));
  }

  async findExplorationCandidates(
    query: RecommendationCandidateQuery,
  ): Promise<RecommendationCandidateEvidence[]> {
    const profile = await this.loadPositiveProfile(query.viewerId, 90);

    const knownCreatorIds = this.topWeightedKeys(profile.creatorWeights, 100);

    const records = await this.prisma.reel.findMany({
      where: {
        AND: [
          this.baseReelWhere(query),
          ...(knownCreatorIds.length > 0
            ? [
                {
                  userId: {
                    notIn: knownCreatorIds,
                  },
                } satisfies Prisma.ReelWhereInput,
              ]
            : []),
        ],
      },
      orderBy: [{ createdAt: 'desc' }, { id: 'asc' }],
      take: query.limit * 5,
      select: {
        id: true,
        createdAt: true,
        encodedVariantCount: true,
        thumbnailKey: true,
        sourceDurationMs: true,
        encodedMaxHeight: true,
        encodedFps: true,
        sourceHasAudio: true,
      },
    });

    return records
      .map((record) => ({
        reelId: record.id,
        source: 'EXPLORATION' as const,
        sourceScore: this.clamp(
          this.stableNoise(record.id, query.viewerId) * 0.55 +
            this.freshnessScore(record.createdAt) * 0.3 +
            this.mediaQualityScore(record) * 0.15,
        ),
        reasons: ['controlled exploration from an unfamiliar creator'],
      }))
      .sort((left, right) => right.sourceScore - left.sourceScore)
      .slice(0, query.limit);
  }

  async findEligibleReelsByIds(
    reelIds: string[],
    excludedUserIds: string[],
  ): Promise<Reel[]> {
    if (reelIds.length === 0) {
      return [];
    }

    const records = await this.prisma.reel.findMany({
      where: {
        id: {
          in: reelIds,
        },
        mediaStatus: 'COMPLETED',
        visibility: 'public',
        ...(excludedUserIds.length > 0
          ? {
              userId: {
                notIn: excludedUserIds,
              },
            }
          : {}),
      },
      select: REEL_SELECT,
    });

    return records.map((record) => this.toDomain(record));
  }

  async findRecentlySeenReelIds(
    viewerId: string,
    since: Date,
  ): Promise<Set<string>> {
    const events = await this.prisma.reelViewEvent.findMany({
      where: {
        userId: viewerId,
        occurredAt: {
          gte: since,
        },
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
      select: {
        reelId: true,
      },
    });

    return new Set(events.map((event) => event.reelId));
  }

  async loadRankingSnapshot(
    request: RecommendationRankingRequest,
  ): Promise<RecommendationRankingSnapshot> {
    if (request.reelIds.length === 0) {
      return this.emptySnapshot();
    }

    const now = Date.now();
    const longTermSince = new Date(now - 60 * 24 * 60 * 60 * 1000);
    const engagementSince = new Date(now - 7 * 24 * 60 * 60 * 1000);
    const fatigueSince = new Date(now - 3 * 24 * 60 * 60 * 1000);

    const [
      positiveEvents,
      sessionEvents,
      engagementEvents,
      fatigueEvents,
      recentlySeenEvents,
    ] = await Promise.all([
      this.prisma.reelViewEvent.findMany({
        where: {
          userId: request.viewerId,
          occurredAt: {
            gte: longTermSince,
          },
          OR: [
            {
              eventType: {
                in: ['WATCH_END', 'COMPLETE', 'REPLAY'],
              },
            },
            { completed: true },
            { replayed: true },
            {
              percentageWatched: {
                gte: 70,
              },
            },
          ],
        },
        orderBy: {
          occurredAt: 'desc',
        },
        take: 1_000,
        select: {
          eventType: true,
          percentageWatched: true,
          completed: true,
          replayed: true,
          skipped: true,
          reel: {
            select: {
              userId: true,
              tags: true,
            },
          },
        },
      }),

      this.prisma.reelViewEvent.findMany({
        where: {
          userId: request.viewerId,
          feedSessionId: request.feedSessionId,
        },
        orderBy: {
          occurredAt: 'asc',
        },
        take: 1_000,
        select: {
          eventType: true,
          percentageWatched: true,
          completed: true,
          replayed: true,
          skipped: true,
          reel: {
            select: {
              userId: true,
              tags: true,
            },
          },
        },
      }),

      this.prisma.reelViewEvent.findMany({
        where: {
          reelId: {
            in: request.reelIds,
          },
          occurredAt: {
            gte: engagementSince,
          },
        },
        take: 20_000,
        select: {
          reelId: true,
          eventType: true,
          percentageWatched: true,
          completed: true,
          replayed: true,
          skipped: true,
        },
      }),

      this.prisma.reelViewEvent.findMany({
        where: {
          userId: request.viewerId,
          occurredAt: {
            gte: fatigueSince,
          },
          eventType: {
            in: ['IMPRESSION', 'WATCH_START'],
          },
        },
        orderBy: {
          occurredAt: 'desc',
        },
        take: 1_000,
        select: {
          reel: {
            select: {
              userId: true,
              tags: true,
            },
          },
        },
      }),

      this.prisma.reelViewEvent.findMany({
        where: {
          userId: request.viewerId,
          reelId: {
            in: request.reelIds,
          },
          occurredAt: {
            gte: fatigueSince,
          },
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
        select: {
          reelId: true,
        },
      }),
    ]);

    const tagAffinity = new Map<string, number>();
    const creatorAffinity = new Map<string, number>();

    for (const event of positiveEvents) {
      const reel = event.reel;

      if (!reel) {
        continue;
      }

      const weight = this.positiveEventWeight(event);

      if (weight <= 0) {
        continue;
      }

      creatorAffinity.set(
        reel.userId,
        (creatorAffinity.get(reel.userId) ?? 0) + weight,
      );

      for (const rawTag of reel.tags) {
        const tag = this.normalizeTag(rawTag);

        if (tag) {
          tagAffinity.set(tag, (tagAffinity.get(tag) ?? 0) + weight);
        }
      }
    }

    const sessionTagIntent = new Map<string, number>();
    const sessionCreatorIntent = new Map<string, number>();

    for (const event of sessionEvents) {
      const reel = event.reel;

      if (!reel) {
        continue;
      }

      const weight = this.sessionEventWeight(event);

      if (weight === 0) {
        continue;
      }

      sessionCreatorIntent.set(
        reel.userId,
        (sessionCreatorIntent.get(reel.userId) ?? 0) + weight,
      );

      for (const rawTag of reel.tags) {
        const tag = this.normalizeTag(rawTag);

        if (tag) {
          sessionTagIntent.set(tag, (sessionTagIntent.get(tag) ?? 0) + weight);
        }
      }
    }

    const creatorImpressions = new Map<string, number>();
    const tagImpressions = new Map<string, number>();

    for (const event of fatigueEvents) {
      const reel = event.reel;

      if (!reel) {
        continue;
      }

      creatorImpressions.set(
        reel.userId,
        (creatorImpressions.get(reel.userId) ?? 0) + 1,
      );

      for (const rawTag of reel.tags) {
        const tag = this.normalizeTag(rawTag);

        if (tag) {
          tagImpressions.set(tag, (tagImpressions.get(tag) ?? 0) + 1);
        }
      }
    }

    return {
      tagAffinityByTag: this.normalizeMap(tagAffinity),
      creatorAffinityByCreatorId: this.normalizeMap(creatorAffinity),
      sessionTagIntentByTag: this.normalizeSignedMap(sessionTagIntent),
      sessionCreatorIntentByCreatorId:
        this.normalizeSignedMap(sessionCreatorIntent),
      recentCreatorImpressionsByCreatorId:
        Object.fromEntries(creatorImpressions),
      recentTagImpressionsByTag: Object.fromEntries(tagImpressions),
      recentlySeenReelIds: recentlySeenEvents.map((event) => event.reelId),
      engagementByReelId: this.buildEngagementByReelId(
        request.reelIds,
        engagementEvents,
      ),
    };
  }

  private buildEngagementByReelId(
    reelIds: string[],
    events: Array<{
      reelId: string;
      eventType: string;
      percentageWatched: number | null;
      completed: boolean;
      replayed: boolean;
      skipped: boolean;
    }>,
  ): Record<string, RecommendationReelEngagement> {
    const mutable = new Map<
      string,
      {
        impressionCount: number;
        completionCount: number;
        replayCount: number;
        skipCount: number;
        watchedPercentageTotal: number;
        watchedPercentageCount: number;
      }
    >();

    for (const reelId of reelIds) {
      mutable.set(reelId, {
        impressionCount: 0,
        completionCount: 0,
        replayCount: 0,
        skipCount: 0,
        watchedPercentageTotal: 0,
        watchedPercentageCount: 0,
      });
    }

    for (const event of events) {
      const current = mutable.get(event.reelId);

      if (!current) {
        continue;
      }

      if (
        event.eventType === 'IMPRESSION' ||
        event.eventType === 'WATCH_START'
      ) {
        current.impressionCount += 1;
      }

      if (event.eventType === 'COMPLETE' || event.completed) {
        current.completionCount += 1;
      }

      if (event.eventType === 'REPLAY' || event.replayed) {
        current.replayCount += 1;
      }

      if (event.eventType === 'SKIP' || event.skipped) {
        current.skipCount += 1;
      }

      if (event.percentageWatched !== null) {
        current.watchedPercentageTotal += event.percentageWatched;
        current.watchedPercentageCount += 1;
      }
    }

    const result: Record<string, RecommendationReelEngagement> = {};

    for (const [reelId, current] of mutable) {
      const denominator = Math.max(1, current.impressionCount);

      const completionRate = this.clamp(current.completionCount / denominator);

      const replayRate = this.clamp(current.replayCount / denominator);

      const skipRate = this.clamp(current.skipCount / denominator);

      const averagePercentageWatched =
        current.watchedPercentageCount > 0
          ? current.watchedPercentageTotal / current.watchedPercentageCount
          : 0;

      result[reelId] = {
        impressionCount: current.impressionCount,
        completionCount: current.completionCount,
        replayCount: current.replayCount,
        skipCount: current.skipCount,
        averagePercentageWatched,
        completionRate,
        replayRate,
        skipRate,
        trendingScore: this.clamp(
          completionRate * 0.45 +
            replayRate * 0.3 +
            this.clamp(averagePercentageWatched / 100) * 0.25 -
            skipRate * 0.35,
        ),
      };
    }

    return result;
  }

  private baseReelWhere(
    query: RecommendationCandidateQuery,
  ): Prisma.ReelWhereInput {
    return {
      mediaStatus: 'COMPLETED',
      visibility: 'public',
      ...(query.excludedUserIds.length > 0
        ? {
            userId: {
              notIn: query.excludedUserIds,
            },
          }
        : {}),
      ...(query.cursor
        ? {
            OR: [
              {
                createdAt: {
                  lt: query.cursor.createdAt,
                },
              },
              {
                createdAt: query.cursor.createdAt,
                id: {
                  gt: query.cursor.id,
                },
              },
            ],
          }
        : {}),
    };
  }

  private async loadPositiveProfile(
    viewerId: string,
    days: number,
  ): Promise<PositiveProfile> {
    const events = await this.prisma.reelViewEvent.findMany({
      where: {
        userId: viewerId,
        occurredAt: {
          gte: new Date(Date.now() - days * 24 * 60 * 60 * 1000),
        },
        OR: [
          {
            eventType: {
              in: ['WATCH_END', 'COMPLETE', 'REPLAY'],
            },
          },
          { completed: true },
          { replayed: true },
          {
            percentageWatched: {
              gte: 70,
            },
          },
        ],
      },
      orderBy: {
        occurredAt: 'desc',
      },
      take: 600,
      select: {
        eventType: true,
        percentageWatched: true,
        completed: true,
        replayed: true,
        skipped: true,
        reel: {
          select: {
            userId: true,
            tags: true,
          },
        },
      },
    });

    const tagWeights = new Map<string, number>();
    const rawTagByNormalizedTag = new Map<string, string>();
    const creatorWeights = new Map<string, number>();

    for (const event of events) {
      const reel = event.reel;

      if (!reel) {
        continue;
      }

      const weight = this.positiveEventWeight(event);

      if (weight <= 0) {
        continue;
      }

      creatorWeights.set(
        reel.userId,
        (creatorWeights.get(reel.userId) ?? 0) + weight,
      );

      for (const rawTag of reel.tags) {
        const tag = this.normalizeTag(rawTag);

        if (!tag) {
          continue;
        }

        rawTagByNormalizedTag.set(tag, rawTag);
        tagWeights.set(tag, (tagWeights.get(tag) ?? 0) + weight);
      }
    }

    return {
      tagWeights,
      rawTagByNormalizedTag,
      creatorWeights,
    };
  }

  private positiveEventWeight(event: {
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

  private sessionEventWeight(event: {
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

  private trendingEventWeight(event: {
    eventType: string;
    watchMs: number;
    percentageWatched: number | null;
    completed: boolean;
    replayed: boolean;
    skipped: boolean;
  }): number {
    let score = 0;

    switch (event.eventType) {
      case 'IMPRESSION':
        score += 0.03;
        break;
      case 'WATCH_START':
        score += 0.08;
        break;
      case 'WATCH_PROGRESS':
        score += Math.min((event.percentageWatched ?? 0) / 250, 0.4);
        break;
      case 'WATCH_END':
        score += Math.min((event.percentageWatched ?? 0) / 100, 1);
        break;
      case 'COMPLETE':
        score += 1.5;
        break;
      case 'REPLAY':
        score += 2;
        break;
      case 'SKIP':
        score -= 1.1;
        break;
      default:
        break;
    }

    if (event.completed) score += 1;
    if (event.replayed) score += 1.2;
    if (event.skipped) score -= 0.8;

    score += Math.min(event.watchMs / 120_000, 0.5);

    return score;
  }

  private normalizeMap(values: Map<string, number>): Record<string, number> {
    const maximum = Math.max(1, ...values.values());

    return Object.fromEntries(
      [...values.entries()].map(([key, value]) => [
        key,
        this.clamp(value / maximum),
      ]),
    );
  }

  private normalizeSignedMap(
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

  private emptySnapshot(): RecommendationRankingSnapshot {
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

  private topWeightedKeys(
    values: Map<string, number>,
    limit: number,
  ): string[] {
    return [...values.entries()]
      .sort((left, right) => right[1] - left[1])
      .slice(0, limit)
      .map(([key]) => key);
  }

  private normalizeTag(rawTag: string): string {
    return rawTag.normalize('NFKC').trim().replace(/^#+/, '').toLowerCase();
  }

  private stableNoise(reelId: string, viewerId: string): number {
    const value = `${viewerId}:${reelId}`;
    let hash = 2166136261;

    for (let index = 0; index < value.length; index += 1) {
      hash ^= value.charCodeAt(index);
      hash = Math.imul(hash, 16777619);
    }

    return (hash >>> 0) / 4_294_967_295;
  }

  private freshnessScore(createdAt: Date): number {
    const ageHours = Math.max(
      0,
      (Date.now() - createdAt.getTime()) / (60 * 60 * 1000),
    );

    return this.clamp(1 / (1 + ageHours / 72));
  }

  private popularityScore(viewCount: bigint): number {
    return this.clamp(Math.log(Number(viewCount ?? 0) + 1) / Math.log(5_000));
  }

  private mediaQualityScore(record: {
    encodedVariantCount: number | null;
    thumbnailKey: string | null;
    sourceDurationMs: number | null;
    encodedMaxHeight: number | null;
    encodedFps: number | null;
    sourceHasAudio: boolean | null;
  }): number {
    let score = 0;

    if ((record.encodedVariantCount ?? 0) >= 1) score += 0.25;
    if ((record.encodedVariantCount ?? 0) >= 3) score += 0.1;
    if (record.thumbnailKey) score += 0.15;
    if ((record.sourceDurationMs ?? 0) >= 1_000) score += 0.1;
    if ((record.encodedMaxHeight ?? 0) >= 720) score += 0.2;
    if ((record.encodedFps ?? 0) >= 24) score += 0.1;
    if (record.sourceHasAudio === true) score += 0.1;

    return this.clamp(score);
  }

  private clamp(value: number): number {
    if (!Number.isFinite(value)) {
      return 0;
    }

    return Math.min(Math.max(value, 0), 1);
  }

  private toDomain(record: ReelRecord): Reel {
    return {
      id: record.id,
      userId: record.userId,
      mediaKey: record.mediaKey,
      title: record.title ?? undefined,
      description: record.description ?? undefined,
      tags: record.tags ?? [],
      status: mapReelLegacyStatus({
        mediaStatus: record.mediaStatus,
        indexStatus: record.indexStatus,
      }),
      mediaStatus: record.mediaStatus,
      indexStatus: record.indexStatus,
      visibility: record.visibility as Reel['visibility'],
      viewCount: record.viewCount,
      thumbnailKey: record.thumbnailKey ?? undefined,
      processingStage: record.processingStage ?? undefined,
      processingMessage: record.processingMessage ?? undefined,
      processingProgress: record.processingProgress ?? undefined,
      processingAttemptId: record.processingAttemptId ?? undefined,
      processingStartedAt: record.processingStartedAt ?? undefined,
      processingFailedAt: record.processingFailedAt ?? undefined,
      processingCompletedAt: record.processingCompletedAt ?? undefined,
      processingErrorCode: record.processingErrorCode ?? undefined,
      processingErrorDetail: record.processingErrorDetail ?? undefined,
      mediaAttemptId: record.mediaAttemptId ?? undefined,
      indexAttemptId: record.indexAttemptId ?? undefined,
      mediaEdit: (record.mediaEdit as ReelMediaEdit | null) ?? undefined,
      outputDurationMs: record.outputDurationMs ?? undefined,
      sourceDurationMs: record.sourceDurationMs ?? undefined,
      sourceWidth: record.sourceWidth ?? undefined,
      sourceHeight: record.sourceHeight ?? undefined,
      sourceFps: record.sourceFps ?? undefined,
      sourceBitrateKbps: record.sourceBitrateKbps ?? undefined,
      sourceHasAudio: record.sourceHasAudio ?? undefined,
      sourceRotation: record.sourceRotation ?? undefined,
      sourceOrientation: record.sourceOrientation ?? undefined,
      sourceLengthClass: record.sourceLengthClass ?? undefined,
      sourceAspectRatio: record.sourceAspectRatio ?? undefined,
      sourceEffectiveWidth: record.sourceEffectiveWidth ?? undefined,
      sourceEffectiveHeight: record.sourceEffectiveHeight ?? undefined,
      encodedVariantCount: record.encodedVariantCount ?? undefined,
      encodedMaxHeight: record.encodedMaxHeight ?? undefined,
      encodedFps: record.encodedFps ?? undefined,
      createdAt: record.createdAt,
      updatedAt: record.updatedAt,
    };
  }
}
