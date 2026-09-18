import { Reel } from '@content/domain/entities/reel.entity';
import type {
  FriendsReelsQuery,
  RecommendedReelsQuery,
  ReelCursor,
  ReelListQuery,
  ReelProfileContextQuery,
  ReelProfileContextResult,
  SearchSuggestion,
  SearchSuggestionsQuery,
} from '@content/domain/interfaces/content.repository.interface';
import { PrismaService } from '@content/infrastructure/prisma/prisma.service';
import { Injectable } from '@nestjs/common';
import { REEL_LIST_SELECT, toReelDomain } from './reel-record.mapper';

@Injectable()
export class ReelFeedRepository {
  constructor(private readonly prisma: PrismaService) {}

  async findSearchablePublicReels(ids: string[]): Promise<Reel[]> {
    const uniqueIds = [...new Set(ids.map((id) => id.trim()).filter(Boolean))];
    if (uniqueIds.length === 0) return [];
    const records = await this.prisma.reel.findMany({
      where: {
        id: { in: uniqueIds },
        visibility: 'public',
        mediaStatus: 'COMPLETED',
        indexStatus: 'COMPLETED',
      },
    });
    return records.map((record) => toReelDomain(record));
  }

  private normalizeRecommendationTag(tag: string): string {
    return tag.trim().toLowerCase().replace(/^#/, '');
  }

  private stableRecommendationNoise(id: string): number {
    let hash = 0;

    for (let index = 0; index < id.length; index += 1) {
      hash = (hash * 31 + id.charCodeAt(index)) >>> 0;
    }

    return (hash % 1000) / 1000;
  }

  private getReelAgeHours(createdAt: Date): number {
    return Math.max(0, (Date.now() - createdAt.getTime()) / (1000 * 60 * 60));
  }

  private isPositiveRecommendationEvent(event: {
    eventType: string;
    percentageWatched?: number | null;
    completed?: boolean | null;
    replayed?: boolean | null;
  }): boolean {
    return (
      event.eventType === 'COMPLETE' ||
      event.eventType === 'REPLAY' ||
      event.completed === true ||
      event.replayed === true ||
      (event.percentageWatched ?? 0) >= 70
    );
  }

  private isNegativeRecommendationEvent(event: {
    eventType: string;
    skipped?: boolean | null;
    percentageWatched?: number | null;
  }): boolean {
    return (
      event.eventType === 'SKIP' ||
      event.skipped === true ||
      ((event.percentageWatched ?? 100) < 15 &&
        (event.eventType === 'WATCH_END' ||
          event.eventType === 'WATCH_PROGRESS'))
    );
  }

  private normalizeSearchSuggestionText(value: string): string | null {
    const normalized = value
      .normalize('NFKC')
      .trim()
      .replace(/^#+/, '')
      .replace(/[_-]+/g, ' ')
      .replace(/[^\p{L}\p{N}#+. ]/gu, ' ')
      .replace(/\s+/g, ' ')
      .toLowerCase();

    if (normalized.length < 2 || normalized.length > 32) {
      return null;
    }

    if (/^\d+$/.test(normalized)) {
      return null;
    }

    return normalized;
  }

  private addSearchSuggestionScore(
    map: Map<
      string,
      {
        label: string;
        query: string;
        source: SearchSuggestion['source'];
        score: number;
      }
    >,
    input: {
      label: string;
      query: string;
      source: SearchSuggestion['source'];
      score: number;
    },
  ): void {
    const existing = map.get(input.query);

    if (existing) {
      existing.score += input.score;
      return;
    }

    map.set(input.query, {
      label: input.label,
      query: input.query,
      source: input.source,
      score: input.score,
    });
  }

  async getSearchSuggestions(
    query: SearchSuggestionsQuery,
  ): Promise<SearchSuggestion[]> {
    const type = query.type ?? 'all';

    if (type === 'users') {
      return [];
    }

    const limit = Math.min(Math.max(query.limit ?? 8, 1), 12);
    const candidateLimit = Math.min(Math.max(limit * 80, 300), 1000);
    const now = Date.now();

    const records = await this.prisma.reel.findMany({
      where: {
        visibility: 'public',
        mediaStatus: 'COMPLETED',
        tags: {
          isEmpty: false,
        },
      },
      orderBy: [{ createdAt: 'desc' }, { id: 'asc' }],
      take: candidateLimit,
      select: {
        id: true,
        tags: true,
        viewCount: true,
        createdAt: true,
      },
    });

    if (records.length === 0) {
      return [];
    }

    const suggestions = new Map<
      string,
      {
        label: string;
        query: string;
        source: SearchSuggestion['source'];
        score: number;
      }
    >();

    for (const record of records) {
      const ageDays = Math.max(
        0,
        (now - record.createdAt.getTime()) / (1000 * 60 * 60 * 24),
      );

      const freshnessScore = 1 / (1 + ageDays / 14);

      const viewCount =
        typeof record.viewCount === 'bigint'
          ? Number(record.viewCount)
          : Number(record.viewCount ?? 0);

      const popularityScore = Math.min(
        Math.log(viewCount + 1) / Math.log(1001),
        1,
      );

      const baseScore = 1 + freshnessScore * 0.35 + popularityScore * 0.4;

      for (const rawTag of record.tags ?? []) {
        const queryText = this.normalizeSearchSuggestionText(rawTag);

        if (!queryText) {
          continue;
        }

        const label = rawTag
          .normalize('NFKC')
          .trim()
          .replace(/^#+/, '')
          .replace(/[_-]+/g, ' ')
          .replace(/\s+/g, ' ');

        this.addSearchSuggestionScore(suggestions, {
          label: label || queryText,
          query: queryText,
          source: 'trending_reel_tag',
          score: baseScore,
        });
      }
    }

    return [...suggestions.values()]
      .sort((left, right) => {
        if (right.score !== left.score) {
          return right.score - left.score;
        }

        return left.query.localeCompare(right.query);
      })
      .slice(0, limit)
      .map((suggestion) => ({
        label: suggestion.label,
        query: suggestion.query,
        source: suggestion.source,
        score: Number(suggestion.score.toFixed(4)),
      }));
  }

  async listRecommendedReels(query: RecommendedReelsQuery): Promise<{
    items: Reel[];
    nextCursor: ReelCursor | null;
  }> {
    const viewerId = query.viewerId?.trim();

    if (!viewerId) {
      return {
        items: [],
        nextCursor: null,
      };
    }

    const limit = Math.min(Math.max(query.limit ?? 20, 1), 50);
    const candidateLimit = Math.min(Math.max(limit * 10, 80), 300);

    const excludedUserIds = [
      ...new Set(
        (query.excludedUserIds ?? []).map((id) => id.trim()).filter(Boolean),
      ),
    ];

    const where: Record<string, unknown> = {
      visibility: 'public',
      mediaStatus: 'COMPLETED',

      ...(excludedUserIds.length > 0
        ? {
            userId: {
              notIn: excludedUserIds,
            },
          }
        : {}),
    };

    if (query.cursor) {
      where['OR'] = [
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
      ];
    }

    const candidateRecords = await this.prisma.reel.findMany({
      where,
      orderBy: [{ createdAt: 'desc' }, { id: 'asc' }],
      take: candidateLimit + 1,
      select: REEL_LIST_SELECT,
    });

    const hasMore = candidateRecords.length > candidateLimit;
    const pageCandidates = candidateRecords.slice(0, candidateLimit);

    if (pageCandidates.length === 0) {
      return {
        items: [],
        nextCursor: null,
      };
    }

    const candidateIds = pageCandidates.map((record) => record.id);
    const eventSince = new Date(Date.now() - 60 * 24 * 60 * 60 * 1000);
    const recentSince = new Date(Date.now() - 24 * 60 * 60 * 1000);

    const [candidateEvents, profileEvents] = await Promise.all([
      this.prisma.reelViewEvent.findMany({
        where: {
          userId: viewerId,
          reelId: { in: candidateIds },
          occurredAt: { gte: eventSince },
        },
        select: {
          reelId: true,
          eventType: true,
          watchMs: true,
          percentageWatched: true,
          skipped: true,
          completed: true,
          replayed: true,
          occurredAt: true,
        },
      }),

      this.prisma.reelViewEvent.findMany({
        where: {
          userId: viewerId,
          occurredAt: { gte: eventSince },
          OR: [
            { eventType: { in: ['COMPLETE', 'REPLAY', 'WATCH_END'] } },
            { completed: true },
            { replayed: true },
            { percentageWatched: { gte: 70 } },
          ],
        },
        orderBy: { occurredAt: 'desc' },
        take: 500,
        select: {
          eventType: true,
          percentageWatched: true,
          skipped: true,
          completed: true,
          replayed: true,
          reel: {
            select: {
              userId: true,
              tags: true,
            },
          },
        },
      }),
    ]);

    const statsByReel = new Map<
      string,
      {
        impressionCount: number;
        skipCount: number;
        completeCount: number;
        replayCount: number;
        totalWatchMs: number;
        maxPercentageWatched: number;
        latestSeenAt: number;
        recentlySeen: boolean;
      }
    >();

    for (const event of candidateEvents) {
      const current = statsByReel.get(event.reelId) ?? {
        impressionCount: 0,
        skipCount: 0,
        completeCount: 0,
        replayCount: 0,
        totalWatchMs: 0,
        maxPercentageWatched: 0,
        latestSeenAt: 0,
        recentlySeen: false,
      };

      if (
        event.eventType === 'IMPRESSION' ||
        event.eventType === 'WATCH_START'
      ) {
        current.impressionCount += 1;
      }

      if (this.isNegativeRecommendationEvent(event)) {
        current.skipCount += 1;
      }

      if (event.eventType === 'COMPLETE' || event.completed === true) {
        current.completeCount += 1;
      }

      if (event.eventType === 'REPLAY' || event.replayed === true) {
        current.replayCount += 1;
      }

      current.totalWatchMs += event.watchMs ?? 0;
      current.maxPercentageWatched = Math.max(
        current.maxPercentageWatched,
        event.percentageWatched ?? 0,
      );
      current.latestSeenAt = Math.max(
        current.latestSeenAt,
        event.occurredAt.getTime(),
      );
      current.recentlySeen =
        current.recentlySeen || event.occurredAt >= recentSince;

      statsByReel.set(event.reelId, current);
    }

    const tagAffinity = new Map<string, number>();
    const creatorAffinity = new Map<string, number>();

    for (const event of profileEvents) {
      if (!this.isPositiveRecommendationEvent(event)) {
        continue;
      }

      const reel = event.reel;

      if (!reel) {
        continue;
      }

      const eventWeight =
        event.eventType === 'REPLAY' || event.replayed === true
          ? 1.5
          : event.eventType === 'COMPLETE' || event.completed === true
            ? 1.2
            : 1.0;

      creatorAffinity.set(
        reel.userId,
        (creatorAffinity.get(reel.userId) ?? 0) + eventWeight,
      );

      for (const rawTag of reel.tags ?? []) {
        const tag = this.normalizeRecommendationTag(rawTag);

        if (!tag) {
          continue;
        }

        tagAffinity.set(tag, (tagAffinity.get(tag) ?? 0) + eventWeight);
      }
    }

    const maxTagAffinity = Math.max(1, ...Array.from(tagAffinity.values()));
    const maxCreatorAffinity = Math.max(
      1,
      ...Array.from(creatorAffinity.values()),
    );

    const scored = pageCandidates
      .map((record) => {
        const reel = toReelDomain(record);
        const stats = statsByReel.get(reel.id);
        const ageHours = this.getReelAgeHours(reel.createdAt);

        const freshnessScore = 1 / (1 + ageHours / 72);

        const popularityScore = Math.min(
          Math.log(Number(reel.viewCount ?? 0) + 1) / Math.log(5000),
          1,
        );

        const tagScore = Math.min(
          1,
          (reel.tags ?? []).reduce((sum, rawTag) => {
            const tag = this.normalizeRecommendationTag(rawTag);
            return sum + (tagAffinity.get(tag) ?? 0);
          }, 0) / maxTagAffinity,
        );

        const creatorScore = Math.min(
          1,
          (creatorAffinity.get(reel.userId) ?? 0) / maxCreatorAffinity,
        );

        const replayBoost = stats?.replayCount
          ? Math.min(0.25, stats.replayCount * 0.08)
          : 0;

        const watchBoost = stats?.maxPercentageWatched
          ? Math.min(0.15, stats.maxPercentageWatched / 1000)
          : 0;

        const impressionPenalty = stats?.impressionCount
          ? Math.min(0.22, stats.impressionCount * 0.06)
          : 0;

        const skipPenalty = stats?.skipCount
          ? Math.min(0.55, stats.skipCount * 0.18)
          : 0;

        const completePenalty = stats?.completeCount
          ? Math.min(0.32, stats.completeCount * 0.12)
          : 0;

        const recentPenalty = stats?.recentlySeen ? 0.45 : 0;

        const diversityNoise = this.stableRecommendationNoise(reel.id);

        const score =
          freshnessScore * 0.3 +
          popularityScore * 0.18 +
          tagScore * 0.25 +
          creatorScore * 0.1 +
          diversityNoise * 0.07 +
          replayBoost +
          watchBoost -
          impressionPenalty -
          skipPenalty -
          completePenalty -
          recentPenalty;

        return {
          reel,
          score,
          recentlySeen: stats?.recentlySeen === true,
        };
      })
      .filter((item) => {
        if (query.excludeRecentlySeen === false) {
          return true;
        }

        return !item.recentlySeen;
      });

    const fallbackScored =
      scored.length >= limit
        ? scored
        : pageCandidates.map((record) => {
            const reel = toReelDomain(record);
            const ageHours = this.getReelAgeHours(reel.createdAt);
            const freshnessScore = 1 / (1 + ageHours / 72);
            const popularityScore = Math.min(
              Math.log(Number(reel.viewCount ?? 0) + 1) / Math.log(5000),
              1,
            );

            return {
              reel,
              score:
                freshnessScore * 0.58 +
                popularityScore * 0.32 +
                this.stableRecommendationNoise(reel.id) * 0.1,
            };
          });

    fallbackScored.sort((left, right) => {
      if (right.score !== left.score) {
        return right.score - left.score;
      }

      return right.reel.createdAt.getTime() - left.reel.createdAt.getTime();
    });

    const chronologicalLastRecord = pageCandidates[pageCandidates.length - 1];

    return {
      items: fallbackScored.slice(0, limit).map((item) => item.reel),
      nextCursor:
        hasMore && chronologicalLastRecord
          ? {
              createdAt: chronologicalLastRecord.createdAt,
              id: chronologicalLastRecord.id,
            }
          : null,
    };
  }

  async listReels(query: ReelListQuery): Promise<{
    items: Reel[];
    nextCursor: ReelCursor | null;
  }> {
    const limit = Math.min(Math.max(query.limit ?? 20, 1), 50);

    const shouldUseRankedPublicFeed =
      query.ranked === true &&
      Boolean(query.viewerId) &&
      !query.userId &&
      query.visibility === 'public' &&
      query.onlyPublished === true;

    if (shouldUseRankedPublicFeed) {
      return this.listRankedPublicReels({
        viewerId: query.viewerId!,
        limit,
        cursor: query.cursor,
      });
    }

    const where: Record<string, unknown> = {};

    if (query.visibility) {
      where['visibility'] = query.visibility;
    }

    if (query.userId) {
      where['userId'] = query.userId;
    }

    if (query.onlyPublished) {
      where['mediaStatus'] = 'COMPLETED';
    }

    if (query.cursor) {
      where['OR'] = [
        { createdAt: { lt: query.cursor.createdAt } },
        {
          createdAt: query.cursor.createdAt,
          id: { gt: query.cursor.id },
        },
      ];
    }

    const records = await this.prisma.reel.findMany({
      where,
      orderBy: [{ createdAt: 'desc' }, { id: 'asc' }],
      take: limit + 1,
      select: REEL_LIST_SELECT,
    });

    const hasMore = records.length > limit;

    const items = records
      .slice(0, limit)
      .map((r) => toReelDomain(r as unknown as Record<string, unknown>));

    const nextCursor =
      hasMore && items.length > 0
        ? {
            createdAt: items[items.length - 1].createdAt,
            id: items[items.length - 1].id,
          }
        : null;

    return { items, nextCursor };
  }

  private async listRankedPublicReels(input: {
    viewerId: string;
    limit: number;
    cursor?: ReelCursor;
  }): Promise<{
    items: Reel[];
    nextCursor: ReelCursor | null;
  }> {
    const where: Record<string, unknown> = {
      visibility: 'public',
      mediaStatus: 'COMPLETED',
    };

    if (input.cursor) {
      where['OR'] = [
        { createdAt: { lt: input.cursor.createdAt } },
        {
          createdAt: input.cursor.createdAt,
          id: { gt: input.cursor.id },
        },
      ];
    }

    const records = await this.prisma.reel.findMany({
      where,
      orderBy: [{ createdAt: 'desc' }, { id: 'asc' }],
      take: input.limit + 1,
      select: REEL_LIST_SELECT,
    });

    const hasMore = records.length > input.limit;
    const pageRecords = records.slice(0, input.limit);

    if (pageRecords.length === 0) {
      return {
        items: [],
        nextCursor: null,
      };
    }

    const reelIds = pageRecords.map((record) => record.id);
    const since = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);

    const viewerEvents = await this.prisma.reelViewEvent.findMany({
      where: {
        userId: input.viewerId,
        reelId: {
          in: reelIds,
        },
        occurredAt: {
          gte: since,
        },
      },
      select: {
        reelId: true,
        eventType: true,
        watchMs: true,
        percentageWatched: true,
        skipped: true,
        completed: true,
        replayed: true,
        occurredAt: true,
      },
    });

    const statsByReel = new Map<
      string,
      {
        impressionCount: number;
        skipCount: number;
        completeCount: number;
        replayCount: number;
        totalWatchMs: number;
        maxPercentageWatched: number;
        latestSeenAt: number;
      }
    >();

    for (const event of viewerEvents) {
      const current = statsByReel.get(event.reelId) ?? {
        impressionCount: 0,
        skipCount: 0,
        completeCount: 0,
        replayCount: 0,
        totalWatchMs: 0,
        maxPercentageWatched: 0,
        latestSeenAt: 0,
      };

      if (event.eventType === 'IMPRESSION') {
        current.impressionCount += 1;
      }

      if (event.eventType === 'SKIP' || event.skipped) {
        current.skipCount += 1;
      }

      if (event.eventType === 'COMPLETE' || event.completed) {
        current.completeCount += 1;
      }

      if (event.eventType === 'REPLAY' || event.replayed) {
        current.replayCount += 1;
      }

      current.totalWatchMs += event.watchMs ?? 0;
      current.maxPercentageWatched = Math.max(
        current.maxPercentageWatched,
        event.percentageWatched ?? 0,
      );
      current.latestSeenAt = Math.max(
        current.latestSeenAt,
        event.occurredAt.getTime(),
      );

      statsByReel.set(event.reelId, current);
    }

    const now = Date.now();

    const scored = pageRecords.map((record) => {
      const reel = toReelDomain(record);
      const stats = statsByReel.get(reel.id);

      const ageHours = Math.max(
        0,
        (now - reel.createdAt.getTime()) / (1000 * 60 * 60),
      );

      const freshnessScore = 1 / (1 + ageHours / 72);
      const popularityScore = Math.min(
        Math.log(Number(reel.viewCount ?? 0) + 1) / Math.log(1000),
        1,
      );

      const seenPenalty = stats?.impressionCount ? 0.42 : 0;
      const skipPenalty = stats?.skipCount
        ? Math.min(0.8, stats.skipCount * 0.32)
        : 0;
      const completedPenalty = stats?.completeCount ? 0.22 : 0;
      const replayBoost = stats?.replayCount
        ? Math.min(0.3, stats.replayCount * 0.12)
        : 0;

      const score =
        freshnessScore * 0.58 +
        popularityScore * 0.22 +
        replayBoost -
        seenPenalty -
        skipPenalty -
        completedPenalty;

      return {
        reel,
        score,
      };
    });

    scored.sort((left, right) => {
      if (right.score !== left.score) {
        return right.score - left.score;
      }

      return right.reel.createdAt.getTime() - left.reel.createdAt.getTime();
    });

    const chronologicalLastRecord = pageRecords[pageRecords.length - 1];

    return {
      items: scored.map((item) => item.reel),
      nextCursor:
        hasMore && chronologicalLastRecord
          ? {
              createdAt: chronologicalLastRecord.createdAt,
              id: chronologicalLastRecord.id,
            }
          : null,
    };
  }

  async getProfileReelContext(
    query: ReelProfileContextQuery,
  ): Promise<ReelProfileContextResult> {
    const scopeWhere: Record<string, unknown> = {
      userId: query.anchor.userId,
      visibility: query.anchor.visibility,
    };

    if (query.anchor.visibility === 'public') {
      scopeWhere['mediaStatus'] = 'COMPLETED';
    }

    const [beforeRecords, afterRecords] = await Promise.all([
      this.prisma.reel.findMany({
        where: {
          ...scopeWhere,
          OR: [
            { createdAt: { gt: query.anchor.createdAt } },
            {
              createdAt: query.anchor.createdAt,
              id: { lt: query.anchor.id },
            },
          ],
        },
        orderBy: [{ createdAt: 'asc' }, { id: 'desc' }],
        take: query.before + 1,
        select: REEL_LIST_SELECT,
      }),
      this.prisma.reel.findMany({
        where: {
          ...scopeWhere,
          OR: [
            { createdAt: { lt: query.anchor.createdAt } },
            {
              createdAt: query.anchor.createdAt,
              id: { gt: query.anchor.id },
            },
          ],
        },
        orderBy: [{ createdAt: 'desc' }, { id: 'asc' }],
        take: query.after + 1,
        select: REEL_LIST_SELECT,
      }),
    ]);

    const hasMoreBefore = beforeRecords.length > query.before;
    const hasMoreAfter = afterRecords.length > query.after;

    const beforeItems = beforeRecords
      .slice(0, query.before)
      .map((record) =>
        toReelDomain(record as unknown as Record<string, unknown>),
      )
      .reverse();

    const afterItems = afterRecords
      .slice(0, query.after)
      .map((record) =>
        toReelDomain(record as unknown as Record<string, unknown>),
      );

    const items = [...beforeItems, query.anchor, ...afterItems];

    return {
      items,
      selectedIndex: beforeItems.length,
      previousCursor: hasMoreBefore ? this.toCursor(items[0]) : null,
      nextCursor: hasMoreAfter ? this.toCursor(items[items.length - 1]) : null,
    };
  }

  private toCursor(reel: Pick<Reel, 'createdAt' | 'id'>): ReelCursor {
    return {
      createdAt: reel.createdAt,
      id: reel.id,
    };
  }

  async listFriendsReels(query: FriendsReelsQuery): Promise<{
    items: Reel[];
    nextCursor: ReelCursor | null;
  }> {
    const limit = Math.min(Math.max(query.limit ?? 20, 1), 50);

    const excludedSet = new Set(query.excludedUserIds ?? []);

    const eligibleFriendIds = [
      ...new Set(
        query.friendUserIds.filter(
          (friendUserId) => !excludedSet.has(friendUserId),
        ),
      ),
    ];

    if (eligibleFriendIds.length === 0) {
      return {
        items: [],
        nextCursor: null,
      };
    }

    const records = await this.prisma.reel.findMany({
      where: {
        userId: {
          in: eligibleFriendIds,
        },
        mediaStatus: 'COMPLETED',
        visibility: {
          in: ['public', 'friends'],
        },
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
      },
      orderBy: [
        {
          createdAt: 'desc',
        },
        {
          id: 'asc',
        },
      ],
      take: limit + 1,
      select: REEL_LIST_SELECT,
    });

    const hasMore = records.length > limit;

    const items = records.slice(0, limit).map((record) => toReelDomain(record));

    const lastItem = items[items.length - 1];

    return {
      items,
      nextCursor:
        hasMore && lastItem
          ? {
              createdAt: lastItem.createdAt,
              id: lastItem.id,
            }
          : null,
    };
  }
}
