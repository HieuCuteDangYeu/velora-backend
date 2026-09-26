import type { Reel } from '@content/domain/entities/reel.entity';
import type { ReelCursor } from '@content/domain/interfaces/content.repository.interface';
import type { IFriendContentAccessService } from '@content/domain/interfaces/friend-content-access.service.interface';
import type { IRecommendationConfig } from '@content/domain/interfaces/recommendation-config.interface';
import type { IRecommendationFeedCacheRepository } from '@content/domain/interfaces/recommendation-feed-cache.repository.interface';
import type {
  IRecommendationFeedSessionRepository,
  RecommendationFeedSession,
  RecommendationFeedSessionItem,
} from '@content/domain/interfaces/recommendation-feed-session.repository.interface';
import type { IRecommendationRankingConfig } from '@content/domain/interfaces/recommendation-ranking-config.interface';
import type { IRecommendationTelemetryService } from '@content/domain/interfaces/recommendation-telemetry-service.interface';
import type {
  InternalRecommendationExplanation,
  MergedRecommendationCandidate,
  RankedRecommendationItem,
  RecommendationCandidateEvidence,
  RecommendationCandidateQuery,
  RecommendationCandidateSource,
  RecommendationPipelineResult,
  RecommendationRankingSnapshot,
  RecommendationScoreComponents,
} from '@content/domain/interfaces/recommendation.interface';
import type { IRecommendationRepository } from '@content/domain/interfaces/recommendation.repository.interface';
import type { ISemanticRecommendationService } from '@content/domain/interfaces/semantic-recommendation.service.interface';
import type {
  GetRecommendedReelsInput,
  RecommendedReelsResult,
} from '@content/domain/interfaces/recommended-reels.interface';
import { Inject, Injectable, Logger } from '@nestjs/common';

interface RecommendationSessionPageItem {
  reel: Reel;
  sessionItem: RecommendationFeedSessionItem;
  rank: number;
}

interface RecommendationSessionPage {
  items: RecommendationSessionPageItem[];
  nextCursor: ReelCursor | null;
  remainingCount: number;
  entityCacheHit: boolean;
}

const PERSONALIZED_REFILL_THRESHOLD = 10;
const PERSONALIZED_REFILL_LOCK_TTL_SECONDS = 60;
const PERSONALIZED_REFILL_WAIT_MS = 10_000;
const PERSONALIZED_REFILL_POLL_MS = 100;
const REEL_ENTITY_CACHE_TTL_SECONDS = 3 * 60 * 60;

@Injectable()
export class GetRecommendedReelsUseCase {
  private readonly logger = new Logger(GetRecommendedReelsUseCase.name);

  constructor(
    @Inject('IRecommendationRepository')
    private readonly recommendationRepository: IRecommendationRepository,

    @Inject('IRecommendationFeedSessionRepository')
    private readonly feedSessionRepository: IRecommendationFeedSessionRepository,

    @Inject('IRecommendationFeedCacheRepository')
    private readonly feedCacheRepository: IRecommendationFeedCacheRepository,

    @Inject('IRecommendationRankingConfig')
    private readonly rankingConfig: IRecommendationRankingConfig,

    @Inject('IRecommendationConfig')
    private readonly recommendationConfig: IRecommendationConfig,

    @Inject('IRecommendationTelemetryService')
    private readonly recommendationTelemetryService: IRecommendationTelemetryService,

    @Inject('IFriendContentAccessService')
    private readonly friendContentAccessService: IFriendContentAccessService,

    @Inject('ISemanticRecommendationService')
    private readonly semanticRecommendationService: ISemanticRecommendationService,
  ) {}

  async execute(
    input: GetRecommendedReelsInput,
  ): Promise<RecommendedReelsResult> {
    const limit = Math.min(Math.max(input.limit ?? 20, 1), 50);
    const feedSessionId = input.feedSessionId ?? globalThis.crypto.randomUUID();
    const authenticated = this.isAuthenticatedViewer(input.viewerId);
    const viewerId = authenticated
      ? input.viewerId.trim()
      : `anonymous:${feedSessionId}`;
    const algorithmVersion = this.recommendationConfig.getAlgorithmVersion();
    const baseFeatureFlags = this.recommendationConfig.getFeatureFlags();
    const pipelineCandidateSource =
      this.recommendationConfig.getCandidateSource();
    const startedAt = Date.now();

    try {
      const requestedExcludedUserIds = this.uniqueStrings(
        input.excludedUserIds ?? [],
      );

      let session = input.feedSessionId
        ? await this.feedSessionRepository.get(feedSessionId)
        : null;
      let feedSessionCacheHit = false;
      let globalSlateCacheHit = false;
      let sourceCounts: Partial<Record<RecommendationCandidateSource, number>> =
        {};
      let page: RecommendationSessionPage;

      if (
        session &&
        session.viewerId === viewerId &&
        session.algorithmVersion === algorithmVersion
      ) {
        feedSessionCacheHit = true;
        const audienceReady =
          !authenticated || Array.isArray(session.excludedUserIds);
        const excludedUserIds = this.uniqueStrings([
          ...requestedExcludedUserIds,
          ...(session.excludedUserIds ?? []),
        ]);
        page = audienceReady
          ? await this.pageFromSession(
              session,
              input.cursor,
              limit,
              excludedUserIds,
            )
          : this.emptyPage();

        const shouldRefill =
          !audienceReady ||
          (page.nextCursor !== null &&
            page.remainingCount <= PERSONALIZED_REFILL_THRESHOLD);
        if (authenticated && shouldRefill) {
          if (
            audienceReady &&
            session.personalizedRefillComplete !== false
          ) {
            session = { ...session, personalizedRefillComplete: false };
            await this.feedSessionRepository.save(
              session,
              this.recommendationConfig.getFeedSessionTtlSeconds(),
            );
          }

          this.triggerPersonalizedRefill({
            viewerId,
            feedSessionId,
            algorithmVersion,
            excludedUserIds: requestedExcludedUserIds,
            excludeRecentlySeen: input.excludeRecentlySeen,
          });
        }
      } else {
        if (session) {
          this.logger.warn(
            `Ignoring recommendation feed session ${feedSessionId} because viewer or algorithm version does not match`,
          );
        }

        const globalSlate = await this.feedCacheRepository.getGlobalSlate();
        globalSlateCacheHit = globalSlate !== null;
        const recentFallback = globalSlate
          ? null
          : await this.buildRecentFallback({
              viewerId,
              limit,
              excludedUserIds: requestedExcludedUserIds,
            });
        const generatedAt =
          globalSlate?.generatedAt ?? new Date().toISOString();
        const sessionItems = globalSlate
          ? authenticated
            ? globalSlate.items.slice(
                0,
                Math.min(
                  globalSlate.items.length,
                  limit + PERSONALIZED_REFILL_THRESHOLD,
                ),
              )
            : globalSlate.items
          : (recentFallback?.items ?? []);

        session = {
          feedSessionId,
          viewerId,
          algorithmVersion,
          generatedAt,
          personalizedRefillComplete: !authenticated,
          items: sessionItems,
        };
        sourceCounts = this.countSessionSources(session.items);

        await this.feedSessionRepository.save(
          session,
          this.recommendationConfig.getFeedSessionTtlSeconds(),
        );

        page = recentFallback
          ? this.buildPage(
              session.items,
              new Map(recentFallback.reels.map((reel) => [reel.id, reel])),
              input.cursor,
              limit,
              false,
            )
          : await this.pageFromSession(
              session,
              input.cursor,
              limit,
              requestedExcludedUserIds,
            );

        if (recentFallback && recentFallback.reels.length > 0) {
          void this.feedCacheRepository
            .saveReels(recentFallback.reels, REEL_ENTITY_CACHE_TTL_SECONDS)
            .catch((error: unknown) => {
              this.logger.warn(
                `Unable to prime recent recommendation fallback entities: ${this.describeError(
                  error,
                )}`,
              );
            });
        }

        if (authenticated) {
          this.triggerPersonalizedRefill({
            viewerId,
            feedSessionId,
            algorithmVersion,
            excludedUserIds: requestedExcludedUserIds,
            excludeRecentlySeen: input.excludeRecentlySeen,
          });
        }
      }

      if (
        authenticated &&
        page.nextCursor === null &&
        session.personalizedRefillComplete === false
      ) {
        session = await this.awaitPersonalizedRefill({
          viewerId,
          feedSessionId,
          algorithmVersion,
          excludedUserIds: requestedExcludedUserIds,
          excludeRecentlySeen: input.excludeRecentlySeen,
        });
        page = await this.pageFromSession(
          session,
          input.cursor,
          limit,
          this.uniqueStrings([
            ...requestedExcludedUserIds,
            ...(session.excludedUserIds ?? []),
          ]),
        );
      }

      const generatedAt = session.generatedAt;
      const items = page.items.map(({ reel, sessionItem, rank }) => ({
        ...reel,
        recommendation: {
          recommendationId: globalThis.crypto.randomUUID(),
          feedSessionId,
          algorithmVersion,
          candidateSource: sessionItem.primarySource,
          candidateSources: sessionItem.sources,
          rank,
          generatedAt,
        },
      }));
      const latencyMs = Math.max(0, Date.now() - startedAt);
      const featureFlags = {
        ...baseFeatureFlags,
        feedSessionCacheHit,
        globalSlateCacheHit,
        reelEntityCacheHit: page.entityCacheHit,
      };

      this.publishTelemetry({
        eventId: globalThis.crypto.randomUUID(),
        recommendationType: 'REEL',
        algorithmVersion,
        feedSessionId,
        route: 'content.get_recommended_reels',
        candidateSource: pipelineCandidateSource,
        requestedLimit: limit,
        returnedItems: items.length,
        latencyMs,
        outcome: 'SUCCEEDED',
        featureFlags,
        occurredAt: new Date().toISOString(),
      });

      if (!feedSessionCacheHit) {
        this.publishSourceTelemetry({
          sourceCounts,
          algorithmVersion,
          feedSessionId,
          requestedLimit: limit,
          latencyMs,
          featureFlags,
          occurredAt: new Date().toISOString(),
        });
      }

      return {
        items,
        nextCursor: page.nextCursor,
        feedSessionId,
        algorithmVersion,
        generatedAt,
      };
    } catch (error) {
      const occurredAt = new Date().toISOString();

      this.publishTelemetry({
        eventId: globalThis.crypto.randomUUID(),
        recommendationType: 'REEL',
        algorithmVersion,
        feedSessionId,
        route: 'content.get_recommended_reels',
        candidateSource: pipelineCandidateSource,
        requestedLimit: limit,
        returnedItems: 0,
        latencyMs: Math.max(0, Date.now() - startedAt),
        outcome: 'FAILED',
        errorCode: this.errorCode(error),
        featureFlags: baseFeatureFlags,
        occurredAt,
      });

      throw error;
    }
  }

  private async pageFromSession(
    session: RecommendationFeedSession,
    cursor: ReelCursor | undefined,
    limit: number,
    excludedUserIds: string[],
  ): Promise<RecommendationSessionPage> {
    const startIndex = this.resolveStartIndex(session.items, cursor);
    const remaining = session.items.slice(startIndex);
    const { reels, cacheHit } = await this.loadEligibleReels(
      remaining.map((item) => item.reelId),
      excludedUserIds,
    );
    const reelById = new Map(reels.map((reel) => [reel.id, reel]));

    return this.buildPage(session.items, reelById, cursor, limit, cacheHit);
  }

  private emptyPage(): RecommendationSessionPage {
    return {
      items: [],
      nextCursor: null,
      remainingCount: 0,
      entityCacheHit: false,
    };
  }

  private async buildRecentFallback(input: {
    viewerId: string;
    limit: number;
    excludedUserIds: string[];
  }): Promise<{
    items: RecommendationFeedSessionItem[];
    reels: Reel[];
  }> {
    const candidates =
      await this.recommendationRepository.findRecentQualityCandidates({
        viewerId: input.viewerId,
        limit: Math.min(
          Math.max(input.limit + PERSONALIZED_REFILL_THRESHOLD, 20),
          this.recommendationConfig.getFeedSlateSize(),
        ),
        excludedUserIds: input.excludedUserIds,
        friendUserIds: [],
      });
    const reelIds = [
      ...new Set(candidates.map((candidate) => candidate.reelId)),
    ];
    const reels = await this.recommendationRepository.findEligibleReelsByIds(
      reelIds,
      input.excludedUserIds,
    );
    const eligibleIds = new Set(reels.map((reel) => reel.id));

    return {
      items: candidates
        .filter((candidate) => eligibleIds.has(candidate.reelId))
        .map((candidate) => ({
          reelId: candidate.reelId,
          primarySource: candidate.source,
          sources: [candidate.source],
        })),
      reels,
    };
  }

  private buildPage(
    sessionItems: RecommendationFeedSessionItem[],
    reelById: Map<string, Reel>,
    cursor: ReelCursor | undefined,
    limit: number,
    entityCacheHit: boolean,
  ): RecommendationSessionPage {
    const startIndex = this.resolveStartIndex(sessionItems, cursor);
    const items: RecommendationSessionPageItem[] = [];
    let lastSelectedIndex = -1;

    for (let index = startIndex; index < sessionItems.length; index += 1) {
      const sessionItem = sessionItems[index];
      const reel = reelById.get(sessionItem.reelId);

      if (!reel) {
        continue;
      }

      items.push({
        reel,
        sessionItem,
        rank: index + 1,
      });
      lastSelectedIndex = index;

      if (items.length >= limit) {
        break;
      }
    }

    if (items.length === 0 || lastSelectedIndex < 0) {
      return {
        items: [],
        nextCursor: null,
        remainingCount: 0,
        entityCacheHit,
      };
    }

    const remainingCount = sessionItems
      .slice(lastSelectedIndex + 1)
      .filter((item) => reelById.has(item.reelId)).length;
    const lastReel = items[items.length - 1].reel;

    return {
      items,
      nextCursor:
        remainingCount > 0
          ? {
              createdAt: lastReel.createdAt,
              id: lastReel.id,
            }
          : null,
      remainingCount,
      entityCacheHit,
    };
  }

  private resolveStartIndex(
    sessionItems: RecommendationFeedSessionItem[],
    cursor?: ReelCursor,
  ): number {
    if (!cursor) {
      return 0;
    }

    const cursorIndex = sessionItems.findIndex(
      (item) => item.reelId === cursor.id,
    );

    if (cursorIndex < 0) {
      this.logger.warn(
        `Recommendation cursor reel ${cursor.id} is not present in the current feed session; restarting from the beginning of the rebuilt slate`,
      );
      return 0;
    }

    return cursorIndex + 1;
  }

  private async loadEligibleReels(
    reelIds: string[],
    excludedUserIds: string[],
  ): Promise<{ reels: Reel[]; cacheHit: boolean }> {
    const uniqueIds = [...new Set(reelIds)];
    if (uniqueIds.length === 0) {
      return { reels: [], cacheHit: true };
    }

    const cachedReels = await this.feedCacheRepository.getReels(uniqueIds);
    const cachedById = new Map(cachedReels.map((reel) => [reel.id, reel]));
    const missingIds = uniqueIds.filter((id) => !cachedById.has(id));
    const fetchedReels =
      missingIds.length > 0
        ? await this.recommendationRepository.findEligibleReelsByIds(
            missingIds,
            excludedUserIds,
          )
        : [];

    if (fetchedReels.length > 0) {
      await this.feedCacheRepository.saveReels(
        fetchedReels,
        REEL_ENTITY_CACHE_TTL_SECONDS,
      );
    }

    const excluded = new Set(excludedUserIds);
    return {
      reels: [...cachedReels, ...fetchedReels].filter(
        (reel) =>
          reel.mediaStatus === 'COMPLETED' &&
          reel.visibility === 'public' &&
          !excluded.has(reel.userId),
      ),
      cacheHit: missingIds.length === 0,
    };
  }

  private triggerPersonalizedRefill(input: {
    viewerId: string;
    feedSessionId: string;
    algorithmVersion: string;
    excludedUserIds: string[];
    excludeRecentlySeen?: boolean;
  }): void {
    void this.refillPersonalizedSession(input).catch((error: unknown) => {
      this.logger.warn(
        `Recommendation session refill failed for ${input.feedSessionId}: ${this.describeError(error)}`,
      );
    });
  }

  private async refillPersonalizedSession(input: {
    viewerId: string;
    feedSessionId: string;
    algorithmVersion: string;
    excludedUserIds: string[];
    excludeRecentlySeen?: boolean;
  }): Promise<boolean> {
    const lockToken = await this.feedSessionRepository.tryAcquireRefillLock(
      input.feedSessionId,
      PERSONALIZED_REFILL_LOCK_TTL_SECONDS,
    );
    if (!lockToken) return false;

    try {
      await this.buildAndAppendPersonalizedItems(input);
      return true;
    } finally {
      await this.feedSessionRepository.releaseRefillLock(
        input.feedSessionId,
        lockToken,
      );
    }
  }

  private async awaitPersonalizedRefill(input: {
    viewerId: string;
    feedSessionId: string;
    algorithmVersion: string;
    excludedUserIds: string[];
    excludeRecentlySeen?: boolean;
  }): Promise<RecommendationFeedSession> {
    const deadline = Date.now() + PERSONALIZED_REFILL_WAIT_MS;

    while (Date.now() < deadline) {
      const session = await this.feedSessionRepository.get(input.feedSessionId);
      if (
        !session ||
        session.viewerId !== input.viewerId ||
        session.algorithmVersion !== input.algorithmVersion
      ) {
        throw new Error(
          `Recommendation feed session ${input.feedSessionId} expired during refill`,
        );
      }
      if (session.personalizedRefillComplete === true) return session;

      const started = await this.refillPersonalizedSession(input);
      if (started) {
        const completed = await this.feedSessionRepository.get(
          input.feedSessionId,
        );
        if (completed?.personalizedRefillComplete === true) return completed;
        throw new Error(
          `Recommendation refill ${input.feedSessionId} completed without saving its session`,
        );
      }

      await new Promise<void>((resolve) =>
        setTimeout(resolve, PERSONALIZED_REFILL_POLL_MS),
      );
    }

    throw new Error(
      `Timed out waiting for recommendation refill ${input.feedSessionId}`,
    );
  }

  private async buildAndAppendPersonalizedItems(
    input: {
      viewerId: string;
      feedSessionId: string;
      algorithmVersion: string;
      excludedUserIds: string[];
      excludeRecentlySeen?: boolean;
    },
  ): Promise<void> {
    const startedAt = Date.now();
    const audience = await this.friendContentAccessService.getFeedAudience(
      input.viewerId,
    );
    const latest = await this.feedSessionRepository.get(input.feedSessionId);

    if (
      !latest ||
      latest.viewerId !== input.viewerId ||
      latest.algorithmVersion !== input.algorithmVersion
    ) {
      return;
    }

    const excludedUserIds = this.uniqueStrings([
      ...audience.excludedUserIds,
      ...input.excludedUserIds,
    ]);
    const audienceSession = {
      ...latest,
      excludedUserIds,
      personalizedRefillComplete: false,
    };
    await this.feedSessionRepository.save(
      audienceSession,
      this.recommendationConfig.getFeedSessionTtlSeconds(),
    );

    const pipeline = await this.buildPipeline({
      viewerId: input.viewerId,
      limit: this.recommendationConfig.getFeedSlateSize(),
      excludedUserIds,
      excludedReelIds: audienceSession.items.map((item) => item.reelId),
      friendUserIds: audience.friendUserIds,
      excludeRecentlySeen: input.excludeRecentlySeen,
      feedSessionId: input.feedSessionId,
    });

    const existingIds = new Set(
      audienceSession.items.map((item) => item.reelId),
    );
    const appended = pipeline.items
      .filter((item) => !existingIds.has(item.reel.id))
      .map((item) => ({
        reelId: item.reel.id,
        primarySource: item.candidate.primarySource,
        sources: item.candidate.sources,
      }));

    const refilledSession: RecommendationFeedSession = {
      ...audienceSession,
      items: [...audienceSession.items, ...appended],
      personalizedRefillComplete: true,
    };

    await this.feedCacheRepository.saveReels(
      pipeline.items.map((item) => item.reel),
      REEL_ENTITY_CACHE_TTL_SECONDS,
    );
    await this.feedSessionRepository.save(
      refilledSession,
      this.recommendationConfig.getFeedSessionTtlSeconds(),
    );

    this.publishSourceTelemetry({
      sourceCounts: pipeline.sourceCounts,
      algorithmVersion: input.algorithmVersion,
      feedSessionId: input.feedSessionId,
      requestedLimit: this.recommendationConfig.getFeedSlateSize(),
      latencyMs: Math.max(0, Date.now() - startedAt),
      featureFlags: {
        ...this.recommendationConfig.getFeatureFlags(),
        backgroundPersonalizedRefill: true,
      },
      occurredAt: new Date().toISOString(),
    });
  }

  private countSessionSources(
    items: RecommendationFeedSessionItem[],
  ): Partial<Record<RecommendationCandidateSource, number>> {
    const counts: Partial<Record<RecommendationCandidateSource, number>> = {};

    for (const item of items) {
      for (const source of item.sources) {
        counts[source] = (counts[source] ?? 0) + 1;
      }
    }

    return counts;
  }

  private isAuthenticatedViewer(viewerId: string | undefined): boolean {
    const normalized = viewerId?.trim().toLowerCase();
    return (
      !!normalized &&
      normalized !== 'anonymous' &&
      !normalized.startsWith('anonymous:')
    );
  }

  private async buildPipeline(input: {
    viewerId: string;
    limit: number;
    excludedUserIds: string[];
    excludedReelIds: string[];
    friendUserIds: string[];
    excludeRecentlySeen?: boolean;
    feedSessionId: string;
  }): Promise<RecommendationPipelineResult> {
    const candidateLimit = Math.min(Math.max(input.limit * 6, 60), 300);
    const candidateQuery: RecommendationCandidateQuery = {
      viewerId: input.viewerId,
      limit: candidateLimit,
      excludedUserIds: input.excludedUserIds,
      excludedReelIds: input.excludedReelIds,
      friendUserIds: input.friendUserIds,
    };
    const featureFlags = this.recommendationConfig.getFeatureFlags();
    const sourceOperations: Array<{
      source: RecommendationCandidateSource;
      execute: () => Promise<RecommendationCandidateEvidence[]>;
      enabled: boolean;
    }> = [
      {
        source: 'RECENT_QUALITY',
        execute: () =>
          this.recommendationRepository.findRecentQualityCandidates(
            candidateQuery,
          ),
        enabled: featureFlags['recentQualityPool'] !== false,
      },
      {
        source: 'TRENDING',
        execute: () =>
          this.recommendationRepository.findTrendingCandidates(candidateQuery),
        enabled: featureFlags['trendingPool'] !== false,
      },
      {
        source: 'TAG_AFFINITY',
        execute: () =>
          this.recommendationRepository.findTagAffinityCandidates(
            candidateQuery,
          ),
        enabled: featureFlags['tagAffinityPool'] !== false,
      },
      {
        source: 'CREATOR_AFFINITY',
        execute: () =>
          this.recommendationRepository.findCreatorAffinityCandidates(
            candidateQuery,
          ),
        enabled: featureFlags['creatorAffinityPool'] !== false,
      },
      {
        source: 'CONTENT_SIMILARITY',
        execute: () =>
          this.recommendationRepository.findContentSimilarityCandidates(
            candidateQuery,
          ),
        enabled: featureFlags['metadataSimilarityPool'] !== false,
      },
      {
        source: 'SEMANTIC',
        execute: async () => {
          const interestTags =
            await this.recommendationRepository.findViewerInterestTags(
              candidateQuery.viewerId,
              20,
            );

          return await this.semanticRecommendationService.findCandidates({
            viewerId: candidateQuery.viewerId,
            interestTags,
            limit: Math.min(candidateQuery.limit, 100),
          });
        },
        enabled: featureFlags['semanticPool'] !== false,
      },
      {
        source: 'SOCIAL',
        execute: () =>
          this.recommendationRepository.findSocialCandidates(candidateQuery),
        enabled: featureFlags['socialPool'] !== false,
      },
      {
        source: 'EXPLORATION',
        execute: () =>
          this.recommendationRepository.findExplorationCandidates(
            candidateQuery,
          ),
        enabled: featureFlags['explorationPool'] !== false,
      },
    ];
    const enabledOperations = sourceOperations.filter(
      (operation) => operation.enabled,
    );
    const excludedReelIds = new Set(input.excludedReelIds);
    const settled = await Promise.allSettled(
      enabledOperations.map(async (operation) => ({
        source: operation.source,
        candidates: await operation.execute(),
      })),
    );
    const allCandidates: RecommendationCandidateEvidence[] = [];
    const sourceCounts: Partial<Record<RecommendationCandidateSource, number>> =
      {};

    for (let index = 0; index < settled.length; index += 1) {
      const result = settled[index];
      const operation = enabledOperations[index];

      if (result.status === 'rejected') {
        sourceCounts[operation.source] = 0;
        this.logger.warn(
          `Candidate source ${operation.source} failed: ${this.describeError(
            result.reason,
          )}`,
        );
        continue;
      }

      const candidates = result.value.candidates.filter(
        (candidate) => !excludedReelIds.has(candidate.reelId),
      );
      sourceCounts[result.value.source] = candidates.length;
      allCandidates.push(...candidates);
    }

    const mergedCandidates = this.mergeCandidates(allCandidates);
    const recentlySeenReelIds =
      input.excludeRecentlySeen === false
        ? new Set<string>()
        : await this.recommendationRepository.findRecentlySeenReelIds(
            input.viewerId,
            new Date(Date.now() - 24 * 60 * 60 * 1000),
          );
    const unseenCandidates = mergedCandidates.filter(
      (candidate) => !recentlySeenReelIds.has(candidate.reelId),
    );
    const seenFallbackCandidates = mergedCandidates.filter((candidate) =>
      recentlySeenReelIds.has(candidate.reelId),
    );
    const eligibleCandidates =
      input.excludeRecentlySeen === false
        ? mergedCandidates
        : [...unseenCandidates, ...seenFallbackCandidates];
    const eligibleReels =
      await this.recommendationRepository.findEligibleReelsByIds(
        eligibleCandidates.map((candidate) => candidate.reelId),
        input.excludedUserIds,
      );
    const reelById = new Map(eligibleReels.map((reel) => [reel.id, reel]));
    const candidatesWithReels = eligibleCandidates
      .map((candidate) => {
        const reel = reelById.get(candidate.reelId);

        return reel ? { candidate, reel } : null;
      })
      .filter(
        (
          item,
        ): item is {
          candidate: MergedRecommendationCandidate;
          reel: Reel;
        } => item !== null,
      );
    const snapshot = await this.recommendationRepository.loadRankingSnapshot({
      viewerId: input.viewerId,
      reelIds: candidatesWithReels.map((item) => item.reel.id),
      feedSessionId: input.feedSessionId,
    });
    const rankedItems = candidatesWithReels
      .map(({ candidate, reel }) =>
        this.rankCandidate(reel, candidate, snapshot),
      )
      .sort((left, right) => {
        if (right.score !== left.score) {
          return right.score - left.score;
        }

        const createdAtDifference =
          right.reel.createdAt.getTime() - left.reel.createdAt.getTime();

        if (createdAtDifference !== 0) {
          return createdAtDifference;
        }

        return left.reel.id.localeCompare(right.reel.id);
      });
    const rankedUnseenItems = rankedItems.filter(
      (item) => !recentlySeenReelIds.has(item.reel.id),
    );
    const rankedSeenFallbackItems = rankedItems.filter((item) =>
      recentlySeenReelIds.has(item.reel.id),
    );
    const diversifiedUnseenItems = this.diversify(
      rankedUnseenItems,
      input.limit,
    );
    const remainingCapacity = input.limit - diversifiedUnseenItems.length;
    const diversifiedSeenFallbackItems =
      remainingCapacity > 0
        ? this.diversify(rankedSeenFallbackItems, remainingCapacity)
        : [];
    const diversifiedItems = [
      ...diversifiedUnseenItems,
      ...diversifiedSeenFallbackItems,
    ];

    return {
      items: diversifiedItems,
      nextCursor: null,
      rawCandidateCount: allCandidates.length,
      deduplicatedCandidateCount: mergedCandidates.length,
      sourceCounts,
    };
  }

  private mergeCandidates(
    candidates: RecommendationCandidateEvidence[],
  ): MergedRecommendationCandidate[] {
    const byReelId = new Map<
      string,
      {
        sourceScores: Partial<Record<RecommendationCandidateSource, number>>;
        reasons: Set<string>;
      }
    >();

    for (const candidate of candidates) {
      const existing = byReelId.get(candidate.reelId) ?? {
        sourceScores: {},
        reasons: new Set<string>(),
      };
      const sourceScore = this.clamp(candidate.sourceScore);
      existing.sourceScores[candidate.source] = Math.max(
        existing.sourceScores[candidate.source] ?? 0,
        sourceScore,
      );

      for (const reason of candidate.reasons) {
        const normalized = reason.trim();

        if (normalized) {
          existing.reasons.add(normalized.slice(0, 160));
        }
      }

      byReelId.set(candidate.reelId, existing);
    }

    return [...byReelId.entries()]
      .map(([reelId, value]) => {
        const sourceEntries = Object.entries(value.sourceScores) as Array<
          [RecommendationCandidateSource, number]
        >;
        sourceEntries.sort((left, right) => right[1] - left[1]);
        const sources = sourceEntries.map(([source]) => source);
        const primarySource = sources[0] ?? 'EXPLORATION';
        const strongestEvidence = sourceEntries[0]?.[1] ?? 0;
        const supportingEvidence = sourceEntries
          .slice(1)
          .reduce((sum, [, score]) => sum + this.clamp(score), 0);
        const multiSourceBoost = Math.min(0.12, supportingEvidence * 0.04);

        return {
          reelId,
          primarySource,
          sources,
          sourceScores: value.sourceScores,
          reasons: [...value.reasons].slice(0, 12),
          candidateScore: this.clamp(strongestEvidence + multiSourceBoost),
        };
      })
      .sort((left, right) => {
        if (right.candidateScore !== left.candidateScore) {
          return right.candidateScore - left.candidateScore;
        }

        return left.reelId.localeCompare(right.reelId);
      });
  }

  private rankCandidate(
    reel: Reel,
    candidate: MergedRecommendationCandidate,
    snapshot: RecommendationRankingSnapshot,
  ): RankedRecommendationItem {
    const weights = this.rankingConfig.getWeights();
    const fatigue = this.rankingConfig.getFatigueConfig();
    const normalizedTags = this.normalizeTags(reel.tags);
    const dominantTopic = this.selectDominantTopic(normalizedTags, snapshot);
    const tagAffinityScore = this.averageScore(
      normalizedTags.map((tag) => snapshot.tagAffinityByTag[tag] ?? 0),
    );
    const creatorAffinityScore = this.clamp(
      snapshot.creatorAffinityByCreatorId[reel.userId] ?? 0,
    );
    const sessionTagScore = this.averageSignedScore(
      normalizedTags.map((tag) => snapshot.sessionTagIntentByTag[tag] ?? 0),
    );
    const sessionCreatorScore = this.clampSigned(
      snapshot.sessionCreatorIntentByCreatorId[reel.userId] ?? 0,
    );
    const sessionIntentScore = this.clampSigned(
      sessionTagScore * 0.7 + sessionCreatorScore * 0.3,
    );
    const engagement = snapshot.engagementByReelId[reel.id] ?? {
      impressionCount: 0,
      completionCount: 0,
      replayCount: 0,
      skipCount: 0,
      averagePercentageWatched: 0,
      completionRate: 0,
      replayRate: 0,
      skipRate: 0,
      trendingScore: 0,
    };
    const recentlySeen = snapshot.recentlySeenReelIds.includes(reel.id);
    const creatorImpressions =
      snapshot.recentCreatorImpressionsByCreatorId[reel.userId] ?? 0;
    const topicImpressions = dominantTopic
      ? (snapshot.recentTagImpressionsByTag[dominantTopic] ?? 0)
      : 0;
    const scoreComponents: RecommendationScoreComponents = {
      candidateScore: candidate.candidateScore,
      tagAffinityScore,
      creatorAffinityScore,
      contentSimilarityScore: this.clamp(
        Math.max(
          candidate.sourceScores.CONTENT_SIMILARITY ?? 0,
          candidate.sourceScores.SEMANTIC ?? 0,
        ),
      ),
      trendingScore: Math.max(
        this.clamp(candidate.sourceScores.TRENDING ?? 0),
        engagement.trendingScore,
      ),
      freshnessScore: this.freshnessScore(reel.createdAt),
      qualityScore: this.qualityScore(reel),
      completionRate: engagement.completionRate,
      replayRate: engagement.replayRate,
      sessionIntentScore,
      skipRate: engagement.skipRate,
      recentlySeenPenalty: recentlySeen ? fatigue.recentlySeenPenalty : 0,
      creatorFatiguePenalty:
        creatorImpressions >= fatigue.creatorThreshold
          ? Math.min(
              fatigue.creatorMaximum,
              (creatorImpressions - fatigue.creatorThreshold + 1) *
                fatigue.creatorStep,
            )
          : 0,
      topicFatiguePenalty:
        topicImpressions >= fatigue.topicThreshold
          ? Math.min(
              fatigue.topicMaximum,
              (topicImpressions - fatigue.topicThreshold + 1) *
                fatigue.topicStep,
            )
          : 0,
    };
    const positiveScore =
      scoreComponents.candidateScore * weights.candidateScore +
      scoreComponents.tagAffinityScore * weights.tagAffinity +
      scoreComponents.creatorAffinityScore * weights.creatorAffinity +
      scoreComponents.contentSimilarityScore * weights.contentSimilarity +
      scoreComponents.trendingScore * weights.trending +
      scoreComponents.freshnessScore * weights.freshness +
      scoreComponents.qualityScore * weights.quality +
      scoreComponents.completionRate * weights.completionRate +
      scoreComponents.replayRate * weights.replayRate +
      scoreComponents.sessionIntentScore * weights.sessionIntent;
    const negativeScore =
      scoreComponents.skipRate * weights.skipRate +
      scoreComponents.recentlySeenPenalty +
      scoreComponents.creatorFatiguePenalty +
      scoreComponents.topicFatiguePenalty;
    const rawScore = positiveScore - negativeScore;
    const explanation = this.buildExplanation(scoreComponents, rawScore);

    return {
      reel,
      candidate,
      dominantTopic,
      scoreComponents,
      explanation,
      score: rawScore,
    };
  }

  private diversify(
    rankedItems: RankedRecommendationItem[],
    limit: number,
  ): RankedRecommendationItem[] {
    const config = this.rankingConfig.getDiversityConfig();
    const selected: RankedRecommendationItem[] = [];
    const deferred: RankedRecommendationItem[] = [];
    const remaining = [...rankedItems];
    const explorationTarget = Math.min(
      limit,
      Math.max(0, Math.round(limit * config.explorationRatio)),
    );

    while (remaining.length > 0 && selected.length < limit) {
      const needExploration =
        selected.filter((item) =>
          item.candidate.sources.includes('EXPLORATION'),
        ).length < explorationTarget;
      let selectedIndex = -1;

      for (let index = 0; index < remaining.length; index += 1) {
        const item = remaining[index];

        if (
          needExploration &&
          !item.candidate.sources.includes('EXPLORATION')
        ) {
          continue;
        }

        if (this.passesDiversityConstraints(item, selected, config)) {
          selectedIndex = index;
          break;
        }
      }

      if (selectedIndex < 0 && needExploration) {
        selectedIndex = remaining.findIndex((item) =>
          item.candidate.sources.includes('EXPLORATION'),
        );
      }

      if (selectedIndex < 0) {
        selectedIndex = remaining.findIndex((item) =>
          this.passesDiversityConstraints(item, selected, config),
        );
      }

      if (selectedIndex < 0) {
        deferred.push(...remaining);
        break;
      }

      const [item] = remaining.splice(selectedIndex, 1);
      item.explanation.diversityAdjustments.push(
        'selected after creator/topic/source diversity checks',
      );
      selected.push(item);
    }

    const fallback = [...deferred, ...remaining];

    for (const item of fallback) {
      if (selected.length >= limit) {
        break;
      }

      item.explanation.diversityAdjustments.push(
        'deferred item used to fill remaining feed capacity',
      );
      selected.push(item);
    }

    return selected;
  }

  private passesDiversityConstraints(
    item: RankedRecommendationItem,
    selected: RankedRecommendationItem[],
    config: ReturnType<IRecommendationRankingConfig['getDiversityConfig']>,
  ): boolean {
    const consecutiveCreatorItems = selected
      .slice(-config.maxConsecutiveCreator)
      .filter((selectedItem) => selectedItem.reel.userId === item.reel.userId);

    if (consecutiveCreatorItems.length >= config.maxConsecutiveCreator) {
      return false;
    }

    if (item.dominantTopic) {
      const topicWindow = selected.slice(-config.topicWindowSize);
      const topicCount = topicWindow.filter(
        (selectedItem) => selectedItem.dominantTopic === item.dominantTopic,
      ).length;

      if (topicCount >= config.maxTopicPerWindow) {
        return false;
      }
    }

    const sourceWindow = selected.slice(-config.sourceWindowSize);
    const sourceCount = sourceWindow.filter(
      (selectedItem) =>
        selectedItem.candidate.primarySource === item.candidate.primarySource,
    ).length;

    if (sourceCount >= config.maxSourcePerWindow) {
      return false;
    }

    const nearDuplicateWindow = selected.slice(-config.nearDuplicateLookback);

    for (const selectedItem of nearDuplicateWindow) {
      const similarity = this.nearDuplicateSimilarity(
        selectedItem.reel,
        item.reel,
      );

      if (similarity >= config.nearDuplicateJaccardThreshold) {
        return false;
      }
    }

    return true;
  }

  private nearDuplicateSimilarity(left: Reel, right: Reel): number {
    const leftTitle = this.normalizeText(left.title ?? '');
    const rightTitle = this.normalizeText(right.title ?? '');

    if (
      leftTitle.length >= 8 &&
      rightTitle.length >= 8 &&
      leftTitle === rightTitle
    ) {
      return 1;
    }

    const tagSimilarity = this.jaccardSimilarity(
      this.normalizeTags(left.tags),
      this.normalizeTags(right.tags),
    );
    const metadataSimilarity = this.jaccardSimilarity(
      this.metadataTokens(left),
      this.metadataTokens(right),
    );

    return Math.max(tagSimilarity, metadataSimilarity);
  }

  private metadataTokens(reel: Reel): string[] {
    const text = [reel.title ?? '', reel.description ?? '', ...reel.tags].join(
      ' ',
    );

    return this.uniqueStrings(
      this.normalizeText(text)
        .split(/\s+/u)
        .filter((token) => token.length >= 3)
        .slice(0, 80),
    );
  }

  private normalizeText(value: string): string {
    return value
      .normalize('NFKC')
      .toLowerCase()
      .replace(/[^\p{L}\p{N}]+/gu, ' ')
      .trim();
  }

  private buildExplanation(
    components: RecommendationScoreComponents,
    rawScore: number,
  ): InternalRecommendationExplanation {
    const positives: Array<[string, number]> = [
      ['candidate evidence', components.candidateScore],
      ['tag affinity', components.tagAffinityScore],
      ['creator affinity', components.creatorAffinityScore],
      ['content similarity', components.contentSimilarityScore],
      ['trending engagement', components.trendingScore],
      ['freshness', components.freshnessScore],
      ['media quality', components.qualityScore],
      ['completion rate', components.completionRate],
      ['replay rate', components.replayRate],
      ['current-session intent', components.sessionIntentScore],
    ];
    const penalties: Array<[string, number]> = [
      ['skip-rate penalty', components.skipRate],
      ['recently-seen penalty', components.recentlySeenPenalty],
      ['creator-fatigue penalty', components.creatorFatiguePenalty],
      ['topic-fatigue penalty', components.topicFatiguePenalty],
    ];

    return {
      strongestPositiveSignals: positives
        .filter(([, value]) => value > 0)
        .sort((left, right) => right[1] - left[1])
        .slice(0, 3)
        .map(([name]) => name),
      appliedPenalties: penalties
        .filter(([, value]) => value > 0)
        .sort((left, right) => right[1] - left[1])
        .map(([name]) => name),
      diversityAdjustments: [],
      rawScore,
      finalScore: rawScore,
    };
  }

  private selectDominantTopic(
    tags: string[],
    snapshot: RecommendationRankingSnapshot,
  ): string | null {
    if (tags.length === 0) {
      return null;
    }

    return [...tags].sort((left, right) => {
      const leftScore =
        (snapshot.tagAffinityByTag[left] ?? 0) +
        (snapshot.sessionTagIntentByTag[left] ?? 0);
      const rightScore =
        (snapshot.tagAffinityByTag[right] ?? 0) +
        (snapshot.sessionTagIntentByTag[right] ?? 0);

      if (rightScore !== leftScore) {
        return rightScore - leftScore;
      }

      return left.localeCompare(right);
    })[0];
  }

  private freshnessScore(createdAt: Date): number {
    const ageHours = Math.max(
      0,
      (Date.now() - createdAt.getTime()) / (60 * 60 * 1000),
    );

    return this.clamp(1 / (1 + ageHours / 96));
  }

  private qualityScore(reel: Reel): number {
    let score = 0;

    if ((reel.encodedVariantCount ?? 0) >= 1) score += 0.25;
    if ((reel.encodedVariantCount ?? 0) >= 3) score += 0.1;
    if (reel.thumbnailKey) score += 0.15;
    if ((reel.sourceDurationMs ?? 0) >= 1_000) score += 0.1;
    if ((reel.encodedMaxHeight ?? 0) >= 720) score += 0.2;
    if ((reel.encodedFps ?? 0) >= 24) score += 0.1;
    if (reel.sourceHasAudio === true) score += 0.1;

    return this.clamp(score);
  }

  private averageScore(values: number[]): number {
    if (values.length === 0) {
      return 0;
    }

    return this.clamp(
      values.reduce((sum, value) => sum + this.clamp(value), 0) / values.length,
    );
  }

  private averageSignedScore(values: number[]): number {
    if (values.length === 0) {
      return 0;
    }

    return this.clampSigned(
      values.reduce((sum, value) => sum + this.clampSigned(value), 0) /
        values.length,
    );
  }

  private normalizeTags(tags: string[]): string[] {
    return this.uniqueStrings(
      tags.map((tag) =>
        tag.normalize('NFKC').trim().replace(/^#+/, '').toLowerCase(),
      ),
    );
  }

  private jaccardSimilarity(
    leftValues: string[],
    rightValues: string[],
  ): number {
    if (leftValues.length === 0 || rightValues.length === 0) {
      return 0;
    }

    const left = new Set(leftValues);
    const right = new Set(rightValues);
    const intersection = [...left].filter((value) => right.has(value)).length;
    const union = new Set([...left, ...right]).size;

    return union > 0 ? intersection / union : 0;
  }

  private publishSourceTelemetry(input: {
    sourceCounts: Partial<Record<RecommendationCandidateSource, number>>;
    algorithmVersion: string;
    feedSessionId: string;
    requestedLimit: number;
    latencyMs: number;
    featureFlags: Record<string, boolean>;
    occurredAt: string;
  }): void {
    for (const [source, count] of Object.entries(input.sourceCounts)) {
      this.publishTelemetry({
        eventId: globalThis.crypto.randomUUID(),
        recommendationType: 'REEL',
        algorithmVersion: input.algorithmVersion,
        feedSessionId: input.feedSessionId,
        route: 'content.get_recommended_reels.candidate_source',
        candidateSource: source,
        requestedLimit: input.requestedLimit,
        returnedItems: count ?? 0,
        latencyMs: input.latencyMs,
        outcome: 'SUCCEEDED',
        featureFlags: input.featureFlags,
        occurredAt: input.occurredAt,
      });
    }
  }

  private publishTelemetry(
    event: Parameters<IRecommendationTelemetryService['publish']>[0],
  ): void {
    if (this.recommendationConfig.isTelemetryEnabled()) {
      this.recommendationTelemetryService.publish(event);
    }
  }

  private uniqueStrings(values: string[]): string[] {
    return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
  }

  private clamp(value: number): number {
    if (!Number.isFinite(value)) {
      return 0;
    }

    return Math.min(Math.max(value, 0), 1);
  }

  private clampSigned(value: number): number {
    if (!Number.isFinite(value)) {
      return 0;
    }

    return Math.min(Math.max(value, -1), 1);
  }

  private describeError(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
  }

  private errorCode(error: unknown): string {
    if (error instanceof Error && error.name.trim()) {
      return error.name.slice(0, 100);
    }

    return 'UNKNOWN_ERROR';
  }
}
